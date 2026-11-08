import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

describe("Tracker gate integration", () => {
    let harness: Harness

    /** Load a Tracker class whose gate module is mocked to `gateChecker`. */
    async function loadGatedTracker(gateChecker: ReturnType<typeof vi.fn>) {
        vi.doMock("../src/gate.ts", () => ({ gateChecker }))
        const module = await import("../src/tracker.ts")
        return module
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

    async function runPreparedJob(gateChecker: ReturnType<typeof vi.fn>) {
        const tracker = await loadGatedTracker(gateChecker)
        const branch = settledBranch("q1", "a1")
        const session = seedBoundSession(branch, branch[0]!.id)
        const job = tracker.createSummaryJob(harness.taskManager, session, "turn")!
        const preparedJob = tracker.prepareSummaryJob(harness.taskManager, job)!
        const summarizer = { runSummaryAgent: vi.fn() }
        const taskBefore = harness.taskManager.getTask("deploy-api")

        await tracker.runPreparedJob(harness.taskManager, summarizer as never, preparedJob, true, {} as never)
        return { branch, summarizer, taskBefore }
    }

    it("runs the summary agent when the gate approves", async () => {
        const gateChecker = vi.fn().mockResolvedValue(true)
        const { summarizer } = await runPreparedJob(gateChecker)

        expect(gateChecker).toHaveBeenCalledTimes(1)
        expect(summarizer.runSummaryAgent).toHaveBeenCalledTimes(1)
    })

    it("advances the watermark without updating the task when the gate rejects", async () => {
        const gateChecker = vi.fn().mockResolvedValue(false)
        const { branch, summarizer, taskBefore } = await runPreparedJob(gateChecker)

        expect(gateChecker).toHaveBeenCalledTimes(1)
        expect(summarizer.runSummaryAgent).not.toHaveBeenCalled()
        expect(harness.taskManager.getTask("deploy-api")).toEqual(taskBefore)
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe(branch.at(-1)!.id)
    })

    it("still enqueues when the gate throws (fail-open)", async () => {
        const gateChecker = vi.fn().mockRejectedValue(new Error("network down"))
        const { summarizer } = await runPreparedJob(gateChecker)

        expect(gateChecker).toHaveBeenCalledTimes(1)
        expect(summarizer.runSummaryAgent).toHaveBeenCalledTimes(1)
    })
})
