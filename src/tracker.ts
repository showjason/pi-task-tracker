import type { PreparedSummaryJob, SummaryJob, SummaryReason } from "./type.ts"
import type { TaskManager } from "./sqlite.ts"
import type { Summarizer } from "./summary.ts"
import { trackerLogger, summaryLogger } from "./logger.ts"
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { gateChecker } from "./gate.ts"

type ReadonlySessionManager = ExtensionContext["sessionManager"]
type SummarySession = Pick<ReadonlySessionManager, "getSessionId" | "getLeafId" | "getEntry">

export class JobQueue {
    private readonly jobs: SummaryJob[] = []
    private readonly queuedEntryIds: Set<string> = new Set()
    private readonly waitingConsumers: Array<(job: SummaryJob | undefined) => void> = []
    private closed = false

    public enqueue(job: SummaryJob): boolean {
        if (this.closed || (job.summaryReason !== "tree" && this.queuedEntryIds.has(job.endEntryId))) {
            return false
        }
        if (job.summaryReason !== "tree") this.queuedEntryIds.add(job.endEntryId)
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

    public complete(job: SummaryJob, success = true): void {
        if (job.summaryReason !== "tree") this.queuedEntryIds.delete(job.endEntryId)
        job.resolve?.(success)
    }

    public close(): void {
        this.closed = true
        this.jobs.forEach((job) => job.resolve?.(false))
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

    async flush(ctx: ExtensionContext, reason: SummaryReason): Promise<boolean> {
        if (reason === "quit") {
            const job = createSummaryJob(this.options.taskManager, ctx.sessionManager, reason)
            if (job === undefined) {
                this.turnCount = 0
                return true
            }
            const log = summaryLogger.child({ sessionId: job.sessionId, endEntryId: job.endEntryId })
            try {
                const preparedJob = prepareSummaryJob(this.options.taskManager, job)
                if (preparedJob !== undefined) {
                    await runPreparedJob(this.options.taskManager, this.options.summarizer, preparedJob, false, log)
                }
                return true
            } catch (error) {
                summaryLogger.error("summary_job_failed", {
                    reason,
                    error: String(error),
                })
                return false
            } finally {
                this.turnCount = 0
            }
        }
        if (reason === "tree") {
            const job = createSummaryJob(this.options.taskManager, ctx.sessionManager, reason)
            if (job === undefined) return true
            this.turnCount = 0
            return new Promise<boolean>((resolve) => {
                job.resolve = resolve
                if (!this.options.jobQueue.enqueue(job)) resolve(false)
            })
        }
        const enqueued = await this.enqueueSummary(ctx.sessionManager, reason)
        this.turnCount = 0
        return enqueued
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
        const job = createSummaryJob(this.options.taskManager, sessionManager, reason)
        if (job === undefined) return false
        summaryLogger.info("summary_job_created", {
            sessionId,
            reason,
            endEntryId: job.endEntryId,
        })
        const enqueued = this.options.jobQueue.enqueue(job)
        if (enqueued) {
            summaryLogger.info("summary_job_enqueued", { sessionId, endEntryId: job.endEntryId, reason })
        } else {
            summaryLogger.debug("summary_job_duplicate", { sessionId, endEntryId: job.endEntryId })
        }
        return enqueued
    }
}

function hasCompletedAssistantTurn(ctx: ExtensionContext): boolean {
    const entry = ctx.sessionManager.getLeafEntry()

    return entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop"
}

export function createSummaryJob(
    taskManager: TaskManager,
    session: SummarySession,
    summaryReason: SummaryReason,
): SummaryJob | undefined {
    const binding = taskManager.getActiveBinding(session.getSessionId())
    if (binding === undefined) return undefined
    return {
        sessionId: binding.sessionId,
        taskTitle: binding.taskTitle,
        summaryReason,
        endEntryId: session.getLeafId() ?? "",
        session,
    }
}

export function prepareSummaryJob(taskManager: TaskManager, job: SummaryJob): PreparedSummaryJob | undefined {
    const task = taskManager.getTask(job.taskTitle)
    if (task === undefined) throw new Error("Task not found")
    const binding = taskManager.getActiveBinding(job.sessionId)
    if (binding === undefined) throw new Error("Binding not found")

    const increment = getSummaryIncrement(job.endEntryId, binding.lastSummarizedEntryId, (id) =>
        job.session.getEntry(id),
    )
    if (increment.length === 0) return undefined

    return Object.assign(job, {
        goal: task.goal,
        nextAction: task.nextAction,
        blocker: task.blocker,
        expectedRevision: task.revision,
        lastSummarizedEntryId: binding.lastSummarizedEntryId,
        currentSummary: task.summary,
        entries: getSummaryMessages(increment),
    }) as PreparedSummaryJob
}

export function getSummaryIncrement(
    endEntryId: string,
    lastSummarizedEntryId: string,
    getEntry: (id: string) => SessionEntry | undefined,
): SessionEntry[] {
    const branch = getBranch(endEntryId, getEntry)
    if (lastSummarizedEntryId === "") return branch
    const commonAncestorId = findCommonAncestor(branch, lastSummarizedEntryId, getEntry)
    if (commonAncestorId === undefined) return branch
    return branch.slice(branch.findIndex((entry) => entry.id === commonAncestorId) + 1)
}

export function findCommonAncestor(
    branch: SessionEntry[],
    entryId: string,
    getEntry: (id: string) => SessionEntry | undefined,
): string | undefined {
    const branchIds = new Set(branch.map((entry) => entry.id))
    let currentId: string | null = entryId
    while (currentId !== null) {
        const entry = getEntry(currentId)
        if (entry === undefined) throw new Error(`Session entry not found: ${currentId}`)
        if (branchIds.has(entry.id)) return entry.id
        currentId = entry.parentId
    }
    return undefined
}

export function getSummaryMessages(entries: SessionEntry[]): SessionEntry[] {
    return entries.filter(
        (entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
    )
}

export async function runPreparedJob(
    taskManager: TaskManager,
    summarizer: Summarizer,
    job: PreparedSummaryJob,
    useGate: boolean,
    log: ReturnType<typeof summaryLogger.child>,
): Promise<void> {
    if (job.entries.length === 0 || (useGate && !(await gate(job)))) {
        advanceWatermark(taskManager, job)
        return
    }
    await summarizer.runSummaryAgent(job, log)
}

function getBranch(endEntryId: string, getEntry: (id: string) => SessionEntry | undefined): SessionEntry[] {
    if (endEntryId === "") return []
    const branch: SessionEntry[] = []
    let entry = getEntry(endEntryId)
    while (entry !== undefined) {
        branch.push(entry)
        if (entry.parentId === null) return branch.reverse()
        entry = getEntry(entry.parentId)
    }
    throw new Error(`Session entry not found: ${endEntryId}`)
}

function advanceWatermark(taskManager: TaskManager, job: PreparedSummaryJob): void {
    const applied = taskManager.applySummaryAndAdvanceWatermark({
        sessionId: job.sessionId,
        title: job.taskTitle,
        expectedRevision: job.expectedRevision,
        expectedLastSummarizedEntryId: job.lastSummarizedEntryId,
        endEntryId: job.endEntryId,
        shouldUpdateTask: false,
        patch: {},
    })
    if (!applied) throw new Error("Failed to advance summary watermark")
}

async function gate(job: PreparedSummaryJob): Promise<boolean> {
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
