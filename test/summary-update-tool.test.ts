import { join } from "node:path"
import { Value } from "typebox/value"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applySummaryTool } from "../src/tools/summary-update-tool.ts"
import { type Harness, createHarness } from "./helpers.ts"

const noopSignal = undefined

// The tool resolves its database via trackerConfig.database, which is read at
// import time. Redirect TRACKER_HOME to the harness temp dir and re-import the
// tool module so it operates on the real test database.
async function loadToolForHarness(harness: Harness) {
    process.env.TRACKER_HOME = harness.tempDir
    vi.resetModules()
    const { applySummaryTool } = await import("../src/tools/summary-update-tool.ts")
    return applySummaryTool()
}

describe("tracker_apply_summary tool", () => {
    let harness: Harness

    beforeEach(() => {
        harness = createHarness()
    })

    afterEach(() => {
        harness.cleanup()
    })

    function seedBoundTask() {
        harness.taskManager.createTask({ title: "deploy-api", goal: "ship it" })
        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e1" },
        )
    }

    it("applies the summary and terminates the agent loop when CAS matches", async () => {
        seedBoundTask()
        const tool = await loadToolForHarness(harness)

        const result = await tool.execute(
            "t1",
            {
                sessionId: "session-1",
                taskTitle: "deploy-api",
                expectedRevision: 1,
                lastSummarizedEntryId: "e1",
                endEntryId: "e5",
                shouldUpdateTask: true,
                decisionReason: "material progress",
                proposedPatch: { status: "in_progress", summary: "halfway" },
            },
            noopSignal,
        )

        expect(result.content[0]!.text).toBe("Task summary applied.")
        expect(result.terminate).toBe(true)
        expect(harness.taskManager.getTask("deploy-api")).toMatchObject({
            status: "in_progress",
            summary: "halfway",
            revision: 2,
        })
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e5")
    })

    it("throws instead of silently succeeding when the revision is stale", async () => {
        seedBoundTask()
        const tool = await loadToolForHarness(harness)

        await expect(
            tool.execute(
                "t1",
                {
                    sessionId: "session-1",
                    taskTitle: "deploy-api",
                    expectedRevision: 99,
                    lastSummarizedEntryId: "e1",
                    endEntryId: "e5",
                    shouldUpdateTask: true,
                    decisionReason: "stale",
                    proposedPatch: { status: "done" },
                },
                noopSignal,
            ),
        ).rejects.toThrow("Summary update was not applied")

        expect(harness.taskManager.getTask("deploy-api")!.revision).toBe(1)
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e1")
    })

    it("advances only the watermark when shouldUpdateTask is false", async () => {
        seedBoundTask()
        const tool = await loadToolForHarness(harness)

        await tool.execute(
            "t1",
            {
                sessionId: "session-1",
                taskTitle: "deploy-api",
                expectedRevision: 1,
                lastSummarizedEntryId: "e1",
                endEntryId: "e5",
                shouldUpdateTask: false,
                decisionReason: "not goal-relevant",
                proposedPatch: {},
            },
            noopSignal,
        )

        expect(harness.taskManager.getTask("deploy-api")).toMatchObject({ status: "todo", revision: 1 })
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e5")
    })

    it("keeps task fields unchanged when shouldUpdateTask is false but the patch is non-empty", async () => {
        seedBoundTask()
        const tool = await loadToolForHarness(harness)

        await tool.execute(
            "t1",
            {
                sessionId: "session-1",
                taskTitle: "deploy-api",
                expectedRevision: 1,
                lastSummarizedEntryId: "e1",
                endEntryId: "e5",
                shouldUpdateTask: false,
                decisionReason: "hallucinated patch",
                proposedPatch: { status: "done", summary: "should not land" },
            },
            noopSignal,
        )

        expect(harness.taskManager.getTask("deploy-api")).toMatchObject({ status: "todo", summary: null, revision: 1 })
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e5")
    })

    it("rejects unknown patch keys at the schema level, before execute runs", async () => {
        const tool = applySummaryTool()

        const invalidInput = {
            sessionId: "session-1",
            taskTitle: "deploy-api",
            expectedRevision: 1,
            lastSummarizedEntryId: "e1",
            endEntryId: "e5",
            shouldUpdateTask: true,
            decisionReason: "x",
            proposedPatch: { status: "done", evilExtra: "no" },
        }

        expect(Value.Check(tool.parameters, invalidInput)).toBe(false)
        expect(Value.Check(tool.parameters, { ...invalidInput, proposedPatch: { status: "done" } })).toBe(true)
    })

    it("fails fast when the signal is already aborted", async () => {
        const tool = applySummaryTool()

        await expect(
            tool.execute(
                "t1",
                {
                    sessionId: "session-1",
                    taskTitle: "deploy-api",
                    expectedRevision: 1,
                    lastSummarizedEntryId: "e1",
                    endEntryId: "e5",
                    shouldUpdateTask: false,
                    decisionReason: "x",
                    proposedPatch: {},
                },
                AbortSignal.abort(),
            ),
        ).rejects.toThrow("Summary update was cancelled")
    })

    it("opens and closes its own database connection per execution", async () => {
        seedBoundTask()
        const tool = await loadToolForHarness(harness)

        // Two executions against the same harness db must both succeed: the
        // tool's own connection is closed each time, so no WAL lock is held.
        await tool.execute(
            "t1",
            {
                sessionId: "session-1",
                taskTitle: "deploy-api",
                expectedRevision: 1,
                lastSummarizedEntryId: "e1",
                endEntryId: "e5",
                shouldUpdateTask: false,
                decisionReason: "x",
                proposedPatch: {},
            },
            noopSignal,
        )
        await tool.execute(
            "t2",
            {
                sessionId: "session-1",
                taskTitle: "deploy-api",
                expectedRevision: 1,
                lastSummarizedEntryId: "e5",
                endEntryId: "e9",
                shouldUpdateTask: false,
                decisionReason: "x",
                proposedPatch: {},
            },
            noopSignal,
        )

        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e9")
    })
})

// Keep the import referenced for type-only usage sites above.
void join
