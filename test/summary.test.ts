import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SummaryLogger } from "../src/logger.ts"
import type { SummaryJob } from "../src/type.ts"
import type { JobQueue } from "../src/tracker.ts"

type MockChildProcess = ChildProcess & { stdout: PassThrough; stderr: PassThrough }

const job: SummaryJob = {
    sessionId: "session-1",
    taskTitle: "deploy-api",
    goal: "ship it",
    nextAction: null,
    blocker: null,
    expectedRevision: 1,
    lastSummarizedEntryId: "e1",
    currentSummary: "Initial work is complete.",
    entries: [],
    summaryReason: "turn",
    endEntryId: "e2",
}

function createChild(): MockChildProcess {
    const child = new EventEmitter() as MockChildProcess
    Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
    })
    return child
}

function createLogger(): SummaryLogger {
    return {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
    }
}

async function loadSummarizer(child: ChildProcess) {
    const spawn = vi.fn(() => child)
    vi.doMock("node:child_process", () => ({ spawn }))
    const { Summarizer } = await import("../src/summary.ts")
    return new Summarizer({
        summarizerProvider: "test-provider",
        summarizerModel: "test-model",
        jobQueue: {} as JobQueue,
    })
}

afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock("node:child_process")
})

describe("Summarizer", () => {
    it("escalates cancellation from SIGTERM to SIGKILL after five seconds", async () => {
        vi.useFakeTimers()
        const child = createChild()
        const summarizer = await loadSummarizer(child)
        const completion = summarizer.runSummaryAgent(job, createLogger())

        summarizer.cancel()
        expect(child.kill).toHaveBeenCalledWith("SIGTERM")

        await vi.advanceTimersByTimeAsync(5_000)
        expect(child.kill).toHaveBeenCalledWith("SIGKILL")

        child.emit("close", 1, "SIGKILL")
        await expect(completion).rejects.toThrow("Summary agent exited with 1")
    })
})
