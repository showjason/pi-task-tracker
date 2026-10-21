import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBindTaskTool, registerBindTaskTool } from "../src/tools/bind-task.ts"
import { createCreateTaskTool } from "../src/tools/create-task.ts"
import { JobQueue, Tracker } from "../src/tracker.ts"
import {
    type FakeApi,
    type Harness,
    assistantEntry,
    branchFixture,
    createFakeApi,
    createFakeContext,
    createFakeSessionManager,
    createHarness,
    expectPending,
    userEntry,
} from "./helpers.ts"

const noopSignal = undefined

describe("tracker_bind_task tool", () => {
    let harness: Harness
    let fakeApi: FakeApi

    beforeEach(() => {
        harness = createHarness()
        fakeApi = createFakeApi()
    })

    afterEach(() => {
        harness.cleanup()
    })

    async function seedTask(title = "deploy-api") {
        await createCreateTaskTool(harness.taskManager).execute("t0", { title }, noopSignal)
    }

    it("binds the session, records the task-binding entry, and sets the watermark to the leaf id", async () => {
        await seedTask()
        const tool = createBindTaskTool(fakeApi.api, harness.taskManager)
        const ctx = createFakeContext(
            createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", leafId: "abc12345" }),
        )

        const result = await tool.execute("t1", { title: "deploy-api" }, noopSignal, undefined, ctx)

        expect(result.content[0]!.text).toBe('Session bound to task "deploy-api".')
        const binding = harness.taskManager.getActiveBinding("session-1")!
        expect(binding.taskTitle).toBe("deploy-api")
        expect(binding.lastSummarizedEntryId).toBe("abc12345")
        expect(fakeApi.appendedEntries).toEqual([
            {
                customType: "task-binding",
                data: { taskTitle: "deploy-api", sessionId: "session-1", bindingBaselineEntryId: "abc12345" },
            },
        ])
    })

    it('binds an empty session with the "" sentinel so the first summary covers the whole branch', async () => {
        await seedTask()
        const branch = branchFixture("plan", "work", "more", "done")
        const sessionManager = createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", leafId: null, branch })
        const tool = createBindTaskTool(fakeApi.api, harness.taskManager)
        await tool.execute("t1", { title: "deploy-api" }, noopSignal, undefined, createFakeContext(sessionManager))

        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("")

        // Drive the real Tracker path: the first flush must summarize the whole branch.
        const jobQueue = new JobQueue()
        const tracker = new Tracker({
            taskManager: harness.taskManager,
            jobQueue,
            summarizer: { runSummaryAgent: vi.fn() } as never,
            turnsThreshold: 1,
            initialIntervalMin: 30,
            maxIntervalMin: 120,
            useGate: false,
        })
        await tracker.flush(createFakeContext(sessionManager), "tree")

        const job = await jobQueue.dequeue()
        expect(job).toBeDefined()
        expect(job!.entries).toEqual(branch)
        expect(job!.endEntryId).toBe(branch.at(-1)!.id)
    })

    it("rejects an unknown task with a readable error and no side effects", async () => {
        const tool = createBindTaskTool(fakeApi.api, harness.taskManager)
        const ctx = createFakeContext(createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", leafId: "e1" }))

        await expect(tool.execute("t1", { title: "missing" }, noopSignal, undefined, ctx)).rejects.toThrow(
            'No task found with title "missing"',
        )

        expect(fakeApi.appendedEntries).toEqual([])
        expect(harness.taskManager.getActiveBinding("session-1")).toBeUndefined()
    })

    it("rejects binding when the session file is not available", async () => {
        await seedTask()
        const tool = createBindTaskTool(fakeApi.api, harness.taskManager)
        const ctx = createFakeContext(createFakeSessionManager({ sessionFile: undefined, leafId: "e1" }))

        await expect(tool.execute("t1", { title: "deploy-api" }, noopSignal, undefined, ctx)).rejects.toThrow(
            "Session file is not available",
        )
    })

    it("shows the task widget only when the context has a UI", async () => {
        await seedTask()
        const tool = createBindTaskTool(fakeApi.api, harness.taskManager)
        const sessionManager = createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", leafId: "e1" })

        const withUi = createFakeContext(sessionManager, { hasUI: true })
        withUi.ui.setWidget = vi.fn()
        await tool.execute("t1", { title: "deploy-api" }, noopSignal, undefined, withUi)
        expect(withUi.ui.setWidget).toHaveBeenCalledWith("tracker-task", ["▸ task: deploy-api | sessid: session-1"], {
            placement: "aboveEditor",
        })

        const withoutUi = createFakeContext(sessionManager, { hasUI: false })
        withoutUi.ui.setWidget = vi.fn()
        await expect(tool.execute("t2", { title: "deploy-api" }, noopSignal, undefined, withoutUi)).rejects.toThrow()
        expect(withoutUi.ui.setWidget).not.toHaveBeenCalled()
    })

    it("rejects rebinding a session that is already bound, keeping the original binding", async () => {
        await seedTask("original-task")
        await seedTask("other-task")
        const tool = createBindTaskTool(fakeApi.api, harness.taskManager)
        const ctx = createFakeContext(createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", leafId: "e1" }))
        await tool.execute("t1", { title: "original-task" }, noopSignal, undefined, ctx)
        fakeApi.appendedEntries.length = 0

        await expect(tool.execute("t2", { title: "other-task" }, noopSignal, undefined, ctx)).rejects.toThrow(
            'Session is already bound to task "original-task"',
        )

        expect(fakeApi.appendedEntries).toEqual([])
        expect(harness.taskManager.getActiveBinding("session-1")!.taskTitle).toBe("original-task")
    })

    it("registers the tool under its documented name", () => {
        registerBindTaskTool(fakeApi.api, harness.taskManager)

        expect(fakeApi.tools.get("tracker_bind_task")).toBeDefined()
    })
})

// Silence unused-import lint for helpers used only in the sentinel test above.
void userEntry
void assistantEntry
void expectPending
