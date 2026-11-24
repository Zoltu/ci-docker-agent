import type { AgentNames } from "./agents.mts"
import { includes } from "./typescript-helpers.mts"

export const REVIEW_START_LABEL = "Review Start" as const

const REVIEWER_LABEL_PREFIX = "Reviewer - "
const AGGREGATOR_AGENT_NAME = "Aggregator"

export function selectAgentNamesFromLabels(labelNames: readonly string[], availableAgentNames: readonly string[]): AgentNames {
	const selectedAgentNames: string[] = []

	for (const labelName of labelNames) {
		// Matching is exact and case-sensitive on purpose: a near-miss label fails loudly instead of silently selecting nothing or the wrong agent.
		if (!labelName.startsWith(REVIEWER_LABEL_PREFIX)) continue

		const agentName = labelName.slice(REVIEWER_LABEL_PREFIX.length)
		if (agentName === AGGREGATOR_AGENT_NAME) throw new Error(`"${labelName}" is a configuration error: the Aggregator always runs last automatically. Remove the label.`)
		if (!includes(availableAgentNames, agentName)) throw new Error(`Label "${labelName}" names no available agent. Available agents: ${availableAgentNames.join(", ")}.`)

		selectedAgentNames.push(agentName)
	}

	if (selectedAgentNames.length === 0) return "run all agents"
	return selectedAgentNames
}
