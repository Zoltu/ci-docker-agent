import { formatAggregatorSelectionError, isAggregatorName, type AgentNames } from "./agents.mts"
import { includes, sanitizeForSingleLine } from "./typescript-helpers.mts"

export const REVIEW_START_LABEL = "Review Start" as const

// The trigger label and the selector prefix are this module's public contract, because the workflow gate, the label table, and the token documentation spell these values and a change here has to reach them.
// Matching a label name against the available agents stays behind this module, since a caller that matched names itself would skip the aggregator and availability validation below.
// A label selects an agent only when it starts with this exact prefix.
// Any other label is ignored, so a near-miss such as "reviewer - Security", "Reviewers - Security", or "Reviewer- Security" selects nothing.
// A well-formed selector whose agent-name portion names an unknown agent or the aggregator fails the run instead of being skipped.
export const REVIEWER_LABEL_PREFIX = "Reviewer - " as const

// The near-miss detector keys on the selector word alone, so it still reports a label whose prefix drifted when the real prefix changes.
function selectorWord(prefix: string): string {
	const separatorIndex = prefix.search(/[^A-Za-z]/)
	if (separatorIndex === -1) return prefix
	return prefix.slice(0, separatorIndex)
}

const SELECTOR_LIKE_PREFIX = selectorWord(REVIEWER_LABEL_PREFIX).toLowerCase()

function isIgnoredSelectorLabel(labelName: string): boolean {
	if (labelName.startsWith(REVIEWER_LABEL_PREFIX)) return false
	return labelName.toLowerCase().startsWith(SELECTOR_LIKE_PREFIX)
}

// A selector-like label that selects nothing costs one advisory log line, while a missed one hides why the run ignored it.
export function findIgnoredSelectorLabels(labelNames: readonly string[]): readonly string[] {
	return labelNames.filter(isIgnoredSelectorLabel)
}

// Whether every reviewer runs depends on the labels the caller matched against the available agents, which this module never sees, so the caller passes the selection it resolved.
export function formatIgnoredSelectorNotice(ignoredLabelNames: readonly string[], selection: AgentNames): string | undefined {
	if (ignoredLabelNames.length === 0) return undefined

	const labelList = ignoredLabelNames.map(name => `"${sanitizeForSingleLine(name)}"`).join(", ")
	const selectsNothing = `a selector label must start with "${REVIEWER_LABEL_PREFIX}", so ${ignoredLabelNames.length === 1 ? "it selects" : "they select"} nothing`
	if (selection === "run all agents") return `Ignoring ${labelList}: ${selectsNothing}, and every reviewer runs.`
	return `Ignoring ${labelList}: ${selectsNothing}, and the run uses only the agents named by valid selector labels.`
}

// The caller supplies the selectable names with the aggregator already excluded, so the failure message cannot offer a selector that always fails.
export function selectAgentNamesFromLabels(labelNames: readonly string[], availableAgentNames: readonly string[]): AgentNames {
	const selectedAgentNames: string[] = []

	for (const labelName of labelNames) {
		if (!labelName.startsWith(REVIEWER_LABEL_PREFIX)) continue

		const agentName = labelName.slice(REVIEWER_LABEL_PREFIX.length)
		if (isAggregatorName(agentName)) throw new Error(formatAggregatorSelectionError(labelName, "Remove the label."))
		if (!includes(availableAgentNames, agentName)) throw new Error(`Invalid selector label "${sanitizeForSingleLine(labelName)}": it names no available agent, and a label's agent name is matched case-sensitively. Available agents: ${availableAgentNames.join(", ")}.`)

		selectedAgentNames.push(agentName)
	}

	if (selectedAgentNames.length === 0) return "run all agents"
	return selectedAgentNames
}
