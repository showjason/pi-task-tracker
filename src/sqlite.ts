import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Task, SessionBinding, TaskPatch, TaskPriority, TaskStatus } from "./type.ts"

export const SCHEMA_VERSION = 2

export function openDatabase(dbPath: string): DatabaseSync {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(`PRAGMA journal_mode = WAL`)
    db.exec(`PRAGMA foreign_keys = ON`)
    db.exec(`PRAGMA busy_timeout = 5000`)

    initSchema(db)
    return db
}

export function initSchema(db: DatabaseSync): void {
    const current = getUserVersion(db)
    if (current === SCHEMA_VERSION) return
    if (current !== 0) {
        throw new Error(`Unsupported database schema version ${current}; recreate the database`)
    }

    db.exec("BEGIN")
    try {
        createTables(db)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        db.exec("COMMIT")
    } catch (err) {
        db.exec("ROLLBACK")
        throw err
    }
}

function getUserVersion(db: DatabaseSync): number {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
    return row.user_version
}

function createTables(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            title TEXT PRIMARY KEY NOT NULL,
            jira_keys TEXT NOT NULL DEFAULT '[]',
            goal TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'todo'
                        CHECK (status IN ('pending','todo','in_progress','blocked','done')),
            priority    TEXT NOT NULL DEFAULT 'p2'
                        CHECK (priority IN ('p0','p1','p2','p3')),
            progress    TEXT NOT NULL DEFAULT '0',
            summary     TEXT,
            next_action TEXT,
            blocker     TEXT,
            due_date    TEXT,
            revision    INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS session_bindings (
            session_id                TEXT PRIMARY KEY NOT NULL,
            task_title                TEXT NOT NULL REFERENCES tasks(title),
            session_file              TEXT NOT NULL,
            cwd                       TEXT NOT NULL,
            active                    INTEGER NOT NULL DEFAULT 1
                                      CHECK (active IN (0, 1)),
            bound_at                  TEXT NOT NULL,
            unbound_at                TEXT,
            binding_baseline_entry_id TEXT NOT NULL,
            last_summarized_entry_id  TEXT NOT NULL
        );     
        
    `)
}

export type CreateTaskInput = Pick<Task, "title"> &
    Partial<Pick<Task, "jiraKeys" | "goal" | "description" | "priority" | "dueDate">>

export type UpdateTaskInput = Pick<Task, "title"> &
    Partial<
        Pick<
            Task,
            | "jiraKeys"
            | "goal"
            | "description"
            | "status"
            | "priority"
            | "progress"
            | "summary"
            | "nextAction"
            | "blocker"
            | "dueDate"
        >
    >

export type ListTasksInput = Partial<Pick<Task, "title" | "status" | "priority" | "dueDate">>

export type DelTaskInput = Pick<Task, "title">

export type BindTaskInput = Pick<Task, "title"> & Pick<SessionBinding, "sessionId">

export type BindTaskMetadata = Pick<SessionBinding, "sessionFile" | "cwd" | "bindingBaselineEntryId">

export interface ApplySummaryInput {
    sessionId: string
    title: string
    expectedRevision: number
    expectedLastSummarizedEntryId: string
    endEntryId: string
    shouldUpdateTask: boolean
    patch: TaskPatch
}

export interface TaskRow {
    jira_keys: string
    title: string
    goal: string
    description: string
    status: TaskStatus
    priority: TaskPriority
    progress: string
    summary: string | null
    next_action: string | null
    blocker: string | null
    due_date: string | null
    revision: number
    created_at: string
    updated_at: string
}

interface SessionBindingRow {
    session_id: string
    task_title: string
    session_file: string
    cwd: string
    active: number
    bound_at: string
    unbound_at: string | null
    binding_baseline_entry_id: string
    last_summarized_entry_id: string
}

export class TaskManager {
    private readonly db: DatabaseSync

    constructor(db: DatabaseSync) {
        this.db = db
    }

    getTask(title: string): Task | undefined {
        const row = this.db
            .prepare(
                `
            SELECT jira_keys, title, goal, description, status, priority, progress,
                   summary, next_action, blocker, due_date, revision, created_at, updated_at
            FROM tasks
            WHERE title = @title
        `,
            )
            .get({ title }) as unknown as TaskRow | undefined

        return row === undefined ? undefined : toTask(row)
    }

    getActiveBinding(sessionId: string): SessionBinding | undefined {
        const row = this.db
            .prepare(
                `
            SELECT session_id, task_title, session_file, cwd, active, bound_at, unbound_at,
                   binding_baseline_entry_id, last_summarized_entry_id
            FROM session_bindings
            WHERE session_id = @sessionId AND active = 1
        `,
            )
            .get({ sessionId }) as unknown as SessionBindingRow | undefined

        return row === undefined ? undefined : toSessionBinding(row)
    }

    listAllActiveBindings(): SessionBinding[] {
        const rows = this.db
            .prepare(
                `
            SELECT session_id, task_title, session_file, cwd, active, bound_at, unbound_at,
                   binding_baseline_entry_id, last_summarized_entry_id
            FROM session_bindings
            WHERE active = 1
            ORDER BY bound_at DESC
        `,
            )
            .all() as unknown as SessionBindingRow[]

        return rows.map(toSessionBinding)
    }

    createTask(input: CreateTaskInput): void {
        const now = new Date().toISOString()

        const task = {
            title: input.title,
            jiraKeys: input.jiraKeys ?? [],
            goal: input.goal ?? "",
            description: input.description ?? "",
            priority: input.priority ?? "p2",
            dueDate: input.dueDate ?? null,
        }
        this.db
            .prepare(
                `
            INSERT INTO tasks (title, jira_keys, goal, description, priority, due_date, created_at, updated_at)
            VALUES (
                @title,
                @jiraKeys,
                @goal,
                @description,
                @priority,
                @dueDate,
                @createdAt,
                @updatedAt
            );
        `,
            )
            .run({
                title: task.title,
                jiraKeys: JSON.stringify(task.jiraKeys),
                goal: task.goal,
                description: task.description,
                priority: task.priority,
                dueDate: task.dueDate,
                createdAt: now,
                updatedAt: now,
            })
    }

    updateTask(input: UpdateTaskInput): void {
        const assignments: string[] = []
        const parameters: Record<string, SQLInputValue> = {
            title: input.title,
            updatedAt: new Date().toISOString(),
        }

        if (input.jiraKeys !== undefined) {
            assignments.push("jira_keys = @jiraKeys")
            parameters.jiraKeys = JSON.stringify(input.jiraKeys)
        }
        if (input.goal !== undefined) {
            assignments.push("goal = @goal")
            parameters.goal = input.goal
        }
        if (input.description !== undefined) {
            assignments.push("description = @description")
            parameters.description = input.description
        }
        if (input.status !== undefined) {
            assignments.push("status = @status")
            parameters.status = input.status
        }
        if (input.priority !== undefined) {
            assignments.push("priority = @priority")
            parameters.priority = input.priority
        }
        if (input.progress !== undefined) {
            assignments.push("progress = @progress")
            parameters.progress = input.progress
        }
        if (input.summary !== undefined) {
            assignments.push("summary = @summary")
            parameters.summary = input.summary
        }
        if (input.nextAction !== undefined) {
            assignments.push("next_action = @nextAction")
            parameters.nextAction = input.nextAction
        }
        if (input.blocker !== undefined) {
            assignments.push("blocker = @blocker")
            parameters.blocker = input.blocker
        }
        if (input.dueDate !== undefined) {
            assignments.push("due_date = @dueDate")
            parameters.dueDate = input.dueDate
        }

        if (assignments.length === 0) {
            throw new Error("At least one task field must be provided")
        }

        assignments.push("revision = revision + 1", "updated_at = @updatedAt")
        const result = this.db
            .prepare(
                `
            UPDATE tasks
            SET ${assignments.join(", ")}
            WHERE title = @title
        `,
            )
            .run(parameters)

        if (result.changes !== 1) {
            throw new Error("No task found with the given title")
        }
    }

    listTasks(input: ListTasksInput = {}): Task[] {
        const conditions: string[] = []
        const parameters: Record<string, SQLInputValue> = {}

        if (input.status !== undefined) {
            conditions.push("status = @status")
            parameters.status = input.status
        }
        if (input.title !== undefined) {
            conditions.push("title = @title")
            parameters.title = input.title
        }
        if (input.priority !== undefined) {
            conditions.push("priority = @priority")
            parameters.priority = input.priority
        }
        if (input.dueDate !== undefined) {
            conditions.push("due_date = @dueDate")
            parameters.dueDate = input.dueDate
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
        const rows = this.db
            .prepare(
                `
            SELECT jira_keys, title, goal, description, status, priority, progress,
                   summary, next_action, blocker, due_date, revision, created_at, updated_at
            FROM tasks
            ${whereClause}
        `,
            )
            .all(parameters) as unknown as TaskRow[]

        return rows.map(toTask)
    }

    delTask(input: DelTaskInput): void {
        this.db.exec("BEGIN")
        try {
            this.db
                .prepare(
                    `
                DELETE FROM session_bindings
                WHERE task_title = @title
            `,
                )
                .run({ title: input.title })

            const result = this.db
                .prepare(
                    `
                DELETE FROM tasks
                WHERE title = @title
            `,
                )
                .run({ title: input.title })

            if (result.changes === 0) {
                throw new Error("No task found with the given title")
            }

            this.db.exec("COMMIT")
        } catch (error) {
            this.db.exec("ROLLBACK")
            throw error
        }
    }

    bindTask(input: BindTaskInput, metadata: BindTaskMetadata): void {
        const now = new Date().toISOString()
        this.db
            .prepare(
                `
            INSERT INTO session_bindings (
                session_id,
                task_title,
                session_file,
                cwd,
                active,
                bound_at,
                unbound_at,
                binding_baseline_entry_id,
                last_summarized_entry_id
            )
            VALUES (
                @sessionId,
                @title,
                @sessionFile,
                @cwd,
                1,
                @boundAt,
                NULL,
                @bindingBaselineEntryId,
                @bindingBaselineEntryId
            )
        `,
            )
            .run({
                title: input.title,
                sessionId: input.sessionId,
                sessionFile: metadata.sessionFile,
                cwd: metadata.cwd,
                boundAt: now,
                bindingBaselineEntryId: metadata.bindingBaselineEntryId,
            })
    }

    applySummaryAndAdvanceWatermark(input: ApplySummaryInput): boolean {
        this.db.exec("BEGIN")
        try {
            if (input.shouldUpdateTask) {
                const assignments: string[] = []
                const parameters: Record<string, SQLInputValue> = {
                    title: input.title,
                    expectedRevision: input.expectedRevision,
                    updatedAt: new Date().toISOString(),
                }

                if (input.patch.status !== undefined) {
                    assignments.push("status = @status")
                    parameters.status = input.patch.status
                }
                if (input.patch.priority !== undefined) {
                    assignments.push("priority = @priority")
                    parameters.priority = input.patch.priority
                }
                if (input.patch.progress !== undefined) {
                    assignments.push("progress = @progress")
                    parameters.progress = input.patch.progress
                }
                if (input.patch.summary !== undefined) {
                    assignments.push("summary = @summary")
                    parameters.summary = input.patch.summary
                }
                if (input.patch.nextAction !== undefined) {
                    assignments.push("next_action = @nextAction")
                    parameters.nextAction = input.patch.nextAction
                }
                if (input.patch.blocker !== undefined) {
                    assignments.push("blocker = @blocker")
                    parameters.blocker = input.patch.blocker
                }

                assignments.push("revision = revision + 1", "updated_at = @updatedAt")
                const taskResult = this.db
                    .prepare(
                        `
                    UPDATE tasks
                    SET ${assignments.join(", ")}
                    WHERE title = @title AND revision = @expectedRevision
                `,
                    )
                    .run(parameters)
                if (taskResult.changes !== 1) {
                    this.db.exec("ROLLBACK")
                    return false
                }
            }

            const bindingResult = this.db
                .prepare(
                    `
                UPDATE session_bindings
                SET last_summarized_entry_id = @endEntryId
                WHERE session_id = @sessionId
                  AND task_title = @title
                  AND active = 1
                  AND last_summarized_entry_id = @expectedLastSummarizedEntryId
            `,
                )
                .run({
                    sessionId: input.sessionId,
                    title: input.title,
                    endEntryId: input.endEntryId,
                    expectedLastSummarizedEntryId: input.expectedLastSummarizedEntryId,
                })
            if (bindingResult.changes !== 1) {
                this.db.exec("ROLLBACK")
                return false
            }

            this.db.exec("COMMIT")
            return true
        } catch (error) {
            this.db.exec("ROLLBACK")
            throw error
        }
    }
}

function toTask(row: TaskRow): Task {
    return {
        jiraKeys: JSON.parse(row.jira_keys) as string[],
        title: row.title,
        goal: row.goal,
        description: row.description,
        status: row.status,
        priority: row.priority,
        progress: row.progress,
        summary: row.summary,
        nextAction: row.next_action,
        blocker: row.blocker,
        dueDate: row.due_date,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

function toSessionBinding(row: SessionBindingRow): SessionBinding {
    return {
        sessionId: row.session_id,
        taskTitle: row.task_title,
        sessionFile: row.session_file,
        cwd: row.cwd,
        active: row.active === 1,
        boundAt: row.bound_at,
        unboundAt: row.unbound_at,
        bindingBaselineEntryId: row.binding_baseline_entry_id,
        lastSummarizedEntryId: row.last_summarized_entry_id,
    }
}
