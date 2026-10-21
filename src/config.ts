import { homedir } from "node:os"
import { join } from "node:path"

const configWarnings: string[] = []
const logLevels = ["error", "warn", "info", "debug"] as const
type LogLevel = (typeof logLevels)[number]

const piAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")
const trackerHome = process.env.TRACKER_HOME || join(piAgentDir, "tracker")

function positiveInteger(name: string, defaultValue: number): number {
    const raw = process.env[name]
    if (raw === undefined) return defaultValue

    const value = Number(raw)
    if (Number.isSafeInteger(value) && value > 0) return value
    configWarnings.push(`${name} must be a positive integer (got "${raw}")`)
    return defaultValue
}

function booleanValue(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name]
    if (raw === undefined) return defaultValue

    const value = raw.toLowerCase()
    if (value === "true") return true
    if (value === "false") return false
    configWarnings.push(`${name} must be a boolean (got "${raw}")`)
    return defaultValue
}

function logLevel(name: string, defaultValue: LogLevel): LogLevel {
    const raw = process.env[name]
    if (raw === undefined) return defaultValue
    if ((logLevels as readonly string[]).includes(raw)) return raw as LogLevel
    configWarnings.push(`${name} must be one of ${logLevels.join(", ")} (got "${raw}")`)
    return defaultValue
}

export const trackerConfig = {
    trackerHome,
    database: join(trackerHome, "tracker.db"),
    turnsThreshold: positiveInteger("TURNS_THRESHOLD", 3),
    initialIntervalMin: positiveInteger("INITIAL_INTERVAL_MIN", 30),
    maxIntervalMin: positiveInteger("MAX_INTERVAL_MIN", 120),
    summarizerModel: process.env.SUMMARIZER_MODEL || "DeepSeek-V4-Flash",
    summarizerProvider: process.env.SUMMARIZER_PROVIDER || "openai",
    logLevel: logLevel("LOG_LEVEL", "info"),
    logDir: process.env.LOG_DIR || join(trackerHome, "logs"),
    useGate: booleanValue("USE_GATE", false),
    summaryTimeoutMs: positiveInteger("SUMMARY_TIMEOUT_MS", 60_000),
}

export function getConfigWarnings(): string[] {
    return configWarnings
}
