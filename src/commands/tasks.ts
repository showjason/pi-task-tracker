import { TaskManager } from "../sqlite.ts"
import { type TaskListItem, TaskListScreen } from "../ui.ts"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { SessionBinding, Task } from "../type.ts"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { trackerLogger } from "../logger.ts"

export const showTaskUi = async (
    tasks: TaskListItem[],
    activeTaskTitle: string | undefined,
    onDelete: (title: string) => TaskListItem[],
    ctx: ExtensionCommandContext,
) => {
    if (ctx.mode !== "tui") {
        return
    }
    await ctx.ui.custom((_tui, theme, _kb, done) => new TaskListScreen(tasks, theme, activeTaskTitle, onDelete, done))
}

export function toTaskListItem(task: Task, sessions: SessionBinding[] = []): TaskListItem {
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...item } = task
    return { ...item, sessions }
}

export function listTasks(taskManager: TaskManager): TaskListItem[] {
    const bindingsByTask = Map.groupBy(taskManager.listAllActiveBindings(), (binding) => binding.taskTitle)
    return taskManager.listTasks().map((task) => toTaskListItem(task, bindingsByTask.get(task.title) ?? []))
}

export function registerTaskListCommand(api: ExtensionAPI, taskManager: TaskManager) {
    api.registerCommand("tasks", {
        description: "List all tasks in a custom UI",
        handler: async (_args, ctx) => {
            const tasks = listTasks(taskManager)
            if (tasks.length === 0 && ctx.hasUI) {
                ctx.ui.notify("No tasks available")
                return
            }
            const sessionId = ctx.sessionManager.getSessionId()
            const activeTaskTitle = taskManager.getActiveBinding(sessionId)?.taskTitle
            await showTaskUi(
                tasks,
                activeTaskTitle,
                (title) => {
                    taskManager.delTask({ title })
                    trackerLogger.info("task_deleted", { title, sessionId })
                    return listTasks(taskManager)
                },
                ctx,
            )
        },
    })
}
export default registerTaskListCommand
