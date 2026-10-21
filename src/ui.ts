import type { TaskStatus, TaskPriority, Task, SessionBinding } from "./type.ts"
import type { Theme } from "@earendil-works/pi-coding-agent"
import {
    visibleWidth,
    truncateToWidth,
    matchesKey,
    wrapTextWithAnsi,
    type Component,
    type KeyId,
} from "@earendil-works/pi-tui"

const MAX_VISIBLE_TASKS = 10
const MAX_DETAIL_LINES = 20
const MAX_VISIBLE_SESSIONS = 3

type DelChoice = "delete" | "cancel"

export type TaskListItem = Omit<Task, "revision" | "createdAt" | "updatedAt"> & {
    sessions: readonly SessionBinding[]
}
export type DelTask = (title: string) => TaskListItem[]

// status
function statusIcon(status: TaskStatus, theme: Theme): string {
    switch (status) {
        case "in_progress":
            return theme.fg("accent", "⏳")
        case "pending":
            return theme.fg("warning", "🕒")
        case "todo":
            return theme.fg("accent", "📝")
        case "done":
            return theme.fg("success", "✅")
        case "blocked":
            return theme.fg("error", "⛔")
        default:
            return theme.fg("muted", "❓")
    }
}

// priority
function priorityLabel(priority: TaskPriority, theme: Theme): string {
    switch (priority) {
        case "p2":
            return theme.fg("success", "🟢")
        case "p1":
            return theme.fg("warning", "🟡")
        case "p0":
            return theme.fg("error", "🔴")
        default:
            return theme.fg("muted", "❓")
    }
}

// due date
function dueDateText(dueDate: string | null, status: TaskStatus, theme: Theme): string {
    if (dueDate === null) return ""
    if (status !== "done" && new Date(dueDate).getTime() < Date.now()) {
        return theme.fg("error", `⚠️ ${dueDate}`)
    }
    return theme.fg("muted", dueDate)
}

type TaskListAction =
    | { kind: "cancel" }
    | { kind: "move"; delta: -1 | 1 }
    | { kind: "confirm" }
    | { kind: "scroll"; delta: -1 | 1 }
    | { kind: "delete" }
    | { kind: "chooseDelete" }
    | { kind: "filter"; status: "all" | TaskStatus }

type TaskListBinding = {
    keys: readonly KeyId[]
    action: TaskListAction
}

const TASK_LIST_BINDINGS: readonly TaskListBinding[] = [
    { keys: ["q", "escape", "ctrl+c"], action: { kind: "cancel" } },
    { keys: ["up"], action: { kind: "move", delta: -1 } },
    { keys: ["down"], action: { kind: "move", delta: 1 } },
    { keys: ["return"], action: { kind: "confirm" } },
    { keys: ["j"], action: { kind: "scroll", delta: 1 } },
    { keys: ["k"], action: { kind: "scroll", delta: -1 } },
    { keys: ["d"], action: { kind: "delete" } },
    { keys: ["left", "right"], action: { kind: "chooseDelete" } },
    { keys: ["1"], action: { kind: "filter", status: "all" } },
    { keys: ["2"], action: { kind: "filter", status: "in_progress" } },
    { keys: ["3"], action: { kind: "filter", status: "pending" } },
    { keys: ["4"], action: { kind: "filter", status: "todo" } },
    { keys: ["5"], action: { kind: "filter", status: "done" } },
    { keys: ["6"], action: { kind: "filter", status: "blocked" } },
]

function findTaskListAction(input: string): TaskListAction | undefined {
    return TASK_LIST_BINDINGS.find((binding) => binding.keys.some((key) => matchesKey(input, key)))?.action
}

export class TaskListScreen implements Component {
    private tasks: TaskListItem[]
    private readonly activeTaskTitle: string | undefined
    private readonly onDelete: DelTask
    private readonly theme: Theme
    private readonly done: (result: string | null) => void

    private statusFilter: "all" | TaskStatus = "all"
    private selectedIndex = 0
    private expanded = false
    private detailScroll = 0
    private pendingDelete: TaskListItem | undefined
    private delChoice: DelChoice = "cancel"
    private notice: string | undefined

    constructor(
        tasks: TaskListItem[],
        theme: Theme,
        activeTaskTitle: string | undefined,
        onDelete: DelTask,
        done: (result: string | null) => void,
    ) {
        this.tasks = tasks
        this.theme = theme
        this.activeTaskTitle = activeTaskTitle
        this.onDelete = onDelete
        this.done = done
    }

    render(width: number): string[] {
        const filteredTasks = this.filterTasks()

        const lines: string[] = [this.theme.fg("dim", "Tasks List:"), ""]
        const selected = filteredTasks[this.selectedIndex]

        if (filteredTasks.length === 0) {
            lines.push(this.theme.fg("muted", "No matching tasks"))
        } else {
            for (const { task, index } of this.visibleRows(filteredTasks)) {
                lines.push(rowLine(task, index === this.selectedIndex, this.theme, width))
            }
            if (filteredTasks.length > MAX_VISIBLE_TASKS) {
                lines.push(this.theme.fg("dim", ` (${this.selectedIndex + 1}/${filteredTasks.length})`))
            }
        }

        if (this.expanded && selected !== undefined) {
            this.renderDetails(lines, selected, width)
        }
        this.renderNotice(lines, width)
        this.renderDelConfirmation(lines, width)

        //footer
        lines.push("")
        lines.push(
            this.theme.fg(
                "dim",
                this.pendingDelete === undefined
                    ? "  ↑/↓ select · Enter detail · j/k scroll · 1-6 filter · q quit"
                    : " ←/→ choose · Enter confirm · Esc cancel",
            ),
        )
        return lines
    }
    handleInput(input: string): void {
        const action = findTaskListAction(input)
        if (action === undefined) return

        if (this.pendingDelete !== undefined) {
            this.handleDeleteConfirmation(action)
            return
        }

        switch (action.kind) {
            case "cancel":
                this.done(null)
                break
            case "move":
                this.moveSelection(action.delta)
                break
            case "confirm":
                this.expanded = !this.expanded
                this.detailScroll = 0
                break
            case "scroll":
                if (this.expanded) {
                    this.detailScroll = Math.max(0, this.detailScroll + action.delta)
                }
                break
            case "delete":
                this.requestDelete()
                break
            case "filter":
                this.selectFilter(action.status)
                break
            case "chooseDelete":
                break
        }
    }

    invalidate(): void {}

    private selectFilter(status: "all" | TaskStatus): void {
        this.statusFilter = status
        this.selectedIndex = 0
        this.expanded = false
        this.detailScroll = 0
        this.notice = undefined
    }

    private handleDeleteConfirmation(action: TaskListAction): void {
        switch (action.kind) {
            case "cancel":
                this.cancelDelete()
                break
            case "chooseDelete":
                this.delChoice = this.delChoice === "cancel" ? "delete" : "cancel"
                break
            case "confirm":
                if (this.delChoice === "delete") {
                    this.confirmDelete()
                } else {
                    this.cancelDelete()
                }
                break
            default:
                break
        }
    }

    private requestDelete(): void {
        const selected = this.filterTasks()[this.selectedIndex]
        if (selected === undefined) {
            this.notice = " No task selected"
            return
        }
        if (selected.title === this.activeTaskTitle) {
            this.notice = ` Cannot delete this active task ${selected.title} bound to the current session.`
            return
        }
        this.pendingDelete = selected
        this.delChoice = "cancel"
        this.notice = undefined
    }

    private confirmDelete(): void {
        const task = this.pendingDelete
        if (task === undefined) {
            return
        }
        this.tasks = this.onDelete(task.title)
        this.pendingDelete = undefined
        this.delChoice = "cancel"
        this.expanded = false
        this.detailScroll = 0
        this.notice = `Deleted task ${task.title}`
        this.clampSelectedIndex()
    }

    private cancelDelete(): void {
        this.pendingDelete = undefined
        this.delChoice = "cancel"
    }

    private filterTasks(): TaskListItem[] {
        return this.statusFilter === "all" ? this.tasks : this.tasks.filter((task) => task.status === this.statusFilter)
    }

    private renderDetails(lines: string[], selected: TaskListItem, width: number): void {
        const detailLines = details(selected, this.theme, width)
        const maxScroll = Math.max(0, detailLines.length - MAX_DETAIL_LINES)
        const scroll = Math.min(this.detailScroll, maxScroll)
        lines.push(...detailLines.slice(scroll, scroll + MAX_DETAIL_LINES))
        if (detailLines.length > MAX_DETAIL_LINES) {
            const shown = Math.min(scroll + MAX_DETAIL_LINES, detailLines.length)
            lines.push(this.theme.fg("dim", ` details ${scroll + 1}-${shown}/${detailLines.length} · j/k scroll`))
        }
    }

    private renderNotice(lines: string[], width: number): void {
        if (this.notice !== undefined) {
            lines.push(this.theme.fg("warning", truncateToWidth(this.notice, width, "...")))
        }
    }

    private renderDelConfirmation(lines: string[], width: number): void {
        const task = this.pendingDelete
        if (task === undefined) return
        const DelOption = this.delChoice === "delete" ? this.theme.fg("error", "[Delete]") : "[Delete]"
        const CancelOption = this.delChoice === "cancel" ? this.theme.fg("accent", "[Cancel]") : "[Cancel]"

        lines.push(this.theme.fg("error", truncateToWidth(`Delete task: ${task.title}`, width, "...")))
        lines.push(truncateToWidth(`${DelOption}  ${CancelOption}`, width, ""))
    }

    private visibleRows(filteredTasks: TaskListItem[]): Array<{ task: TaskListItem; index: number }> {
        const startIndex = Math.max(
            0,
            Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_TASKS / 2), filteredTasks.length - MAX_VISIBLE_TASKS),
        )
        const endIndex = Math.min(startIndex + MAX_VISIBLE_TASKS, filteredTasks.length)
        return filteredTasks.slice(startIndex, endIndex).map((task, i) => ({ task, index: startIndex + i }))
    }

    private moveSelection(delta: number): void {
        const filteredTasks =
            this.statusFilter === "all" ? this.tasks : this.tasks.filter((task) => task.status === this.statusFilter)
        if (filteredTasks.length === 0) return
        this.selectedIndex = (this.selectedIndex + delta + filteredTasks.length) % filteredTasks.length
        this.detailScroll = 0
    }

    private clampSelectedIndex(): void {
        const filteredTasks = this.filterTasks()
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filteredTasks.length - 1))
    }
}

function rowLine(task: TaskListItem, isSelected: boolean, theme: Theme, width: number): string {
    const icon = statusIcon(task.status, theme)
    const title = isSelected ? theme.fg("accent", task.title) : task.title
    const meta = [priorityLabel(task.priority, theme), dueDateText(task.dueDate, task.status, theme)]
        .filter((s) => s !== "")
        .join(" | ")
    const prefix = isSelected ? theme.fg("accent", "▸ ") : "  "
    const titleAva = Math.max(4, width - visibleWidth(prefix + icon) - visibleWidth(meta) - 1)
    return prefix + icon + " " + truncateToWidth(title, titleAva, "...") + " " + meta
}

// Wrap first, then color each line. wrapTextWithAnsi is ANSI-aware, so it also
// works on already-styled text without splitting escape sequences.
function detailField(
    label: string,
    value: string | null | undefined,
    theme: Theme,
    width: number,
    color?: "error" | "muted",
): string[] {
    const wrapped = wrapTextWithAnsi(value ?? "-", Math.max(8, width - visibleWidth(label)))
    const indent = " ".repeat(visibleWidth(label))
    return wrapped.map((line, i) => {
        const rendered = i === 0 ? label + line : indent + line
        return color === undefined ? rendered : theme.fg(color, rendered)
    })
}

function details(task: TaskListItem, theme: Theme, width: number): string[] {
    const lines: string[] = [theme.fg("accent", "Task Details:")]
    lines.push(...detailField("Goal:    ", task.goal, theme, width))
    lines.push(...detailField("Next:    ", task.nextAction, theme, width))
    lines.push(...detailField("Blocker: ", task.blocker, theme, width, "error"))
    lines.push(...detailField("Summary: ", task.summary, theme, width, "muted"))
    lines.push(...sessionDetails(task.sessions, theme, width))
    return lines
}

function sessionDetails(sessions: readonly SessionBinding[], theme: Theme, width: number): string[] {
    if (sessions.length === 0) {
        return detailField("Sessions: ", null, theme, width)
    }

    const visibleSessions = sessions.slice(0, MAX_VISIBLE_SESSIONS)
    const heading =
        sessions.length > MAX_VISIBLE_SESSIONS
            ? `Sessions (${visibleSessions.length} of ${sessions.length}):`
            : "Sessions:"
    const lines = [heading]

    for (const session of visibleSessions) {
        lines.push(...detailField("  sessid: ", session.sessionId, theme, width))
        lines.push(...detailField("  Cwd:   ", session.cwd, theme, width))
        lines.push(...detailField("  Bound: ", session.boundAt, theme, width))
    }

    return lines
}
