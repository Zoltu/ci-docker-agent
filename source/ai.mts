import type { LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { AiReviewResult } from "./review.mts"
import { buildAgentPrompt, type Agent } from "./agents.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { Log } from "./logger.mts"
import { includes } from "./typescript-helpers.mts"

export type CallApi = (prompt: string) => Promise<string>

export function createDefaultCallApi(_environment: Record<string, string | undefined>): CallApi {
	return async (_prompt: string): Promise<string> => {
		return JSON.stringify({ body: "placeholder output - AI integration not yet implemented", comments: [] })
	}
}

async function runAgent(dependencies: { callApi: CallApi; log: Log }, agent: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs?: Map<string, string>): Promise<string> {
	const prompt = buildAgentPrompt(agent, baseCommitContext, diffText, agentInputs)
	dependencies.log(`Running agent: ${agent.name}`)
	const output = await dependencies.callApi(prompt)
	return output
}

async function runAgents(dependencies: { callApi: CallApi; log: Log }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[]): Promise<Map<string, string>> {
	const reviewResults = await Promise.all(
		agents.map(async agent => {
			const output = await runAgent(dependencies, agent, baseCommitContext, diffText)
			return [agent.name, output] as const
		})
	)

	return new Map(reviewResults)
}

async function runAggregator(dependencies: { callApi: CallApi; log: Log }, aggregator: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs: Map<string, string>): Promise<string> {
	const prompt = buildAgentPrompt(aggregator, baseCommitContext, diffText, agentInputs)
	dependencies.log(`Running agent: ${aggregator.name}`)
	const output = await dependencies.callApi(prompt)
	return output
}

function isValidLineComment(value: unknown): value is LineComment {
	if (typeof value !== "object") return false
	if (value === null) return false
	if (!("path" in value) || typeof value.path !== "string") return false
	if (!("line" in value) || typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 1) return false
	if (!("side" in value) || typeof value.side !== "string" || !includes(SIDES, value.side)) return false
	if (!("body" in value) || typeof value.body !== "string" || value.body === "") return false
	return true
}

function isValidAiReviewResult(data: unknown): data is AiReviewResult {
	if (typeof data !== "object") return false
	if (data === null) return false
	if (!("body" in data) || typeof data.body !== "string" || data.body === "") return false
	if (!("comments" in data) || !Array.isArray(data.comments)) return false
	if (!data.comments.every(isValidLineComment)) return false
	return true
}

function parseAggregatorOutput(output: string): AiReviewResult {
	const parsed: unknown = JSON.parse(output)
	if (!isValidAiReviewResult(parsed)) throw new Error(`Parsed output does not match expected AiReviewResult shape: ${output}`)
	return parsed
}

export async function analyze(dependencies: { callApi: CallApi; log: Log }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], aggregator: Agent): Promise<AiReviewResult> {
	dependencies.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)
	dependencies.log(`Using aggregator: ${aggregator.name}`)

	const agentOutputs = await runAgents(dependencies, baseCommitContext, diffText, agents)
	const finalOutput = await runAggregator(dependencies, aggregator, baseCommitContext, diffText, agentOutputs)

	dependencies.log("Agent analysis complete")

	return parseAggregatorOutput(finalOutput)
}
