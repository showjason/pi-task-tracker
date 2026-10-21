import { TypeSafeClient, choice, type JsonValue, type Questions, type SystemOneRequest } from "@typesafe-ai/sdk"
import type { SummaryJob, SummaryReason } from "./type.ts"
import { summaryLogger } from "./logger.ts"

const QUESTIONS = {
    summary_needed: choice(
        {
            question: "Should a summary agent process `increments` for this task?",
            decision_rule: [
                "First determine whether `increments` are directly relevant to `task.goal`.",
                "Only then determine whether they materially change the task state or progress toward that goal.",
                "Ignore information unrelated to `task.goal`, even if it describes a technical change, blocker, next step, or finding.",
            ],
            compare: ["task.goal", "task.summary", "task.blocker", "task.nextAction", "increments"],
        },
        {
            changed: {
                what: "A material, goal-relevant update should be summarized.",
                includes: [
                    "Progress, a finding, or a root cause that advances or redefines task.goal",
                    "A goal-relevant blocker or next action that is resolved, replaced, or newly identified",
                    "An explicit change to task.goal",
                ],
            },
            unchanged: {
                what: "No material, goal-relevant update should be summarized.",
                includes: [
                    "Discussion or work unrelated to task.goal, even if it changes a technical detail, blocker, or next step",
                    "Restatements of information already in task state",
                    "Routine activity without a material conclusion, progress update, blocker, or next action",
                ],
            },
        },
    ),
} as const satisfies Questions

const GATED_REASONS: ReadonlySet<SummaryReason> = new Set(["turn", "timer"])

type GateState = {
    task: {
        goal: string
        blocker: string | null
        nextAction: string | null
        summary: string
    }
    increments: JsonValue[]
}

function buildGateState(job: SummaryJob): GateState {
    return {
        task: {
            goal: job.goal,
            blocker: job.blocker ?? null,
            nextAction: job.nextAction ?? null,
            summary: job.currentSummary ?? "",
        },
        increments: JSON.parse(JSON.stringify(job.entries)) as JsonValue[],
    }
}

function buildGatePrompt(job: SummaryJob): SystemOneRequest<typeof QUESTIONS> {
    return {
        state: buildGateState(job),
        questions: QUESTIONS,
    }
}

function isGateEligible(job: SummaryJob): boolean {
    if (GATED_REASONS.has(job.summaryReason)) {
        return true
    }
    return false
}

async function fetchDecision(job: SummaryJob): Promise<boolean> {
    const client = new TypeSafeClient()
    const response = await client.systemOne(buildGatePrompt(job))
    const decision = response.answers.summary_needed.choice === "changed" ? "enqueue" : "skip"
    return decision === "enqueue"
}

export async function gateChecker(job: SummaryJob): Promise<boolean> {
    if (!isGateEligible(job)) {
        return true
    }
    return fetchDecision(job)
}
