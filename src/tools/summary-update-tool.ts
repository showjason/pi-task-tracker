import { Type } from "typebox"
import { openDatabase, TaskManager } from "../sqlite.ts"
import type { TaskPatch } from "../type.ts"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { trackerConfig } from "../config.ts"
import { summaryLogger } from "../logger.ts"

export function applySummaryTool() {
    return {
        name: "tracker_apply_summary",
        label: "Apply task summary",
        description: [
            "Persist this task summary decision exactly once.",
            "proposedPatch fields (all optional, no extra keys allowed):",
            "- status: one of 'pending' | 'todo' | 'in_progress' | 'blocked' | 'done'",
            "- priority: one of 'p0' | 'p1' | 'p2' | 'p3'",
            "- progress: string '0'-'100', e.g. '35'",
            "- summary / nextAction / blocker: string, or null to clear",
            "When shouldUpdateTask is false, proposedPatch must be {}.",
        ].join("\n"),
        parameters: Type.Object({
            sessionId: Type.String(),
            taskTitle: Type.String(),
            expectedRevision: Type.Number(),
            lastSummarizedEntryId: Type.String(),
            endEntryId: Type.String(),
            shouldUpdateTask: Type.Boolean(),
            decisionReason: Type.String(),
            proposedPatch: Type.Object(
                {
                    status: Type.Optional(
                        Type.Union([
                            Type.Literal("pending"),
                            Type.Literal("todo"),
                            Type.Literal("in_progress"),
                            Type.Literal("blocked"),
                            Type.Literal("done"),
                        ]),
                    ),
                    priority: Type.Optional(
                        Type.Union([Type.Literal("p0"), Type.Literal("p1"), Type.Literal("p2"), Type.Literal("p3")]),
                    ),
                    progress: Type.Optional(Type.String({ pattern: "^(?:100|[0-9]{1,2})$" })),
                    summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    nextAction: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    blocker: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                },
                { additionalProperties: false },
            ),
        }),
        executionMode: "sequential" as const,
        async execute(
            _toolCallId: string,
            params: {
                sessionId: string
                taskTitle: string
                expectedRevision: number
                lastSummarizedEntryId: string
                endEntryId: string
                shouldUpdateTask: boolean
                decisionReason: string
                proposedPatch: TaskPatch
            },
            signal: AbortSignal | undefined,
        ) {
            if (signal?.aborted) {
                throw new Error("Summary update was cancelled")
            }

            const databasePath = trackerConfig.database
            if (databasePath === undefined) {
                throw new Error("Summary database path is not configured")
            }

            const database = openDatabase(databasePath)
            try {
                const result = new TaskManager(database).applySummaryAndAdvanceWatermark({
                    sessionId: params.sessionId,
                    title: params.taskTitle,
                    expectedRevision: params.expectedRevision,
                    expectedLastSummarizedEntryId: params.lastSummarizedEntryId,
                    endEntryId: params.endEntryId,
                    shouldUpdateTask: params.shouldUpdateTask,
                    patch: params.proposedPatch,
                })
                if (!result) {
                    summaryLogger.warn("summary_db_conflict", {
                        sessionId: params.sessionId,
                        endEntryId: params.endEntryId,
                        expectedRevision: params.expectedRevision,
                        expectedLastSummarizedEntryId: params.lastSummarizedEntryId,
                    })
                    throw new Error("Summary update was not applied")
                }
            } finally {
                database.close()
            }

            summaryLogger.info("summary_db_applied", {
                sessionId: params.sessionId,
                endEntryId: params.endEntryId,
                shouldUpdateTask: params.shouldUpdateTask,
                patchKeys: Object.keys(params.proposedPatch),
                ...(params.shouldUpdateTask ? { newRevision: params.expectedRevision + 1 } : {}),
            })

            return {
                content: [{ type: "text" as const, text: "Task summary applied." }],
                details: { outcome: "applied" },
                terminate: true,
            }
        },
    }
}

export function registerSummaryUpdateTool(api: ExtensionAPI, taskManager: TaskManager): void {
    api.registerTool(applySummaryTool())
}

export default registerSummaryUpdateTool
