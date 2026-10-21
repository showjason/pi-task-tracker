import type { SessionEntry } from "@earendil-works/pi-coding-agent"

export type TaskStatus = "pending" | "in_progress" | "done" | "todo" | "blocked"
export type TaskPriority = "p0" | "p1" | "p2" | "p3"
export type TaskPatch = Partial<Pick<Task, "status" | "priority" | "progress" | "summary" | "nextAction" | "blocker">>

export type SummaryReason = "turn" | "timer" | "fork" | "tree" | "switch" | "quit"

export interface Task {
    jiraKeys: string[]
    title: string
    goal: string
    description: string
    status: TaskStatus
    priority: TaskPriority
    progress: string
    summary: string | null
    nextAction: string | null
    blocker: string | null
    dueDate: string | null
    revision: number
    createdAt: string
    updatedAt: string
}

export interface SessionBinding {
    sessionId: string
    taskTitle: string
    sessionFile: string
    cwd: string
    active: boolean
    boundAt: string
    unboundAt: string | null
    bindingBaselineEntryId: string
    lastSummarizedEntryId: string
}

export interface SummaryJob {
    sessionId: string
    taskTitle: string
    goal: string
    nextAction: string | null
    blocker: string | null
    expectedRevision: number
    lastSummarizedEntryId: string | null
    currentSummary: string | null
    entries: SessionEntry[]
    summaryReason: SummaryReason
    endEntryId: string
}

export interface RuntimeTrackingState {
    currentTurnCount: number
    lastSummarizedEntryId: string | null
    currentIntervalMin: number
    nextCheckAt: string
}
