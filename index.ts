import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getConfigWarnings, trackerConfig } from "./src/config.ts"
import { trackerLogger } from "./src/logger.ts"
import { TaskManager, openDatabase } from "./src/sqlite.ts"
import { Summarizer } from "./src/summary.ts"
import { JobQueue, Tracker } from "./src/tracker.ts"
import registerBindTaskTool from "./src/tools/bind-task.ts"
import registerCreateTaskTool from "./src/tools/create-task.ts"
import registerTaskListCommand from "./src/commands/tasks.ts"

export default function (pi: ExtensionAPI) {
    const configWarnings = getConfigWarnings()
    if (configWarnings.length > 0) {
        trackerLogger.error("tracker_config_invalid", { warnings: configWarnings })
        startTrackerError(pi, configWarnings.join("; "))
        throw new Error(`Invalid tracker configuration: ${configWarnings.join("; ")}`)
    }

    // Initialize the database and task manager
    const database = openDatabase(trackerConfig.database)
    const taskManager = new TaskManager(database)

    // Register task management commands
    registerTaskListCommand(pi, taskManager)

    // Register task management tools for the main-session LLM
    registerCreateTaskTool(pi, taskManager)
    registerBindTaskTool(pi, taskManager)

    // Start the tracker
    const jobQueue = new JobQueue()
    const summarizer = new Summarizer({
        summarizerProvider: trackerConfig.summarizerProvider,
        summarizerModel: trackerConfig.summarizerModel,
        jobQueue,
    })
    summarizer.start()

    const tracker = new Tracker({
        taskManager,
        jobQueue,
        summarizer,
        turnsThreshold: trackerConfig.turnsThreshold,
        initialIntervalMin: trackerConfig.initialIntervalMin,
        maxIntervalMin: trackerConfig.maxIntervalMin,
        useGate: trackerConfig.useGate,
    })

    pi.on("session_start", async (_event, ctx) => {
        tracker.start(ctx)
    })

    pi.on("agent_start", async (_event, ctx) => {
        tracker.onAgentStart(ctx)
    })

    pi.on("agent_settled", async (_event, ctx) => {
        tracker.onAgentSettled(ctx)
    })

    pi.on("session_before_tree", async (_event, ctx) => {
        tracker.flush(ctx, "tree")
    })

    pi.on("session_before_fork", async (_event, ctx) => {
        tracker.flush(ctx, "fork")
    })

    pi.on("session_before_switch", async (_event, ctx) => {
        tracker.flush(ctx, "switch")
    })

    pi.on("session_shutdown", async (_event, ctx) => {
        await tracker.flush(ctx, "quit")
        await summarizer.stopAndWait(trackerConfig.summaryTimeoutMs)
        tracker.shutDown()
    })
}

function startTrackerError(pi: ExtensionAPI, message: string) {
    pi.on("session_start", async (_event, ctx) => {
        if (ctx.hasUI) {
            ctx.ui.notify(`tracker start failed: ${String(message)}`)
        }
    })
}
