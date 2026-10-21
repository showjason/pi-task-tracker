import type { SummaryJob, SummaryReason } from "./type.ts"
import type { TaskManager } from "./sqlite.ts"
import type { Summarizer } from "./summary.ts"
import { trackerLogger, summaryLogger } from "./logger.ts"
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { gateChecker } from "./gate.ts"

type ReadonlySessionManager = ExtensionContext["sessionManager"]

export class JobQueue {
    private readonly jobs: SummaryJob[] = []
    private readonly queuedEntryIds: Set<string> = new Set()
    private readonly waitingConsumers: Array<(job: SummaryJob | undefined) => void> = []
    private closed = false

    public enqueue(job: SummaryJob): boolean {
        if (this.closed || this.queuedEntryIds.has(job.endEntryId)) {
            return false
        }
        this.queuedEntryIds.add(job.endEntryId)
        const waitingConsumer = this.waitingConsumers.shift()
        if (waitingConsumer !== undefined) {
            waitingConsumer(job)
            return true
        }
        this.jobs.push(job)
        return true
    }

    public dequeue(): Promise<SummaryJob | undefined> {
        if (this.closed) {
            return Promise.resolve(undefined)
        }
        const job = this.jobs.shift()
        if (job === undefined) {
            return new Promise<SummaryJob | undefined>((resolve) => {
                this.waitingConsumers.push(resolve)
            })
        }
        return Promise.resolve(job)
    }

    public complete(job: SummaryJob): void {
        this.queuedEntryIds.delete(job.endEntryId)
    }

    public close(): void {
        this.closed = true
        this.jobs.length = 0
        this.queuedEntryIds.clear()
        this.waitingConsumers.forEach((resolve) => resolve(undefined))
    }
}

export interface TrackerRuntimeOptions {
    taskManager: TaskManager
    jobQueue: JobQueue
    summarizer: Summarizer
    turnsThreshold: number
    initialIntervalMin: number
    maxIntervalMin: number
    useGate: boolean
}

export class Tracker {
    private readonly options: TrackerRuntimeOptions
    private turnCount: number
    private intervalMin: number
    private timer: NodeJS.Timeout | undefined
    private nextTimerAt: Date | undefined
    private sessionId: string | undefined

    constructor(options: TrackerRuntimeOptions) {
        this.options = options
        this.intervalMin = options.initialIntervalMin
        this.turnCount = 0
    }

    start(ctx: ExtensionContext): void {
        clearTimeout(this.timer) // Clear any existing timer before starting a new session
        this.sessionId = ctx.sessionManager.getSessionId()
        trackerLogger.info("session_started", { sessionId: this.sessionId })
        this.scheduleTimer(ctx.sessionManager)
        const binding = this.options.taskManager.getActiveBinding(this.sessionId)
        if (binding !== undefined && ctx.hasUI) {
            showTaskWidget(ctx, binding.taskTitle, this.sessionId!)
        }
    }

    async onAgentStart(ctx: ExtensionContext): Promise<void> {
        trackerLogger.debug("agent_turn_started", { sessionId: ctx.sessionManager.getSessionId() })
    }

    async onAgentSettled(ctx: ExtensionContext): Promise<void> {
        if (hasCompletedAssistantTurn(ctx)) {
            trackerLogger.debug("agent_turn_completed", { sessionId: ctx.sessionManager.getSessionId() })
            this.turnCount++
        }
        if (this.turnCount < this.options.turnsThreshold) return
        trackerLogger.debug("turn_threshold_reached", {
            sessionId: ctx.sessionManager.getSessionId(),
            turnCount: this.turnCount,
            threshold: this.options.turnsThreshold,
        })
        await this.enqueueSummary(ctx.sessionManager, "turn")
        this.turnCount = 0
    }

    async flush(ctx: ExtensionContext, reason: SummaryReason): Promise<void> {
        // Fast lane on quit: run the summary agent directly instead of
        // enqueueing, so the final increment is summarized immediately.
        if (reason === "quit") {
            const result = createSummaryJob(this.options.taskManager, ctx.sessionManager, reason)
            if (!result.ok) {
                summaryLogger.debug("summary_noop", {
                    sessionId: ctx.sessionManager.getSessionId(),
                    reason,
                    cause: result.cause,
                })
                this.turnCount = 0
                return
            }
            const job = result.job

            summaryLogger.info("summary_job_created", {
                sessionId: ctx.sessionManager.getSessionId(),
                reason,
                endEntryId: result.job.endEntryId,
                entryCount: result.job.entries.length,
            })

            const log = summaryLogger.child({ sessionId: job.sessionId, endEntryId: job.endEntryId })
            try {
                await this.options.summarizer.runSummaryAgent(job, log)
            } catch (error) {
                summaryLogger.error("summary_job_failed", {
                    reason: job.summaryReason,
                    error: String(error),
                })
            }
            this.turnCount = 0
            return
        }
        await this.enqueueSummary(ctx.sessionManager, reason)
        this.turnCount = 0
    }

    shutDown(): void {
        if (this.timer !== undefined) clearTimeout(this.timer)
        trackerLogger.info("session_shutdown", { sessionId: this.sessionId })
    }

    private async onTimer(session: ReadonlySessionManager): Promise<void> {
        const fireAt = new Date()
        trackerLogger.debug("summary_timer_fired", {
            sessionId: session.getSessionId(),
            scheduledFor: this.nextTimerAt?.toISOString(),
            firedAt: fireAt.toISOString(),
            intervalMin: this.intervalMin,
            delayMs: this.nextTimerAt ? fireAt.getTime() - this.nextTimerAt.getTime() : undefined,
        })
        const enqueued = await this.enqueueSummary(session, "timer")
        this.intervalMin = enqueued ? this.intervalMin : Math.min(this.intervalMin * 2, this.options.maxIntervalMin)
        this.turnCount = enqueued ? 0 : this.turnCount
        this.scheduleTimer(session)
    }

    private scheduleTimer(session: ReadonlySessionManager): void {
        this.nextTimerAt = new Date(Date.now() + this.intervalMin * 60 * 1000)
        trackerLogger.debug("summary_timer_scheduled", {
            sessionId: session.getSessionId(),
            intervalMin: this.intervalMin,
            fireAt: this.nextTimerAt.toISOString(),
        })
        this.timer = setTimeout(() => void this.onTimer(session), this.intervalMin * 60 * 1000)
    }

    private async enqueueSummary(sessionManager: ReadonlySessionManager, reason: SummaryReason): Promise<boolean> {
        const sessionId = sessionManager.getSessionId()
        const result = createSummaryJob(this.options.taskManager, sessionManager, reason)
        if (!result.ok) {
            summaryLogger.debug("summary_noop", { sessionId, reason, cause: result.cause })
            return false
        }
        const job = result.job
        summaryLogger.info("summary_job_created", {
            sessionId,
            reason,
            endEntryId: job.endEntryId,
            entryCount: result.job.entries.length,
        })

        if (!this.options.useGate || (await gate(job))) {
            const enqueued = this.options.jobQueue.enqueue(job)
            if (enqueued) {
                summaryLogger.info("summary_job_enqueued", { sessionId, endEntryId: job.endEntryId, reason })
            } else {
                summaryLogger.debug("summary_job_duplicate", { sessionId, endEntryId: job.endEntryId })
            }
            return enqueued
        } else {
            summaryLogger.info("summary_job_skipped_by_gate", { sessionId, endEntryId: job.endEntryId })
            this.options.taskManager.applySummaryAndAdvanceWatermark({
                sessionId: job.sessionId,
                title: job.taskTitle,
                expectedRevision: job.expectedRevision,
                expectedLastSummarizedEntryId: job.lastSummarizedEntryId ?? "",
                endEntryId: job.endEntryId,
                shouldUpdateTask: false,
                patch: {},
            })
            summaryLogger.info("summary_db_applied", {
                sessionId: job.sessionId,
                endEntryId: job.endEntryId,
                shouldUpdateTask: false,
            })
            return false
        }
    }
}

function hasCompletedAssistantTurn(ctx: ExtensionContext): boolean {
    const entry = ctx.sessionManager.getLeafEntry()

    return entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop"
}

/** Why createSummaryJob could not produce a job. */
type SummarySkipCause = "no_binding" | "task_deleted" | "no_increment" | "watermark_off_branch"

type SummaryJobResult = { ok: true; job: SummaryJob } | { ok: false; cause: SummarySkipCause }

function createSummaryJob(
    taskManager: TaskManager,
    session: ReadonlySessionManager,
    summaryReason: SummaryReason,
): SummaryJobResult {
    const sessid = session.getSessionId()
    const binding = taskManager.getActiveBinding(sessid)
    if (binding === undefined) {
        return { ok: false, cause: "no_binding" }
    }
    const task = taskManager.getTask(binding.taskTitle)
    if (task === undefined) {
        return { ok: false, cause: "task_deleted" }
    }

    const branch = session.getBranch()
    const summaryEntries = getSummaryEntries(branch, binding.lastSummarizedEntryId)
    const endEntryId = summaryEntries.at(-1)?.id
    if (endEntryId === undefined) {
        const watermarkOnBranch =
            binding.lastSummarizedEntryId === "" || branch.some((entry) => entry.id === binding.lastSummarizedEntryId)
        return { ok: false, cause: watermarkOnBranch ? "no_increment" : "watermark_off_branch" }
    }

    return {
        ok: true,
        job: {
            sessionId: sessid,
            taskTitle: task.title,
            goal: task.goal,
            nextAction: task.nextAction,
            blocker: task.blocker,
            expectedRevision: task.revision,
            lastSummarizedEntryId: binding.lastSummarizedEntryId,
            currentSummary: task.summary,
            entries: summaryEntries,
            summaryReason: summaryReason,
            endEntryId: endEntryId,
        },
    }
}

function getSummaryEntries(entries: SessionEntry[], lastSummarizedEntryId: string): SessionEntry[] {
    // "" is the empty-session binding sentinel: nothing has been summarized yet,
    // so the first summary covers the whole branch.
    if (lastSummarizedEntryId === "") return entries
    const index = entries.findIndex((entry) => entry.id === lastSummarizedEntryId)
    // A real watermark that is not on the current branch means the branch moved
    // (e.g. after /tree); do not enqueue from a stale range.
    return index == -1 ? [] : entries.slice(index + 1)
}

async function gate(job: SummaryJob): Promise<boolean> {
    try {
        summaryLogger.debug("gate_eval_started", { sessionId: job.sessionId, endEntryId: job.endEntryId })
        const shouldEnqueue = await gateChecker(job)
        summaryLogger.debug("gate_decision", {
            sessionId: job.sessionId,
            endEntryId: job.endEntryId,
            decision: shouldEnqueue ? "enqueue" : "skip",
        })
        return shouldEnqueue
    } catch (error) {
        summaryLogger.warn("gate_failed", {
            sessionId: job.sessionId,
            endEntryId: job.endEntryId,
            error: String(error),
        })
        return true
    }
}

export function showTaskWidget(ctx: ExtensionContext, taskTitle: string, sessionId: string): void {
    ctx.ui.setWidget("tracker-task", [`▸ task: ${taskTitle} | sessid: ${sessionId}`], { placement: "aboveEditor" })
}
