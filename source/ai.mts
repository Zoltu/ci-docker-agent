import type { PrFile, LineComment } from "./github-types.mts"
import type { AiReviewResult } from "./review.mts"
import { buildAgentPrompt, type Agent } from "./agents.mts"

interface AgentResult {
	name: string
	output: string
}

export interface AiClient {
	analyze(files: PrFile[], agents: Agent[], aggregator: Agent): Promise<AiReviewResult>
}

async function runAgent(agent: Agent, files: PrFile[], agentInputs?: Map<string, string>): Promise<AgentResult> {
	buildAgentPrompt(agent, files, agentInputs)

	console.log(`Running agent: ${agent.name}`)

	const placeholderOutput = JSON.stringify({ body: `${agent.name} placeholder output - AI integration not yet implemented`, comments: [] })

	return {
		name: agent.name,
		output: placeholderOutput,
	}
}

async function runAgents(agents: Agent[], aggregator: Agent, files: PrFile[]): Promise<AgentResult[]> {
	const results: AgentResult[] = []
	const agentInputs = new Map<string, string>()

	const reviewResults = await Promise.all(
		agents.map(agent => runAgent(agent, files))
	)

	results.push(...reviewResults)

	for (const result of reviewResults) {
		agentInputs.set(result.name, result.output)
	}

	const aggregatorResult = await runAgent(aggregator, files, agentInputs)
	results.push(aggregatorResult)

	return results
}

function extractAggregatorOutput(results: AgentResult[]): string {
	const aggregatorResult = results.find(r => r.name.toLowerCase() === "aggregator")
	if (!aggregatorResult) {
		throw new Error("No aggregator result found in agent outputs")
	}
	return aggregatorResult.output
}

function isValidLineComment(value: unknown): value is LineComment {
	if (typeof value !== "object") return false
	if (value === null) return false
	const obj = value
	if (!("path" in obj) || typeof obj.path !== "string") return false
	if (!("line" in obj) || typeof obj.line !== "number") return false
	if (!("side" in obj) || (obj.side !== "LEFT" && obj.side !== "RIGHT")) return false
	if (!("body" in obj) || typeof obj.body !== "string") return false
	return true
}

function isValidAiReviewResult(data: unknown): data is AiReviewResult {
	if (typeof data !== "object") return false
	if (data === null) return false
	const obj = data
	if (!("body" in obj) || typeof obj.body !== "string") return false
	if (!("comments" in obj) || !Array.isArray(obj.comments)) return false
	if (!obj.comments.every(isValidLineComment)) return false
	return true
}

export function parseAggregatorOutput(output: string): AiReviewResult {
	const parsed: unknown = JSON.parse(output)
	if (!isValidAiReviewResult(parsed)) {
		throw new Error("Parsed output does not match expected AiReviewResult shape")
	}
	return parsed
}

export function createPlaceholderAiClient(): AiClient {
	return {
		async analyze(files: PrFile[], agents: Agent[], aggregator: Agent): Promise<AiReviewResult> {
			console.log(`Analyzing ${files.length} files...`)
			console.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)
			console.log(`Using aggregator: ${aggregator.name}`)

			const results = await runAgents(agents, aggregator, files)

			const finalOutput = extractAggregatorOutput(results)

			console.log("Agent analysis complete")

			return parseAggregatorOutput(finalOutput)
		},
	}
}
