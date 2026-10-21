import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { initSchema, SCHEMA_VERSION } from "../src/sqlite.ts"
import { type Harness, createHarness } from "./helpers.ts"

describe("TaskManager", () => {
    let harness: Harness

    beforeEach(() => {
        harness = createHarness()
    })

    afterEach(() => {
        harness.cleanup()
    })

    // -- tasks ----------------------------------------------------------------

    it("round-trips a created task with contract defaults", () => {
        harness.taskManager.createTask({ title: "deploy-api", goal: "ship it" })

        const task = harness.taskManager.getTask("deploy-api")

        expect(task).toMatchObject({
            title: "deploy-api",
            goal: "ship it",
            jiraKeys: [],
            description: "",
            status: "todo",
            priority: "p2",
            progress: "0",
            summary: null,
            nextAction: null,
            blocker: null,
            dueDate: null,
            revision: 1,
        })
    })

    it("rejects duplicate task titles with a UNIQUE constraint error", () => {
        harness.taskManager.createTask({ title: "deploy-api" })

        expect(() => harness.taskManager.createTask({ title: "deploy-api" })).toThrow(/UNIQUE constraint failed/)
    })

    it("updates fields, bumps revision by exactly one, and persists", () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        const before = harness.taskManager.getTask("deploy-api")!

        harness.taskManager.updateTask({ title: "deploy-api", status: "in_progress", progress: "40" })

        const after = harness.taskManager.getTask("deploy-api")!
        expect(after.status).toBe("in_progress")
        expect(after.progress).toBe("40")
        expect(after.revision).toBe(before.revision + 1)
        expect(after.updatedAt >= before.updatedAt).toBe(true)
    })

    it("returns an empty list for an empty database", () => {
        expect(harness.taskManager.listTasks()).toEqual([])
    })

    it("filters listTasks by status and priority", () => {
        harness.taskManager.createTask({ title: "a", priority: "p1" })
        harness.taskManager.createTask({ title: "b", priority: "p2" })
        harness.taskManager.createTask({ title: "c", priority: "p3" })
        harness.taskManager.updateTask({ title: "b", status: "in_progress" })

        expect(harness.taskManager.listTasks({ status: "todo" }).map((t) => t.title)).toEqual(["a", "c"])
        expect(harness.taskManager.listTasks({ priority: "p2" }).map((t) => t.title)).toEqual(["b"])
        expect(harness.taskManager.listTasks({ status: "todo", priority: "p1" }).map((t) => t.title)).toEqual(["a"])
    })

    it("deletes a task so it is no longer readable or listed", () => {
        harness.taskManager.createTask({ title: "deploy-api" })

        harness.taskManager.delTask({ title: "deploy-api" })

        expect(harness.taskManager.getTask("deploy-api")).toBeUndefined()
        expect(harness.taskManager.listTasks()).toEqual([])
    })

    it("throws when deleting a task that does not exist", () => {
        expect(() => harness.taskManager.delTask({ title: "missing" })).toThrow("No task found with the given title")
    })

    it("deletes bindings of the deleted task, leaving no orphan binding", () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e1" },
        )

        harness.taskManager.delTask({ title: "deploy-api" })

        expect(harness.taskManager.getActiveBinding("session-1")).toBeUndefined()
    })

    // -- bindings --------------------------------------------------------------

    it("initializes the watermark to the binding baseline", () => {
        harness.taskManager.createTask({ title: "deploy-api" })

        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e3" },
        )

        const binding = harness.taskManager.getActiveBinding("session-1")!
        expect(binding.taskTitle).toBe("deploy-api")
        expect(binding.active).toBe(true)
        expect(binding.lastSummarizedEntryId).toBe("e3")
    })

    it("lists active bindings in descending binding-time order", () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        harness.taskManager.createTask({ title: "write-docs" })
        const metadata = { sessionFile: "/sessions/session.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e1" }

        harness.taskManager.bindTask({ sessionId: "session-oldest", title: "deploy-api" }, metadata)
        harness.taskManager.bindTask({ sessionId: "session-newest", title: "deploy-api" }, metadata)
        harness.taskManager.bindTask({ sessionId: "session-middle", title: "write-docs" }, metadata)
        const setBoundAt = harness.db.prepare(
            "UPDATE session_bindings SET bound_at = @boundAt WHERE session_id = @sessionId",
        )
        setBoundAt.run({ sessionId: "session-oldest", boundAt: "2026-10-11T10:00:00.000Z" })
        setBoundAt.run({ sessionId: "session-newest", boundAt: "2026-10-13T10:00:00.000Z" })
        setBoundAt.run({ sessionId: "session-middle", boundAt: "2026-10-12T10:00:00.000Z" })

        expect(harness.taskManager.listAllActiveBindings().map((binding) => binding.sessionId)).toEqual([
            "session-newest",
            "session-middle",
            "session-oldest",
        ])
    })

    it("rejects binding the same session twice with a primary key constraint error", () => {
        harness.taskManager.createTask({ title: "a" })
        harness.taskManager.createTask({ title: "b" })
        const metadata = { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e1" }

        harness.taskManager.bindTask({ sessionId: "session-1", title: "a" }, metadata)

        expect(() => harness.taskManager.bindTask({ sessionId: "session-1", title: "b" }, metadata)).toThrow(
            /UNIQUE constraint failed/,
        )
    })

    it("rejects binding to a task that does not exist with a foreign key error", () => {
        expect(() =>
            harness.taskManager.bindTask(
                { sessionId: "session-1", title: "missing" },
                { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e1" },
            ),
        ).toThrow(/FOREIGN KEY constraint failed/)
    })

    // -- applySummaryAndAdvanceWatermark (CAS) ----------------------------------

    function bindWithBaseline(baseline: string) {
        harness.taskManager.createTask({ title: "deploy-api", goal: "ship it" })
        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: baseline },
        )
    }

    it("applies the patch, bumps revision, and advances the watermark when CAS matches", () => {
        bindWithBaseline("e1")

        const applied = harness.taskManager.applySummaryAndAdvanceWatermark({
            sessionId: "session-1",
            title: "deploy-api",
            expectedRevision: 1,
            expectedLastSummarizedEntryId: "e1",
            endEntryId: "e5",
            shouldUpdateTask: true,
            patch: { status: "in_progress", summary: "made progress" },
        })

        expect(applied).toBe(true)
        expect(harness.taskManager.getTask("deploy-api")).toMatchObject({
            status: "in_progress",
            summary: "made progress",
            revision: 2,
        })
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e5")
    })

    it("rejects a stale revision without touching task or binding", () => {
        bindWithBaseline("e1")
        const taskBefore = harness.taskManager.getTask("deploy-api")
        const bindingBefore = harness.taskManager.getActiveBinding("session-1")

        const applied = harness.taskManager.applySummaryAndAdvanceWatermark({
            sessionId: "session-1",
            title: "deploy-api",
            expectedRevision: 99,
            expectedLastSummarizedEntryId: "e1",
            endEntryId: "e5",
            shouldUpdateTask: true,
            patch: { status: "done" },
        })

        expect(applied).toBe(false)
        expect(harness.taskManager.getTask("deploy-api")).toEqual(taskBefore)
        expect(harness.taskManager.getActiveBinding("session-1")).toEqual(bindingBefore)
    })

    it("rejects a stale watermark without touching task or binding", () => {
        bindWithBaseline("e1")
        const taskBefore = harness.taskManager.getTask("deploy-api")
        const bindingBefore = harness.taskManager.getActiveBinding("session-1")

        const applied = harness.taskManager.applySummaryAndAdvanceWatermark({
            sessionId: "session-1",
            title: "deploy-api",
            expectedRevision: 1,
            expectedLastSummarizedEntryId: "stale-watermark",
            endEntryId: "e5",
            shouldUpdateTask: true,
            patch: { status: "done" },
        })

        expect(applied).toBe(false)
        expect(harness.taskManager.getTask("deploy-api")).toEqual(taskBefore)
        expect(harness.taskManager.getActiveBinding("session-1")).toEqual(bindingBefore)
    })

    it("advances only the watermark when shouldUpdateTask is false", () => {
        bindWithBaseline("e1")

        const applied = harness.taskManager.applySummaryAndAdvanceWatermark({
            sessionId: "session-1",
            title: "deploy-api",
            expectedRevision: 1,
            expectedLastSummarizedEntryId: "e1",
            endEntryId: "e5",
            shouldUpdateTask: false,
            patch: {},
        })

        expect(applied).toBe(true)
        expect(harness.taskManager.getTask("deploy-api")).toMatchObject({ status: "todo", revision: 1 })
        expect(harness.taskManager.getActiveBinding("session-1")!.lastSummarizedEntryId).toBe("e5")
    })

    // -- schema -----------------------------------------------------------------

    it("is idempotent when the schema is already at the current version", () => {
        const db = new DatabaseSync(":memory:")
        try {
            initSchema(db)
            expect(() => initSchema(db)).not.toThrow()
            expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION })
        } finally {
            db.close()
        }
    })

    it("refuses an unsupported future schema version", () => {
        const db = new DatabaseSync(":memory:")
        try {
            db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
            expect(() => initSchema(db)).toThrow(/Unsupported database schema version/)
        } finally {
            db.close()
        }
    })
})
