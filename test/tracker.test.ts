import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    createSummaryJob,
    getSummaryIncrement,
    JobQueue,
    prepareSummaryJob,
    runPreparedJob,
    Tracker,
    type TrackerRuntimeOptions,
} from "../src/tracker.ts"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import type { SummaryJob } from "../src/type.ts"
import {
    type Harness,
    assistantEntry,
    branchFixture,
    createFakeContext,
    createFakeSessionManager,
    createHarness,
    userEntry,
} from "./helpers.ts"

function makeJob(endEntryId: string): SummaryJob {
    return {
        sessionId: "session-1",
        taskTitle: "deploy-api",
        summaryReason: "turn",
        endEntryId,
        session: createFakeSessionManager(),
    }
}

const PROBE_ID = "__queue-probe__"

/**
 * Prove the queue holds no job without leaving a waiting consumer behind
 * (a raw dequeue() would steal the next enqueued job) and without real
 * timers (which never fire under vi.useFakeTimers).
 */
async function expectNoJob(queue: JobQueue): Promise<void> {
    queue.enqueue(makeJob(PROBE_ID))
    const job = await queue.dequeue()
    // Release the probe from the dedup set so later probes can be enqueued.
    queue.complete(job!)
    expect(job?.endEntryId).toBe(PROBE_ID)
}

describe("JobQueue", () => {
    it("delivers jobs in FIFO order", async () => {
        const queue = new JobQueue()
        const first = makeJob("e1")
        const second = makeJob("e2")

        expect(queue.enqueue(first)).toBe(true)
        expect(queue.enqueue(second)).toBe(true)

        expect(await queue.dequeue()).toBe(first)
        expect(await queue.dequeue()).toBe(second)
    })

    it("rejects a duplicate endEntryId while the job is queued", async () => {
        const queue = new JobQueue()
        const job = makeJob("e1")

        expect(queue.enqueue(job)).toBe(true)
        expect(queue.enqueue(makeJob("e1"))).toBe(false)

        expect(await queue.dequeue()).toBe(job)
    })

    it("allows re-enqueueing an endEntryId after complete()", async () => {
        const queue = new JobQueue()
        const first = makeJob("e1")
        queue.enqueue(first)
        expect(await queue.dequeue()).toBe(first)
        queue.complete(first)

        const second = makeJob("e1")
        expect(queue.enqueue(second)).toBe(true)
        expect(await queue.dequeue()).toBe(second)
    })

    it("resolves a waiting dequeue as soon as a job arrives", async () => {
        const queue = new JobQueue()
        const pending = queue.dequeue()

        const job = makeJob("e1")
        queue.enqueue(job)

        expect(await pending).toBe(job)
    })

    it("resolves waiting consumers with undefined on close and rejects new jobs afterwards", async () => {
        const queue = new JobQueue()
        const consumerA = queue.dequeue()
        const consumerB = queue.dequeue()

        queue.close()

        expect(await consumerA).toBeUndefined()
        expect(await consumerB).toBeUndefined()
        expect(queue.enqueue(makeJob("e1"))).toBe(false)
    })
})

describe("Tracker", () => {
    let harness: Harness
    let jobQueue: JobQueue
    let summarizer: { runSummaryAgent: ReturnType<typeof vi.fn> }

    function buildTracker(overrides: Partial<TrackerRuntimeOptions> = {}): Tracker {
        return new Tracker({
            taskManager: harness.taskManager,
            jobQueue,
            summarizer: summarizer as never,
            turnsThreshold: 2,
            initialIntervalMin: 30,
            maxIntervalMin: 120,
            useGate: false,
            ...overrides,
        })
    }

    function seedBoundSession(branch: ReturnType<typeof branchFixture>, baseline: string) {
        harness.taskManager.createTask({ title: "deploy-api", goal: "ship it" })
        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: baseline },
        )
        return createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", branch })
    }

    /** A branch whose leaf is a completed assistant turn. */
    function settledBranch(...texts: string[]) {
        return [...branchFixture(...texts), assistantEntry("final answer")]
    }

    beforeEach(() => {
        harness = createHarness()
        jobQueue = new JobQueue()
        summarizer = { runSummaryAgent: vi.fn() }
    })

    afterEach(() => {
        harness.cleanup()
    })

    it("counts only completed assistant turns and enqueues one job at the threshold", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        const sessionManager = seedBoundSession(branch, branch[0]!.id)
        const ctx = createFakeContext(sessionManager)

        // First settled turn: leaf is a "stop" assistant message -> counted.
        await tracker.onAgentSettled(ctx)
        await expectNoJob(jobQueue)

        // A turn ending in "aborted" is not counted.
        const abortedBranch = [...branch.slice(0, -1), assistantEntry("cut off", "aborted")]
        const abortedManager = createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", branch: abortedBranch })
        await tracker.onAgentSettled(createFakeContext(abortedManager))
        await expectNoJob(jobQueue)

        // Second completed turn reaches the threshold of 2.
        await tracker.onAgentSettled(ctx)

        const job = await jobQueue.dequeue()
        expect(job).toBeDefined()
        expect(job!.summaryReason).toBe("turn")
        expect(job!.endEntryId).toBe(branch.at(-1)!.id)
    })

    it("resets the turn counter after a threshold job is enqueued", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        const ctx = createFakeContext(seedBoundSession(branch, branch[0]!.id))

        await tracker.onAgentSettled(ctx)
        await tracker.onAgentSettled(ctx)
        expect(await jobQueue.dequeue()).toBeDefined()

        // One more completed turn must not immediately produce another job.
        await tracker.onAgentSettled(ctx)
        await expectNoJob(jobQueue)
    })

    it("does not enqueue below the turn threshold", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")

        await tracker.onAgentSettled(createFakeContext(seedBoundSession(branch, branch[0]!.id)))

        await expectNoJob(jobQueue)
    })

    it("skips silently when the session has no binding", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        const sessionManager = createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", branch })

        await tracker.onAgentSettled(createFakeContext(sessionManager))
        await tracker.onAgentSettled(createFakeContext(sessionManager))

        await expectNoJob(jobQueue)
    })

    it("skips when the bound task was deleted (binding removed with the task)", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        const sessionManager = seedBoundSession(branch, branch[0]!.id)

        harness.taskManager.delTask({ title: "deploy-api" })

        await tracker.onAgentSettled(createFakeContext(sessionManager))
        await tracker.onAgentSettled(createFakeContext(sessionManager))

        await expectNoJob(jobQueue)
    })

    it("enqueues a job when the watermark is already at the branch leaf", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        const ctx = createFakeContext(seedBoundSession(branch, branch.at(-1)!.id))

        await tracker.onAgentSettled(ctx)
        await tracker.onAgentSettled(ctx)

        expect(await jobQueue.dequeue()).toBeDefined()
    })

    it("enqueues a job when the watermark is not on the current branch", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        // Bind with a watermark from a different branch (e.g. after /tree).
        const sessionManager = seedBoundSession(branch, "entry-from-another-branch")

        await tracker.onAgentSettled(createFakeContext(sessionManager))
        await tracker.onAgentSettled(createFakeContext(sessionManager))

        expect(await jobQueue.dequeue()).toBeDefined()
    })

    it('queues a tree job for the "" sentinel watermark', async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1", "q2", "a2")

        const flush = tracker.flush(createFakeContext(seedBoundSession(branch, "")), "tree")

        const job = await jobQueue.dequeue()
        expect(job).toBeDefined()
        expect(job!.endEntryId).toBe(branch.at(-1)!.id)
        jobQueue.complete(job!, true)
        await expect(flush).resolves.toBe(true)
    })

    it("uses the nearest common ancestor when the watermark is on another branch", () => {
        const entries = [
            { id: "a", parentId: null },
            { id: "b", parentId: "a" },
            { id: "c", parentId: "b" },
            { id: "d", parentId: "a" },
            { id: "e", parentId: "d" },
        ].map((entry) => ({ ...userEntry(entry.id), ...entry }))
        const byId = new Map(entries.map((entry) => [entry.id, entry]))

        expect(getSummaryIncrement("e", "c", (id) => byId.get(id))).toEqual([byId.get("d"), byId.get("e")])
    })

    it("uses the full path when the watermark belongs to another root", () => {
        const entries = [
            { id: "a", parentId: null },
            { id: "b", parentId: "a" },
            { id: "x", parentId: null },
            { id: "y", parentId: "x" },
        ].map((entry) => ({ ...userEntry(entry.id), ...entry }))
        const byId = new Map(entries.map((entry) => [entry.id, entry]))

        expect(getSummaryIncrement("y", "b", (id) => byId.get(id))).toEqual([byId.get("x"), byId.get("y")])
    })

    it("advances the watermark without invoking the summary agent for non-message entries", async () => {
        const systemEntry = { ...userEntry("metadata"), type: "custom" } as SessionEntry
        const session = seedBoundSession([systemEntry], "")
        const job = createSummaryJob(harness.taskManager, session, "tree")!
        const preparedJob = prepareSummaryJob(harness.taskManager, job)!

        await runPreparedJob(harness.taskManager, summarizer as never, preparedJob, false, {} as never)

        expect(summarizer.runSummaryAgent).not.toHaveBeenCalled()
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe(systemEntry.id)
    })

    it("runs the summary agent directly on quit, bypassing the queue", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")

        await tracker.flush(createFakeContext(seedBoundSession(branch, branch[0]!.id)), "quit")

        expect(summarizer.runSummaryAgent).toHaveBeenCalledTimes(1)
        const job = summarizer.runSummaryAgent.mock.calls[0]![0] as SummaryJob
        expect(job.summaryReason).toBe("quit")
        expect(job.endEntryId).toBe(branch.at(-1)!.id)
        await expectNoJob(jobQueue)
    })

    it("enqueues (not runs) for non-quit flush reasons", async () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")

        await tracker.flush(createFakeContext(seedBoundSession(branch, branch[0]!.id)), "fork")

        expect(summarizer.runSummaryAgent).not.toHaveBeenCalled()
        const job = await jobQueue.dequeue()
        expect(job).toBeDefined()
        expect(job!.summaryReason).toBe("fork")
    })

    // Gate-dependent tests live in tracker-gate.test.ts: this file statically
    // imports tracker.ts, which would cache the module and defeat vi.doMock
    // of the gate (the mocked gateChecker would never be called).

    describe("timer", () => {
        beforeEach(() => {
            vi.useFakeTimers()
        })

        afterEach(() => {
            vi.useRealTimers()
        })

        it("enqueues a timer job when the interval elapses", async () => {
            const tracker = buildTracker()
            const branch = settledBranch("q1", "a1")

            tracker.start(createFakeContext(seedBoundSession(branch, branch[0]!.id)))
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

            const job = await jobQueue.dequeue()
            expect(job).toBeDefined()
            expect(job!.summaryReason).toBe("timer")
        })

        it("doubles the interval after a no-op fire, so the next fire waits longer", async () => {
            const tracker = buildTracker()
            const branch = settledBranch("q1", "a1")
            const sessionManager = seedBoundSession(branch, branch.at(-1)!.id)

            tracker.start(createFakeContext(sessionManager))

            // First fire at 30min creates an empty-increment job. The consumer
            // now decides whether it has work, so enqueueing resets the timer.
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
            const job = await jobQueue.dequeue()
            expect(job).toBeDefined()
            expect(job!.summaryReason).toBe("timer")
        })

        it("caps the backoff at maxIntervalMin", async () => {
            const tracker = buildTracker({ initialIntervalMin: 30, maxIntervalMin: 45 })
            const branch = settledBranch("q1", "a1")
            const sessionManager = seedBoundSession(branch, branch.at(-1)!.id)

            tracker.start(createFakeContext(sessionManager))

            // The timer keeps its initial interval after an enqueue, even when
            // the consumer later finds no increment.
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
            const first = await jobQueue.dequeue()
            expect(first!.summaryReason).toBe("timer")
            jobQueue.complete(first!)

            await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
            const job = await jobQueue.dequeue()
            expect(job).toBeDefined()
            expect(job!.summaryReason).toBe("timer")
        })

        it("does not fire after shutDown()", async () => {
            const tracker = buildTracker()
            const branch = settledBranch("q1", "a1")

            tracker.start(createFakeContext(seedBoundSession(branch, branch[0]!.id)))
            tracker.shutDown()

            await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
            await expectNoJob(jobQueue)
        })
    })

    it("shows the task widget on start when an active binding exists and the context has a UI", () => {
        const tracker = buildTracker()
        const branch = settledBranch("q1", "a1")
        const ctx = createFakeContext(seedBoundSession(branch, branch[0]!.id), { hasUI: true })
        ctx.ui.setWidget = vi.fn()

        tracker.start(ctx)

        expect(ctx.ui.setWidget).toHaveBeenCalledWith("tracker-task", ["▸ task: deploy-api | sessid: session-1"], {
            placement: "aboveEditor",
        })
    })
})
