import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { SummaryJob } from "./type.ts"
import type { JobQueue } from "./tracker.ts"
import { summaryLogger, type SummaryLogger } from "./logger.ts"

const summaryUpdateToolPath = fileURLToPath(new URL("./tools/summary-update-tool.ts", import.meta.url))
const FORCE_KILL_DELAY_MS = 5_000
const MAX_DECISION_REASON_LENGTH = 8000
const DEFAULT_SUMMARY_PROMPT = [
    "Review the frozen increment against the task goal and current summary.",
    "First determine whether the increment is directly relevant to task.goal. Only then determine whether it materially changes the task state or progress toward that goal.",
    "Ignore information unrelated to task.goal, even if it describes a technical change, blocker, next step, or finding. In that case use shouldUpdateTask false and proposedPatch {}.",
    "Update only for: material progress toward the goal, a goal-relevant technical-stack change, a goal-relevant action or blocker change, or a status or priority change of the task itself; otherwise do not update.",
    "When updating proposedPatch.summary, merge currentSummary with goal-relevant new facts. Keep prior facts that remain true; do not replace it with an increment-only summary.",
    "proposedPatch may only contain these optional keys: " +
        "status ('pending'|'todo'|'in_progress'|'blocked'|'done'), " +
        "priority ('p0'|'p1'|'p2'|'p3'), " +
        "progress (string '0'-'100'), " +
        "summary, nextAction, blocker (string or null to clear). " +
        "No other keys are accepted.",
    `Call tracker_apply_summary exactly once. Include decisionReason as one concise sentence of at most ${MAX_DECISION_REASON_LENGTH} characters. Use shouldUpdateTask false and proposedPatch {} when no persisted task change is justified.`,
    "Use the frozen sessionId, taskTitle, expectedRevision, lastSummarizedEntryId, and endEntryId values exactly as provided. Do not call any other tool.",
] as const

export interface SummaryOptions {
    summarizerProvider: string
    summarizerModel: string
    jobQueue: JobQueue
}

export class Summarizer {
    private readonly options: SummaryOptions
    private consumer: Promise<void> | undefined
    private currentChild: ChildProcess | undefined

    public constructor(options: SummaryOptions) {
        this.options = options
    }

    public start(): void {
        this.consumer = this.consume()
    }

    /**
     * Wait for the consumer to finish. If it takes longer than `timeoutMs`,
     * kill the in-flight child process, which makes the consumer exit
     * shortly after. The queue is closed here (and only here) so the
     * consumer exits naturally once the in-flight job is done.
     */
    public async stopAndWait(timeoutMs: number): Promise<void> {
        const signal = AbortSignal.timeout(timeoutMs)
        const onAbort = () => {
            summaryLogger.warn("summary_stop_timeout", { timeoutMs })
            this.cancel()
        }
        signal.addEventListener("abort", onAbort, { once: true })
        try {
            this.options.jobQueue.close()
            await this.consumer
        } finally {
            signal.removeEventListener("abort", onAbort)
        }
    }

    public cancel(): void {
        const child = this.currentChild
        if (child === undefined) {
            return
        }
        child.kill("SIGTERM")
        setTimeout(() => {
            if (this.currentChild === child) {
                child.kill("SIGKILL")
            }
        }, FORCE_KILL_DELAY_MS).unref()
    }

    private async consume(): Promise<void> {
        while (true) {
            const job = await this.options.jobQueue.dequeue()
            if (job === undefined) {
                return
            }

            const childLog = summaryLogger.child({ sessionId: job.sessionId, endEntryId: job.endEntryId })
            try {
                childLog.info("summary_job_started", { reason: job.summaryReason })
                await this.runSummaryAgent(job, childLog)
            } catch (error) {
                childLog.error("summary_job_failed", {
                    reason: job.summaryReason,
                    error: String(error),
                })
            } finally {
                this.options.jobQueue.complete(job)
            }
        }
    }

    public async runSummaryAgent(job: SummaryJob, log: SummaryLogger): Promise<void> {
        if (job.lastSummarizedEntryId === null) {
            throw new Error("Summary job has no binding watermark")
        }
        const startedAt = Date.now()
        log.info("summary_agent_spawned", {
            provider: this.options.summarizerProvider,
            model: this.options.summarizerModel,
        })
        await this.spawnAgent(buildSummaryPrompt(job), log, startedAt)
    }

    private async spawnAgent(prompt: string, log: SummaryLogger, startedAt: number): Promise<void> {
        const args = [
            "--mode",
            "json",
            "--print",
            "--no-session",
            "--no-extensions",
            "--no-builtin-tools",
            "--tools",
            "tracker_apply_summary",
            "--extension",
            summaryUpdateToolPath,
            "--provider",
            this.options.summarizerProvider,
            "--model",
            this.options.summarizerModel,
            "--",
            prompt,
        ]

        await new Promise<void>((resolve, reject) => {
            const child = spawn("pi", args, {
                env: {
                    ...process.env,
                },
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            })
            this.currentChild = child

            let output = ""
            let errorOutput = ""
            let timedOut = false
            let forceKillTimeout: NodeJS.Timeout | undefined
            const timeout = setTimeout(() => {
                timedOut = true
                child.kill("SIGTERM")
                forceKillTimeout = setTimeout(() => {
                    child.kill("SIGKILL")
                }, FORCE_KILL_DELAY_MS)
            }, 600000)

            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString()
            })
            child.stderr.on("data", (chunk: Buffer) => {
                errorOutput += chunk.toString()
            })
            child.once("error", (error) => {
                clearTimeout(timeout)
                if (forceKillTimeout !== undefined) {
                    clearTimeout(forceKillTimeout)
                }
                if (this.currentChild === child) {
                    this.currentChild = undefined
                }
                reject(error)
            })
            child.once("close", (code, signal) => {
                clearTimeout(timeout)
                if (forceKillTimeout !== undefined) {
                    clearTimeout(forceKillTimeout)
                }
                if (this.currentChild === child) {
                    this.currentChild = undefined
                }
                if (timedOut) {
                    reject(new Error("Summary agent timed out"))
                    return
                }
                if (code !== 0) {
                    reject(new Error(`Summary agent exited with ${code ?? signal}: ${errorOutput.trim()}`))
                    return
                }
                if (!hasSuccessfulUpdateToolResult(output)) {
                    reject(new Error("Summary agent exited without a successful update tool call"))
                    return
                }
                log.info("summary_agent_completed", { durationMs: Date.now() - startedAt })
                resolve()
            })
        })
    }
}

export function buildSummaryPrompt(job: SummaryJob): string {
    const prompt = DEFAULT_SUMMARY_PROMPT.join("\n")
    return [
        prompt,
        JSON.stringify(
            {
                sessionId: job.sessionId,
                taskTitle: job.taskTitle,
                goal: job.goal,
                expectedRevision: job.expectedRevision,
                lastSummarizedEntryId: job.lastSummarizedEntryId,
                endEntryId: job.endEntryId,
                currentSummary: job.currentSummary,
                entries: job.entries,
            },
            null,
            2,
        ),
    ].join("\n\n")
}

function hasSuccessfulUpdateToolResult(output: string): boolean {
    for (const line of output.split("\n")) {
        try {
            if (containsSuccessfulUpdateToolResult(JSON.parse(line))) {
                return true
            }
        } catch {
            // JSON mode output should be JSONL; unrelated malformed output is ignored.
        }
    }
    return false
}

function containsSuccessfulUpdateToolResult(value: unknown): boolean {
    if (typeof value !== "object" || value === null) {
        return false
    }
    const record = value as Record<string, unknown>
    if (record.role === "toolResult" && record.toolName === "tracker_apply_summary" && record.isError === false) {
        return true
    }
    return Object.values(record).some(containsSuccessfulUpdateToolResult)
}
