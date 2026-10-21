import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionCommandContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { initSchema, TaskManager } from "../src/sqlite.ts"

// ---------------------------------------------------------------------------
// Harness: real SQLite in a temp dir (pi style: beforeEach temp dir + cleanup)
// ---------------------------------------------------------------------------

export interface Harness {
    taskManager: TaskManager
    db: DatabaseSync
    tempDir: string
    cleanup: () => void
}

export function createHarness(): Harness {
    const tempDir = mkdtempSync(join(tmpdir(), "tracker-test-"))
    const db = new DatabaseSync(join(tempDir, "tracker.db"))
    initSchema(db)
    return {
        taskManager: new TaskManager(db),
        db,
        tempDir,
        cleanup: () => {
            db.close()
            rmSync(tempDir, { recursive: true, force: true })
        },
    }
}

// ---------------------------------------------------------------------------
// Capturing fake ExtensionAPI (pi style: capture handlers, drive them by hand)
// ---------------------------------------------------------------------------

type EventHandler = (event: never, ctx: ExtensionContext) => unknown
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => unknown

export interface FakeApi {
    api: ExtensionAPI
    handlers: Map<string, EventHandler[]>
    commands: Map<string, CommandHandler>
    tools: Map<string, { name: string }>
    appendedEntries: Array<{ customType: string; data: unknown }>
    emit(event: string, ctx: ExtensionContext): Promise<unknown[]>
    runCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<unknown>
}

export function createFakeApi(): FakeApi {
    const handlers = new Map<string, EventHandler[]>()
    const commands = new Map<string, CommandHandler>()
    const tools = new Map<string, { name: string }>()
    const appendedEntries: Array<{ customType: string; data: unknown }> = []

    const api = {
        on(event: string, handler: EventHandler) {
            const list = handlers.get(event) ?? []
            list.push(handler)
            handlers.set(event, list)
        },
        registerCommand(name: string, command: { handler: CommandHandler }) {
            commands.set(name, command.handler)
        },
        registerTool(tool: { name: string }) {
            tools.set(tool.name, tool)
        },
        appendEntry(customType: string, data: unknown) {
            appendedEntries.push({ customType, data })
        },
    } as unknown as ExtensionAPI

    return {
        api,
        handlers,
        commands,
        tools,
        appendedEntries,
        async emit(event: string, ctx: ExtensionContext) {
            const list = handlers.get(event) ?? []
            return Promise.all(list.map((handler) => handler({ type: event } as never, ctx)))
        },
        async runCommand(name: string, args: string, ctx: ExtensionCommandContext) {
            const handler = commands.get(name)
            if (handler === undefined) throw new Error(`Missing command: ${name}`)
            return handler(args, ctx)
        },
    }
}

// ---------------------------------------------------------------------------
// Fake session manager + contexts
// ---------------------------------------------------------------------------

export interface FakeSessionManagerOptions {
    sessionId?: string
    sessionFile?: string
    leafId?: string | null
    branch?: SessionEntry[]
    cwd?: string
}

export function createFakeSessionManager(options: FakeSessionManagerOptions = {}) {
    const sessionId = options.sessionId ?? "session-1"
    const branch = options.branch ?? []
    return {
        getSessionId: () => sessionId,
        getSessionFile: () => options.sessionFile,
        getLeafId: () => options.leafId ?? null,
        getCwd: () => options.cwd ?? "/tmp/project",
        getBranch: () => branch,
        getLeafEntry: () => branch.at(-1),
    }
}

export function createFakeContext(
    sessionManager: ReturnType<typeof createFakeSessionManager>,
    options: { hasUI?: boolean; mode?: "tui" | "print" | "rpc" } = {},
): ExtensionContext {
    const hasUI = options.hasUI ?? false
    return {
        mode: options.mode ?? "tui",
        hasUI,
        ui: hasUI
            ? {
                  notify: () => {},
                  setWidget: () => {},
                  custom: () => {},
              }
            : {},
        cwd: "/tmp/project",
        sessionManager,
    } as unknown as ExtensionContext
}

// ---------------------------------------------------------------------------
// Session entry fixtures (pi style: assistantMsg/userMsg constructors)
// ---------------------------------------------------------------------------

let entryCounter = 0

export function userEntry(text: string): SessionEntry {
    return {
        type: "message",
        id: `entry-${++entryCounter}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: text, timestamp: Date.now() },
    } as SessionEntry
}

export function assistantEntry(text: string, stopReason: "stop" | "aborted" | "error" = "stop"): SessionEntry {
    return {
        type: "message",
        id: `entry-${++entryCounter}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test",
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason,
            timestamp: Date.now(),
        },
    } as SessionEntry
}

/** Build a branch of alternating user/assistant entries with stable ids. */
export function branchFixture(...texts: string[]): SessionEntry[] {
    return texts.map((text, index) => (index % 2 === 0 ? userEntry(text) : assistantEntry(text)))
}

/** Race a promise against a short timeout to prove no job was produced. */
export async function expectPending(promise: Promise<unknown>, ms = 50): Promise<void> {
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))
    expect(await Promise.race([promise, timeout])).toBe("timeout")
}
