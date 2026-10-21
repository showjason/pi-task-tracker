import { join } from "node:path"
import { trackerConfig } from "./config.ts"
import { appendFileSync, mkdirSync } from "node:fs"

const LEVELS: Record<string, number> = {
    error: 10,
    warn: 20,
    info: 30,
    debug: 40,
}

const CURRENT_LOG_LEVEL: number = LEVELS[trackerConfig.logLevel] ?? LEVELS.info

export type LogLevel = "error" | "warn" | "info" | "debug"

/** tracker event names (session lifecycle / turn count / timer / task tools) */
export type TrackerEvent =
    | "session_started"
    | "session_shutdown"
    | "agent_turn_started"
    | "agent_turn_completed"
    | "turn_threshold_reached"
    | "summary_timer_scheduled"
    | "summary_timer_fired"
    | "task_created"
    | "task_bound"
    | "task_deleted"
    | "tracker_config_invalid"

/** summarize event names (full lifecycle of SummaryJob) */
export type SummaryEvent =
    // —— trigger ——
    | "summary_triggered" // reason: turn|timer|fork|tree|switch|quit
    | "summary_noop" // trigger produced no job (cause: no_binding|task_deleted|no_increment|watermark_off_branch)
    // —— gate ——
    | "gate_eval_started"
    | "gate_decision" // decision: "enqueue" | "skip"
    | "gate_failed"
    | "gate_bypassed" //（quit/fork/tree/switch）bypassed
    // —— job and queue ——
    | "summary_job_created"
    | "summary_job_enqueued"
    | "summary_job_duplicate" // endEntryId enqueued already
    | "summary_job_skipped_by_gate" // gate return skip，only update watermark
    // —— agent ——
    | "summary_job_started" // consumer dequeued the job
    | "summary_agent_spawned"
    | "summary_agent_completed"
    | "summary_job_failed"
    // —— DB ——
    | "summary_db_applied" // applySummaryAndAdvanceWatermark success
    | "summary_db_conflict" // CAS failed (revision/watermark mismatch)
    // —— shutdown ——
    | "summary_stop_timeout"
    | "queue_closed"

export type LogDetail = Record<string, unknown>
type Channel = "tracker" | "summary"

export type TrackerLogger = {
    [K in LogLevel]: (event: TrackerEvent, detail?: LogDetail) => void
} & { child(extraContext: Record<string, unknown>): TrackerLogger }

export type SummaryLogger = {
    [K in LogLevel]: (event: SummaryEvent, detail?: LogDetail) => void
} & { child(extraContext: Record<string, unknown>): SummaryLogger }

class ChannelLogger {
    private channel: Channel
    private logDir: string
    private context: Record<string, unknown>
    private dirReady: boolean = false

    constructor(channel: Channel, logDir: string, context: Record<string, unknown> = {}) {
        this.channel = channel
        this.logDir = logDir
        this.context = context
    }

    child(extraContext: Record<string, unknown>): ChannelLogger {
        return new ChannelLogger(this.channel, this.logDir, { ...this.context, ...extraContext })
    }

    private write(level: LogLevel, event: string, detail?: LogDetail): void {
        if (LEVELS[level] > CURRENT_LOG_LEVEL) return
        try {
            if (!this.dirReady) {
                mkdirSync(join(this.logDir, this.channel), { recursive: true })
                this.dirReady = true
            }
            const now = new Date()
            const date = now.toISOString().slice(0, 10).replace(/-/g, "") // YYYY-MM-DD
            const logFile = join(this.logDir, this.channel, `${date}.log`)
            const entry = {
                timestamp: now.toISOString(),
                level,
                event,
                ...this.context,
                ...detail,
            }
            appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8")
        } catch (error) {
            console.error(`logger ${this.channel} failed to write log:`, error)
        }
    }

    error(event: string, detail?: LogDetail): void {
        this.write("error", event, detail)
    }

    warn(event: string, detail?: LogDetail): void {
        this.write("warn", event, detail)
    }

    info(event: string, detail?: LogDetail): void {
        this.write("info", event, detail)
    }

    debug(event: string, detail?: LogDetail): void {
        this.write("debug", event, detail)
    }
}

export const trackerLogger: TrackerLogger = new ChannelLogger("tracker", trackerConfig.logDir)
export const summaryLogger: SummaryLogger = new ChannelLogger("summary", trackerConfig.logDir)
