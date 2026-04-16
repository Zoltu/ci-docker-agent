import type { PrFile } from "./github-types.mts"
import type { AiReviewResult } from "./review.mts"
import { loadAgents, loadAggregator, runAgents } from "./agents.mts"
import type { AgentResult, AgentDirs } from "./agents.mts"

export interface AiClient {
	analyze(files: PrFile[], agentNames?: string[]): Promise<AiReviewResult>
}

function extractAggregatorOutput(results: AgentResult[]): string | null {
	if (results.length === 0) {
		return null
	}

	const aggregatorResult = results.find(r => r.name.toLowerCase() === "aggregator")
	if (aggregatorResult) {
		return aggregatorResult.output
	}

	const lastResult = results[results.length - 1]
	return lastResult?.output ?? null
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
			console.log(`Loaded ${agents.length} agents: ${agents.map(a => a.name).join(", ")}`)
			if (aggregator) {
				console.log(`Using aggregator: ${aggregator.name}`)
			}

			const results = await runAgents(agents, aggregator, files)

			const finalOutput = extractAggregatorOutput(results)
			if (finalOutput === null) {
				console.warn("Warning: No agent results produced")
				return {
					summary: "No analysis results produced.",
					lineComments: [],
				}
			}

			console.log("Agent analysis complete")

			return parseAggregatorOutput(finalOutput)
		},
	}
}


