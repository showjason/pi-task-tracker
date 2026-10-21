import { Type } from "typebox"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TaskManager } from "../sqlite.ts"
import { trackerLogger } from "../logger.ts"
import { showTaskWidget } from "../tracker.ts"

export function createBindTaskTool(api: ExtensionAPI, taskManager: TaskManager) {
    return {
        name: "tracker_bind_task",
        label: "Bind task to session",
        description:
            "Bind the current session to an existing task so conversation increments are summarized into it. " +
            "Requires the session to have at least one completed prompt/reply.",
        promptSnippet: "Bind this session to a tracked task (title required).",
        parameters: Type.Object({
            title: Type.String({ description: "Title of the task to bind" }),
        }),
        executionMode: "sequential" as const,
        async execute(
            _toolCallId: string,
            params: { title: string },
            signal: AbortSignal | undefined,
            _onUpdate: undefined,
            ctx: ExtensionContext,
        ) {
            if (signal?.aborted) {
                throw new Error("Task binding was cancelled")
            }

            const task = taskManager.getTask(params.title)
            if (task === undefined) {
                throw new Error(`No task found with title "${params.title}"`)
            }

            const session = ctx.sessionManager
            const sessionFile = session.getSessionFile()
            if (sessionFile === undefined) {
                throw new Error("Session file is not available")
            }

            const bindSession = taskManager.getActiveBinding(session.getSessionId())
            if (bindSession !== undefined) {
                throw new Error(`Session is already bound to task "${bindSession.taskTitle}"`)
            }
            // Empty sessions (no entries yet) bind with the "" sentinel baseline:
            // "nothing summarized yet". The first summary will cover the whole branch.
            const baselineEntryId = session.getLeafId() ?? ""

            taskManager.bindTask(
                { sessionId: session.getSessionId(), title: task.title },
                {
                    sessionFile,
                    cwd: session.getCwd(),
                    bindingBaselineEntryId: baselineEntryId,
                },
            )
            api.appendEntry("task-binding", {
                taskTitle: task.title,
                sessionId: session.getSessionId(),
                bindingBaselineEntryId: baselineEntryId,
            })

            if (ctx.hasUI) {
                showTaskWidget(ctx, task.title, session.getSessionId())
            }

            trackerLogger.info("task_bound", { taskTitle: task.title, sessionId: session.getSessionId() })
            return {
                content: [{ type: "text" as const, text: `Session bound to task "${task.title}".` }],
                details: { taskTitle: task.title },
            }
        },
    }
}

export function registerBindTaskTool(api: ExtensionAPI, taskManager: TaskManager): void {
    api.registerTool(createBindTaskTool(api, taskManager))
}

export default registerBindTaskTool
