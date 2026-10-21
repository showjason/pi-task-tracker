import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listTasks, registerTaskListCommand, toTaskListItem } from "../src/commands/tasks.ts"
import { TaskListScreen } from "../src/ui.ts"
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import type { SessionBinding } from "../src/type.ts"
import { type FakeApi, type Harness, createFakeApi, createFakeSessionManager, createHarness } from "./helpers.ts"

const stubTheme = {
    fg: (_name: string, text: string) => text,
} as unknown as Theme

/** Drive the real factory passed to ui.custom and return the screen it builds. */
function buildScreen(ctx: ExtensionCommandContext): TaskListScreen {
    const custom = vi.mocked(ctx.ui.custom)
    expect(custom).toHaveBeenCalledTimes(1)
    const factory = custom.mock.calls[0]![0] as (
        tui: unknown,
        theme: Theme,
        kb: unknown,
        done: (result: string | null) => void,
    ) => TaskListScreen
    return factory(undefined, stubTheme, undefined, vi.fn())
}

function createCommandContext(
    options: { mode?: "tui" | "print" | "rpc"; hasUI?: boolean } = {},
): ExtensionCommandContext {
    const ctx = {
        mode: options.mode ?? "tui",
        hasUI: options.hasUI ?? true,
        ui: {
            notify: vi.fn(),
            custom: vi.fn<never>(),
        },
        sessionManager: createFakeSessionManager(),
    } as unknown as ExtensionCommandContext
    return ctx
}

describe("/tasks command", () => {
    let harness: Harness
    let fakeApi: FakeApi

    beforeEach(() => {
        harness = createHarness()
        fakeApi = createFakeApi()
        registerTaskListCommand(fakeApi.api, harness.taskManager)
    })

    afterEach(() => {
        harness.cleanup()
    })

    it('registers the command under the name "tasks"', () => {
        expect(fakeApi.commands.get("tasks")).toBeDefined()
    })

    it("notifies and renders nothing when there are no tasks", async () => {
        const ctx = createCommandContext()

        await fakeApi.runCommand("tasks", "", ctx)

        expect(ctx.ui.notify).toHaveBeenCalledWith("No tasks available")
        expect(ctx.ui.custom).not.toHaveBeenCalled()
    })

    it("renders the task list with the active task title in tui mode", async () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        harness.taskManager.createTask({ title: "write-docs" })
        harness.taskManager.bindTask(
            { sessionId: "session-1", title: "deploy-api" },
            { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: "e1" },
        )
        const ctx = createCommandContext()

        await fakeApi.runCommand("tasks", "", ctx)

        const screen = buildScreen(ctx)
        const lines = screen.render(80).join("\n")
        expect(lines).toContain("deploy-api")
        expect(lines).toContain("write-docs")
        // The active task is marked with the active indicator.
        expect(lines).toContain("▸ 📝 deploy-api")
    })

    it("shows an empty sessions field in task details", () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        const task = toTaskListItem(harness.taskManager.getTask("deploy-api")!)
        const screen = new TaskListScreen([task], stubTheme, undefined, () => [], vi.fn())

        screen.handleInput("\r")

        expect(screen.render(80).join("\n")).toContain("Sessions: -")
    })

    it("shows only the three most recent sessions in task details", () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        const sessions: SessionBinding[] = [
            {
                sessionId: "session-newest",
                taskTitle: "deploy-api",
                sessionFile: "/sessions/newest.jsonl",
                cwd: "/workspace/api",
                active: true,
                boundAt: "2026-10-14T10:00:00.000Z",
                unboundAt: null,
                bindingBaselineEntryId: "entry-4",
                lastSummarizedEntryId: "entry-4",
            },
            {
                sessionId: "session-second",
                taskTitle: "deploy-api",
                sessionFile: "/sessions/second.jsonl",
                cwd: "/workspace/api",
                active: true,
                boundAt: "2026-10-13T10:00:00.000Z",
                unboundAt: null,
                bindingBaselineEntryId: "entry-3",
                lastSummarizedEntryId: "entry-3",
            },
            {
                sessionId: "session-third",
                taskTitle: "deploy-api",
                sessionFile: "/sessions/third.jsonl",
                cwd: "/workspace/api",
                active: true,
                boundAt: "2026-10-12T10:00:00.000Z",
                unboundAt: null,
                bindingBaselineEntryId: "entry-2",
                lastSummarizedEntryId: "entry-2",
            },
            {
                sessionId: "session-oldest",
                taskTitle: "deploy-api",
                sessionFile: "/sessions/oldest.jsonl",
                cwd: "/workspace/api",
                active: true,
                boundAt: "2026-10-11T10:00:00.000Z",
                unboundAt: null,
                bindingBaselineEntryId: "entry-1",
                lastSummarizedEntryId: "entry-1",
            },
        ]
        const task = toTaskListItem(harness.taskManager.getTask("deploy-api")!, sessions)
        const screen = new TaskListScreen([task], stubTheme, undefined, () => [], vi.fn())

        screen.handleInput("\r")

        const details = screen.render(120).join("\n")
        expect(details).toContain("Sessions (3 of 4):")
        expect(details).toContain("sessid: session-newest")
        expect(details).toContain("sessid: session-second")
        expect(details).toContain("sessid: session-third")
        expect(details).not.toContain("session-oldest")
    })

    it("renders nothing outside tui mode", async () => {
        harness.taskManager.createTask({ title: "deploy-api" })
        const ctx = createCommandContext({ mode: "print" })

        await fakeApi.runCommand("tasks", "", ctx)

        expect(ctx.ui.custom).not.toHaveBeenCalled()
    })

    it("deletes the task and returns the refreshed list from the onDelete callback", async () => {
        harness.taskManager.createTask({ title: "keep-me" })
        harness.taskManager.createTask({ title: "delete-me" })
        const ctx = createCommandContext()

        await fakeApi.runCommand("tasks", "", ctx)

        // The delete flow: select "delete-me" (arrow-down), press "d" to arm
        // deletion, switch the confirmation choice to "delete" (arrow-right),
        // then confirm with Enter. Raw terminal sequences, as matchesKey
        // expects them.
        const screen = buildScreen(ctx)
        screen.handleInput("\x1b[B")
        screen.handleInput("d")
        screen.handleInput("\x1b[C")
        screen.handleInput("\r")

        expect(harness.taskManager.getTask("delete-me")).toBeUndefined()
        expect(harness.taskManager.listTasks().map((t) => t.title)).toEqual(["keep-me"])
    })

    it("strips internal fields from list items", () => {
        harness.taskManager.createTask({ title: "deploy-api" })

        const [item] = listTasks(harness.taskManager)

        expect(item).not.toHaveProperty("revision")
        expect(item).not.toHaveProperty("createdAt")
        expect(item).not.toHaveProperty("updatedAt")
        expect(item).toHaveProperty("title", "deploy-api")
        expect(toTaskListItem(harness.taskManager.getTask("deploy-api")!)).toEqual(item)
    })
})
