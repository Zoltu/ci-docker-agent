import type { PRFile } from "./github-types.mts"
import type { AIReviewResult } from "./review.mts"
import { loadAgents, loadAggregator, runAgents } from "./agents.mts"

export interface AIClient {
	analyze(files: PRFile[], agentNames?: string[]): Promise<AIReviewResult>
}

export function createPlaceholderAIClient(): AIClient {
	return {
		async analyze(files: PRFile[], agentNames = []): Promise<AIReviewResult> {
			console.log(`Analyzing ${files.length} files...`)
			console.log(`Using agents: ${agentNames.length > 0 ? agentNames.join(", ") : "Default"}`)

			// Load agents and aggregator separately
			const agents = await loadAgents(agentNames)
			const aggregator = await loadAggregator()
			console.log(`Loaded ${agents.length} agents: ${agents.map(a => a.name).join(", ")}`)
			if (aggregator) {
				console.log(`Using aggregator: ${aggregator.name}`)
			}

			const results = await runAgents(agents, aggregator, files)

			// Find the aggregator result (or use the last result if no aggregator)
			const aggregatorResult = results.find(r => r.name.toLowerCase() === "aggregator")
			const finalOutput = aggregatorResult?.output ?? results[results.length - 1]?.output ?? ""

			console.log("Agent analysis complete")

			// Parse the JSON output from the aggregator
			try {
				const parsed = JSON.parse(finalOutput)
				return {
					summary: parsed.summary ?? "Analysis complete",
					lineComments: parsed.lineComments ?? [],
				}
			} catch {
				// If parsing fails, return placeholder
				return {
					summary: "AI analysis placeholder - no actual analysis performed yet.",
					lineComments: [],
				}
			}
		},
	}
}

export { loadAgents, loadAggregator, runAgents, type Agent, type AgentResult } from "./agents.mts"
