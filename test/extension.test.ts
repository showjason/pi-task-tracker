import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest"
import { initSchema, TaskManager } from "../src/sqlite.ts"
import type { JobQueue } from "../src/tracker.ts"
import type { SummaryJob } from "../src/type.ts"
import {
    type FakeApi,
    assistantEntry,
    branchFixture,
    createFakeApi,
    createFakeContext,
    createFakeSessionManager,
    userEntry,
} from "./helpers.ts"

// index.ts reads trackerConfig at import time and starts a real Summarizer
// consumer loop, so each case runs in its own TRACKER_HOME temp dir and
// re-imports the factory fresh.

const ENV_KEYS = [
    "TRACKER_HOME",
    "TURNS_THRESHOLD",
    "INITIAL_INTERVAL_MIN",
    "MAX_INTERVAL_MIN",
    "USE_GATE",
    "SUMMARY_TIMEOUT_MS",
] as const
const savedEnv: Record<string, string | undefined> = {}

let tempDir: string

beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tracker-ext-test-"))
    process.env.TRACKER_HOME = tempDir
    process.env.TURNS_THRESHOLD = "1"
    process.env.SUMMARY_TIMEOUT_MS = "1000"
    delete process.env.USE_GATE
})

afterEach(() => {
    // Drop any vi.doMock registered by a test so later loadExtension()
    // calls import the real module (resetModules does not clear the mock
    // registry).
    vi.doUnmock("../src/summary.ts")
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
    }
    rmSync(tempDir, { recursive: true, force: true })
})

async function loadExtension() {
    vi.resetModules()
    return (await import("../index.ts")).default
}

/** A settled branch with an increment past the baseline. */
function settledBranch() {
    return [...branchFixture("q1", "a1"), assistantEntry("final answer")]
}

/**
 * Replace the real Summarizer with a fake that delegates each job to `run`
 * instead of spawning a `pi` child (~5s LLM round trip). The real child
 * races the quit fast-lane's child on the same watermark and can exceed the
 * 10s test timeout, so jobs are observed through the fake instead.
 */
function mockSummarizer(run: (job: SummaryJob) => void | Promise<void>, onStop?: () => void) {
    vi.doMock("../src/summary.ts", () => ({
        Summarizer: class {
            private readonly queue: JobQueue
            private consumer: Promise<void> | undefined

            constructor(options: { jobQueue: JobQueue }) {
                this.queue = options.jobQueue
            }

            start(): void {
                this.consumer = this.consume()
            }

            async runSummaryAgent(job: SummaryJob): Promise<void> {
                await run(job)
            }

            async stopAndWait(): Promise<void> {
                onStop?.()
                this.queue.close()
                await this.consumer
            }

            private async consume(): Promise<void> {
                while (true) {
                    const job = await this.queue.dequeue()
                    if (job === undefined) return
                    await run(job)
                    this.queue.complete(job)
                }
            }
        },
    }))
}

describe("tracker extension factory", () => {
    it("throws on invalid config and notifies the user via session_start", async () => {
        process.env.TURNS_THRESHOLD = "not-a-number"
        const fakeApi = createFakeApi()
        const factory = await loadExtension()

        expect(() => factory(fakeApi.api)).toThrow("Invalid tracker configuration")

        const ctx = createFakeContext(createFakeSessionManager(), { hasUI: true })
        ctx.ui.notify = vi.fn()
        await fakeApi.emit("session_start", ctx)
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tracker start failed"))
    })

    it("registers the full event, command, and tool surface", async () => {
        const fakeApi = createFakeApi()
        const factory = await loadExtension()
        factory(fakeApi.api)

        expect([...fakeApi.handlers.keys()].sort()).toEqual(
            [
                "agent_settled",
                "agent_start",
                "session_before_fork",
                "session_before_switch",
                "session_before_tree",
                "session_shutdown",
                "session_start",
            ].sort(),
        )
        expect([...fakeApi.commands.keys()]).toEqual(["tasks"])
        expect([...fakeApi.tools.keys()].sort()).toEqual(["tracker_bind_task", "tracker_create_task"])
    })

    it('flushes with reason "fork" when session_before_fork fires', async () => {
        const summaryJobs: SummaryJob[] = []
        mockSummarizer((job) => {
            summaryJobs.push(job)
        })
        const fakeApi = createFakeApi()
        const factory = await loadExtension()
        factory(fakeApi.api)

        // Seed a bound session directly in the extension's own database.
        const db = new DatabaseSync(join(tempDir, "tracker.db"))
        try {
            initSchema(db)
            const taskManager = new TaskManager(db)
            taskManager.createTask({ title: "deploy-api" })
            const branch = settledBranch()
            taskManager.bindTask(
                { sessionId: "session-1", title: "deploy-api" },
                { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: branch[0]!.id },
            )

            await fakeApi.emit(
                "session_before_fork",
                createFakeContext(createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", branch })),
            )

            // Shut down on an unbound session: the quit fast-lane is a no-op
            // and stopAndWait only closes the queue, so nothing but the fork
            // job can reach summaryJobs.
            await fakeApi.emit(
                "session_shutdown",
                createFakeContext(
                    createFakeSessionManager({ sessionId: "session-2", sessionFile: "/sessions/s2.jsonl" }),
                ),
            )

            expect(summaryJobs).toHaveLength(1)
            expect(summaryJobs[0]!.summaryReason).toBe("fork")
            expect(summaryJobs[0]!.endEntryId).toBe(branch.at(-1)!.id)
        } finally {
            db.close()
        }
    })

    it("drains the queue and stops the summarizer on session_shutdown", async () => {
        // Seed a bound session directly in the extension's own database.
        const db = new DatabaseSync(join(tempDir, "tracker.db"))
        try {
            initSchema(db)
            const taskManager = new TaskManager(db)
            taskManager.createTask({ title: "deploy-api" })
            const branch = settledBranch()
            taskManager.bindTask(
                { sessionId: "session-1", title: "deploy-api" },
                { sessionFile: "/sessions/s1.jsonl", cwd: "/tmp", bindingBaselineEntryId: branch[0]!.id },
            )

            // The fake defers the DB write like a real child process, so
            // this only passes if the shutdown handler awaits the quit
            // flush before draining (docs/issues/shutdown-flush-does-not-drain.md).
            const calls: string[] = []
            mockSummarizer(
                async (job) => {
                    calls.push(`run:${job.summaryReason}`)
                    await new Promise((resolve) => setImmediate(resolve))
                    taskManager.applySummaryAndAdvanceWatermark({
                        sessionId: job.sessionId,
                        title: job.taskTitle,
                        expectedRevision: job.expectedRevision,
                        expectedLastSummarizedEntryId: job.lastSummarizedEntryId ?? "",
                        endEntryId: job.endEntryId,
                        shouldUpdateTask: false,
                        patch: {},
                    })
                },
                () => {
                    calls.push("stopAndWait")
                },
            )
            const fakeApi = createFakeApi()
            const factory = await loadExtension()
            factory(fakeApi.api)

            await fakeApi.emit(
                "session_shutdown",
                createFakeContext(createFakeSessionManager({ sessionFile: "/sessions/s1.jsonl", branch })),
            )

            expect(calls).toEqual(["run:quit", "stopAndWait"])
            const binding = taskManager.getActiveBinding("session-1")
            expect(binding).toBeDefined()
            expect(binding!.lastSummarizedEntryId).toBe(branch.at(-1)!.id)
        } finally {
            db.close()
        }
    })
})

void userEntry
