import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { TaskManager } from "../sqlite.ts"
import { trackerLogger } from "../logger.ts"

export function createCreateTaskTool(taskManager: TaskManager) {
    return {
        name: "tracker_create_task",
        label: "Create task",
        description: "Create a tracked task. Fails if a task with the same title already exists.",
        promptSnippet: "Create a tracked task (title required).",
        parameters: Type.Object({
            title: Type.String({ description: "Unique task title" }),
            goal: Type.Optional(Type.String({ description: "What done looks like for this task" })),
            description: Type.Optional(Type.String({ description: "Context and scope of the task" })),
            jiraKeys: Type.Optional(Type.Array(Type.String(), { description: "Related Jira issue keys" })),
            priority: Type.Optional(
                Type.Union([Type.Literal("p0"), Type.Literal("p1"), Type.Literal("p2"), Type.Literal("p3")], {
                    description: "Task priority, defaults to p2",
                }),
            ),
            dueDate: Type.Optional(Type.String({ description: "Due date as ISO date (YYYY-MM-DD)" })),
        }),
        executionMode: "sequential" as const,
        async execute(
            _toolCallId: string,
            params: {
                title: string
                goal?: string
                description?: string
                jiraKeys?: string[]
                priority?: "p0" | "p1" | "p2" | "p3"
                dueDate?: string
            },
            signal: AbortSignal | undefined,
        ) {
            if (signal?.aborted) {
                throw new Error("Task creation was cancelled")
            }

            if (taskManager.getTask(params.title) !== undefined) {
                throw new Error(`A task with title "${params.title}" already exists`)
            }

            taskManager.createTask({
                title: params.title,
                goal: params.goal,
                description: params.description,
                jiraKeys: params.jiraKeys,
                priority: params.priority,
                dueDate: params.dueDate,
            })

            const task = taskManager.getTask(params.title)
            if (task === undefined) {
                throw new Error(`Task "${params.title}" was not found after creation`)
            }

            trackerLogger.info("task_created", { taskTitle: task.title, priority: task.priority })
            return {
                content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
                details: { task },
            }
        },
    }
}

export function registerCreateTaskTool(api: ExtensionAPI, taskManager: TaskManager): void {
    api.registerTool(createCreateTaskTool(taskManager))
}

export default registerCreateTaskTool
