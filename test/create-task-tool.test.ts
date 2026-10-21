import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createCreateTaskTool, registerCreateTaskTool } from "../src/tools/create-task.ts"
import { type FakeApi, type Harness, createFakeApi, createHarness } from "./helpers.ts"

const noopSignal = undefined

describe("tracker_create_task tool", () => {
    let harness: Harness
    let fakeApi: FakeApi

    beforeEach(() => {
        harness = createHarness()
        fakeApi = createFakeApi()
    })

    afterEach(() => {
        harness.cleanup()
    })

    it("creates a task and returns the full task as JSON, persisted in the database", async () => {
        const tool = createCreateTaskTool(harness.taskManager)

        const result = await tool.execute("t1", { title: "deploy-api" }, noopSignal)

        const returned = JSON.parse(result.content[0]!.text)
        expect(returned).toMatchObject({ title: "deploy-api", status: "todo", priority: "p2", revision: 1 })
        expect(result.details).toEqual({ task: returned })
        expect(harness.taskManager.getTask("deploy-api")).toEqual(returned)
    })

    it("rejects a duplicate title with a readable error and leaves the original task untouched", async () => {
        const tool = createCreateTaskTool(harness.taskManager)
        await tool.execute("t1", { title: "deploy-api", goal: "original" }, noopSignal)

        await expect(tool.execute("t2", { title: "deploy-api", goal: "impostor" }, noopSignal)).rejects.toThrow(
            'A task with title "deploy-api" already exists',
        )

        expect(harness.taskManager.getTask("deploy-api")!.goal).toBe("original")
        expect(harness.taskManager.listTasks()).toHaveLength(1)
    })

    it("fails fast when the signal is already aborted", async () => {
        const tool = createCreateTaskTool(harness.taskManager)

        await expect(tool.execute("t1", { title: "deploy-api" }, AbortSignal.abort())).rejects.toThrow(
            "Task creation was cancelled",
        )

        expect(harness.taskManager.getTask("deploy-api")).toBeUndefined()
    })

    it("passes optional fields through to the database", async () => {
        const tool = createCreateTaskTool(harness.taskManager)

        await tool.execute(
            "t1",
            {
                title: "deploy-api",
                goal: "ship",
                description: "api rollout",
                jiraKeys: ["SME-1"],
                priority: "p0",
                dueDate: "2026-12-31",
            },
            noopSignal,
        )

        expect(harness.taskManager.getTask("deploy-api")).toMatchObject({
            goal: "ship",
            description: "api rollout",
            jiraKeys: ["SME-1"],
            priority: "p0",
            dueDate: "2026-12-31",
        })
    })

    it("registers the tool under its documented name", () => {
        registerCreateTaskTool(fakeApi.api, harness.taskManager)

        expect(fakeApi.tools.get("tracker_create_task")).toBeDefined()
    })
})
