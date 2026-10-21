import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TrackerRuntimeOptions } from "../src/tracker.ts"
import {
    type Harness,
    assistantEntry,
    branchFixture,
    createFakeContext,
    createFakeSessionManager,
    createHarness,
} from "./helpers.ts"

// This file must NOT statically import tracker.ts: vi.doMock of the gate only
// affects a freshly imported module, and a static import would cache the real
// one (with the real, network-bound gateChecker) for the whole file.

const PROBE_ID = "__queue-probe__"

async function expectNoJob(queue: {
    enqueue(job: unknown): boolean
    dequeue(): Promise<unknown>
    complete(job: unknown): void
}): Promise<void> {
    queue.enqueue({ endEntryId: PROBE_ID })
    const job = (await queue.dequeue()) as { endEntryId: string }
    queue.complete(job)
    expect(job?.endEntryId).toBe(PROBE_ID)
}

describe("Tracker gate integration", () => {
    let harness: Harness

    /** Load a Tracker class whose gate module is mocked to `gateChecker`. */
    async function loadGatedTracker(gateChecker: ReturnType<typeof vi.fn>) {
        vi.doMock("../src/gate.ts", () => ({ gateChecker }))
        const module = await import("../src/tracker.ts")
        return { Tracker: module.Tracker, JobQueue: module.JobQueue }
    }

    function seedBoundSession(branch: ReturnType<typeof branchFixture>, baseline: string) {
        harness.taskManager.createTask({ title: "deploy-api", goal: "ship it" })
        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: baseline },
        )
        return createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", branch })
    }

    function settledBranch(...texts: string[]) {
        return [...branchFixture(...texts), assistantEntry("final answer")]
    }

    beforeEach(() => {
        harness = createHarness()
    })

    afterEach(() => {
        harness.cleanup()
    })

    it("enqueues when the gate approves", async () => {
        const gateChecker = vi.fn().mockResolvedValue(true)
        const { Tracker, JobQueue } = await loadGatedTracker(gateChecker)
        const jobQueue = new JobQueue()
        const tracker = new Tracker({
            taskManager: harness.taskManager,
            jobQueue,
            summarizer: { runSummaryAgent: vi.fn() } as never,
            turnsThreshold: 1,
            initialIntervalMin: 30,
            maxIntervalMin: 120,
            useGate: true,
        } satisfies TrackerRuntimeOptions)
        const branch = settledBranch("q1", "a1")

        await tracker.onAgentSettled(createFakeContext(seedBoundSession(branch, branch[0]!.id)))

        expect(gateChecker).toHaveBeenCalledTimes(1)
        const job = await jobQueue.dequeue()
        expect(job).toBeDefined()
        expect(job!.summaryReason).toBe("turn")
    })

    it("advances the watermark without updating the task when the gate rejects", async () => {
        const gateChecker = vi.fn().mockResolvedValue(false)
        const { Tracker, JobQueue } = await loadGatedTracker(gateChecker)
        const jobQueue = new JobQueue()
        const tracker = new Tracker({
            taskManager: harness.taskManager,
            jobQueue,
            summarizer: { runSummaryAgent: vi.fn() } as never,
            turnsThreshold: 1,
            initialIntervalMin: 30,
            maxIntervalMin: 120,
            useGate: true,
        } satisfies TrackerRuntimeOptions)
        const branch = settledBranch("q1", "a1")
        const ctx = createFakeContext(seedBoundSession(branch, branch[0]!.id))
        const taskBefore = harness.taskManager.getTask("deploy-api")

        await tracker.onAgentSettled(ctx)

        expect(gateChecker).toHaveBeenCalledTimes(1)
        await expectNoJob(jobQueue)
        expect(harness.taskManager.getTask("deploy-api")).toEqual(taskBefore)
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe(branch.at(-1)!.id)
    })

    it("still enqueues when the gate throws (fail-open)", async () => {
        const gateChecker = vi.fn().mockRejectedValue(new Error("network down"))
        const { Tracker, JobQueue } = await loadGatedTracker(gateChecker)
        const jobQueue = new JobQueue()
        const tracker = new Tracker({
            taskManager: harness.taskManager,
            jobQueue,
            summarizer: { runSummaryAgent: vi.fn() } as never,
            turnsThreshold: 1,
            initialIntervalMin: 30,
            maxIntervalMin: 120,
            useGate: true,
        } satisfies TrackerRuntimeOptions)
        const branch = settledBranch("q1", "a1")

        await tracker.onAgentSettled(createFakeContext(seedBoundSession(branch, branch[0]!.id)))

        expect(gateChecker).toHaveBeenCalledTimes(1)
        expect(await jobQueue.dequeue()).toBeDefined()
    })
})
