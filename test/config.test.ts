import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"

// config.ts reads process.env at import time and accumulates warnings in a
// module-level array, so every case must reset modules and re-import.

const ENV_KEYS = [
    "PI_CODING_AGENT_DIR",
    "TRACKER_HOME",
    "TURNS_THRESHOLD",
    "INITIAL_INTERVAL_MIN",
    "MAX_INTERVAL_MIN",
    "SUMMARIZER_MODEL",
    "SUMMARIZER_PROVIDER",
    "LOG_LEVEL",
    "LOG_DIR",
    "USE_GATE",
    "SUMMARY_TIMEOUT_MS",
] as const

const savedEnv: Record<string, string | undefined> = {}

async function loadConfig() {
    vi.resetModules()
    return import("../src/config.ts")
}

beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
    }
})

describe("tracker config", () => {
    it("falls back to defaults when no env is set", async () => {
        for (const key of ENV_KEYS) delete process.env[key]

        const { trackerConfig, getConfigWarnings } = await loadConfig()

        expect(getConfigWarnings()).toEqual([])
        expect(trackerConfig.turnsThreshold).toBe(3)
        expect(trackerConfig.initialIntervalMin).toBe(30)
        expect(trackerConfig.maxIntervalMin).toBe(120)
        expect(trackerConfig.useGate).toBe(false)
        expect(trackerConfig.summaryTimeoutMs).toBe(60_000)
        expect(trackerConfig.summarizerModel).toBe("DeepSeek-V4-Flash")
        expect(trackerConfig.summarizerProvider).toBe("openai")
        expect(trackerConfig.trackerHome).toBe(join(homedir(), ".pi", "agent", "tracker"))
        expect(trackerConfig.logDir).toBe(join(homedir(), ".pi", "agent", "tracker", "logs"))
    })

    it("accepts valid env overrides", async () => {
        process.env.TURNS_THRESHOLD = "5"
        process.env.INITIAL_INTERVAL_MIN = "15"
        process.env.MAX_INTERVAL_MIN = "90"
        process.env.USE_GATE = "true"
        process.env.SUMMARY_TIMEOUT_MS = "2000"

        const { trackerConfig, getConfigWarnings } = await loadConfig()

        expect(getConfigWarnings()).toEqual([])
        expect(trackerConfig.turnsThreshold).toBe(5)
        expect(trackerConfig.initialIntervalMin).toBe(15)
        expect(trackerConfig.maxIntervalMin).toBe(90)
        expect(trackerConfig.useGate).toBe(true)
        expect(trackerConfig.summaryTimeoutMs).toBe(2000)
    })

    it.each(["abc", "0", "-1", "1.5"])(
        "rejects invalid TURNS_THRESHOLD=%s with a warning and keeps the default",
        async (raw) => {
            process.env.TURNS_THRESHOLD = raw

            const { trackerConfig, getConfigWarnings } = await loadConfig()

            expect(trackerConfig.turnsThreshold).toBe(3)
            expect(getConfigWarnings()).toEqual([`TURNS_THRESHOLD must be a positive integer (got "${raw}")`])
        },
    )

    it("rejects invalid USE_GATE with a warning and keeps the default", async () => {
        process.env.USE_GATE = "yes"

        const { trackerConfig, getConfigWarnings } = await loadConfig()

        expect(trackerConfig.useGate).toBe(false)
        expect(getConfigWarnings()).toEqual([`USE_GATE must be a boolean (got "yes")`])
    })

    it("derives the database path from TRACKER_HOME", async () => {
        process.env.TRACKER_HOME = "/tmp/tracker-home-x"

        const { trackerConfig } = await loadConfig()

        expect(trackerConfig.trackerHome).toBe("/tmp/tracker-home-x")
        expect(trackerConfig.database).toBe("/tmp/tracker-home-x/tracker.db")
        expect(trackerConfig.logDir).toBe("/tmp/tracker-home-x/logs")
    })

    it("uses PI_CODING_AGENT_DIR when TRACKER_HOME is not set", async () => {
        process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent"

        const { trackerConfig } = await loadConfig()

        expect(trackerConfig.trackerHome).toBe("/tmp/pi-agent/tracker")
        expect(trackerConfig.logDir).toBe("/tmp/pi-agent/tracker/logs")
    })

    it("rejects an invalid LOG_LEVEL with a warning and keeps the default", async () => {
        process.env.LOG_LEVEL = "verbose"

        const { trackerConfig, getConfigWarnings } = await loadConfig()

        expect(trackerConfig.logLevel).toBe("info")
        expect(getConfigWarnings()).toEqual(['LOG_LEVEL must be one of error, warn, info, debug (got "verbose")'])
    })
})
