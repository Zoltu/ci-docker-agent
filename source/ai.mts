import type { PrFile } from "./github-types.mts"
import type { AiReviewResult } from "./review.mts"
import { loadAgents, loadAggregator, buildAgentPrompt, type Agent, type AgentDirs } from "./agents.mts"

export interface AgentResult {
	name: string
	output: string
}

export interface AiClient {
	analyze(files: PrFile[], agentNames?: string[]): Promise<AiReviewResult>
}

async function runAgent(agent: Agent, files: PrFile[], agentInputs?: Map<string, string>): Promise<AgentResult> {
	buildAgentPrompt(agent, files, agentInputs)

	console.log(`Running agent: ${agent.name}`)

	const placeholderOutput = JSON.stringify({ summary: `${agent.name} placeholder output - AI integration not yet implemented`, lineComments: [] })

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

function isValidAiReviewResult(data: unknown): data is AiReviewResult {
	if (typeof data !== "object") return false
	if (data === null) return false
	const obj = data
	if (!("summary" in obj) || typeof obj.summary !== "string") return false
	if (!("lineComments" in obj) || !Array.isArray(obj.lineComments)) return false
	return true
}

export function parseAggregatorOutput(output: string): AiReviewResult {
	const parsed: unknown = JSON.parse(output)
	if (!isValidAiReviewResult(parsed)) {
		throw new Error("Parsed output does not match expected AiReviewResult shape")
	}
	return parsed
}

export function createPlaceholderAiClient(dirs?: AgentDirs): AiClient {
	return {
		async analyze(files: PrFile[], agentNames = []): Promise<AiReviewResult> {
			console.log(`Analyzing ${files.length} files...`)
			console.log(`Using agents: ${agentNames.length > 0 ? agentNames.join(", ") : "Default"}`)

			const agents = await loadAgents(agentNames, dirs)
			const aggregator = await loadAggregator(dirs)
			if (!aggregator) {
				throw new Error("No aggregator agent found. A builtin Aggregator.md must exist in the agents directory.")
			}

			console.log(`Loaded ${agents.length} agents: ${agents.map(a => a.name).join(", ")}`)
			console.log(`Using aggregator: ${aggregator.name}`)

			const results = await runAgents(agents, aggregator, files)

			const finalOutput = extractAggregatorOutput(results)

			console.log("Agent analysis complete")

			return parseAggregatorOutput(finalOutput)
		},
	}
}
