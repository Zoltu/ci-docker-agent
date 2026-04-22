import type { PrFile, LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { AiReviewResult } from "./review.mts"
import { buildAgentPrompt, type Agent } from "./agents.mts"
import { includes } from "./typescript-helpers.mts"

export interface AiClient {
	analyze(files: PrFile[], agents: Agent[], aggregator: Agent): Promise<AiReviewResult>
}

async function runAgent(agent: Agent, files: PrFile[]): Promise<string> {
	const prompt = buildAgentPrompt(agent, files)
	// TODO: prompt agent, and assign response to result
	prompt
	const output = `placeholder output - AI integration not yet implemented`
	console.log(`Running agent: ${agent.name}`)
	return output
}

async function runAgents(agents: Agent[], files: PrFile[]): Promise<Map<string, string>> {
	const agentInputs = new Map<string, string>()

	const reviewResults = await Promise.all(
		agents.map(async agent => {
			const output = await runAgent(agent, files)
			return { name: agent.name, output }
		})
	)

	for (const result of reviewResults) {
		agentInputs.set(result.name, result.output)
	}

	return agentInputs
}

async function runAggregator(aggregator: Agent, files: PrFile[], agentInputs: Map<string, string>): Promise<string> {
	const prompt = buildAgentPrompt(aggregator, files, agentInputs)
	// TODO: prompt agent, and assign response to result
	prompt
	const output = JSON.stringify({ body: `${aggregator.name} placeholder output - AI integration not yet implemented`, comments: [] })
	console.log(`Running agent: ${aggregator.name}`)
	return output
}

function isValidLineComment(value: unknown): value is LineComment {
	if (typeof value !== "object") return false
	if (value === null) return false
	if (!("path" in value) || typeof value.path !== "string") return false
	if (!("line" in value) || typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 1) return false
	if (!("side" in value) || typeof value.side !== "string" || !includes(SIDES, value.side)) return false
	if (!("body" in value) || typeof value.body !== "string") return false
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

export function parseAggregatorOutput(output: string): AiReviewResult {
	const parsed: unknown = JSON.parse(output)
	if (!isValidAiReviewResult(parsed)) throw new Error("Parsed output does not match expected AiReviewResult shape")
	return parsed
}

export function createAiClient(): AiClient {
	return {
		async analyze(files: PrFile[], agents: Agent[], aggregator: Agent): Promise<AiReviewResult> {
			console.log(`Analyzing ${files.length} files...`)
			console.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)
			console.log(`Using aggregator: ${aggregator.name}`)

			const agentInputs = await runAgents(agents, files)
			const finalOutput = await runAggregator(aggregator, files, agentInputs)

			console.log("Agent analysis complete")

			return parseAggregatorOutput(finalOutput)
		},
	}
}
