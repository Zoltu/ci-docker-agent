import { formatAggregatorSelectionError, isAggregatorName, type AgentNames } from "./agents.mts"
import { includes, sanitizeForSingleLine } from "./typescript-helpers.mts"

export const REVIEW_START_LABEL = "Review Start" as const

// The trigger label and the selector prefix are this module's public contract, because the workflow gate, the label table, and the token documentation spell these values and a change here has to reach them.
// Matching a label name against the available agents stays behind this module, since a caller that matched names itself would skip the aggregator, availability, and near-miss validation below.
// A label selects an agent only when it starts with this exact prefix, and a run removes every label that carries it.
// A label that looks like a selector but misses the prefix fails the run, because a run that ignored it would review with every agent instead of the agents the label names.
export const REVIEWER_LABEL_PREFIX = "Reviewer - " as const

// Both patterns key on the leading word rather than on REVIEWER_LABEL_PREFIX, so a label whose prefix drifted is still caught when the real prefix changes.
const REVIEWER_WORD_PREFIX = /^reviewer/i
const REVIEW_WORD_WITH_HYPHEN = /^review\s*-/i

// The check stays deliberately loose: an unrelated label such as `reviewer-needed` fails the run with a message that shows the spelling it has to have, which costs less than a selector whose typo silently selected nothing.
function isNearMissSelectorLabel(labelName: string): boolean {
	if (REVIEWER_WORD_PREFIX.test(labelName)) return true
	return REVIEW_WORD_WITH_HYPHEN.test(labelName)
}

function formatNearMissSelectorError(labelName: string): string {
	return `Invalid selector label "${sanitizeForSingleLine(labelName)}": a selector label must be spelled "${REVIEWER_LABEL_PREFIX}<Name>", with a capital "R", a spaced hyphen, and <Name> matching an agent prompt file name exactly and case-sensitively. Remove the label or correct its spelling.`
}

// The caller supplies the selectable names with the aggregator already excluded, so the failure message cannot offer a selector that always fails.
export function selectAgentNamesFromLabels(labelNames: readonly string[], availableAgentNames: readonly string[]): AgentNames {
	const selectedAgentNames: string[] = []

	for (const labelName of labelNames) {
		if (!labelName.startsWith(REVIEWER_LABEL_PREFIX)) {
			if (isNearMissSelectorLabel(labelName)) throw new Error(formatNearMissSelectorError(labelName))
			continue
		}

		const agentName = labelName.slice(REVIEWER_LABEL_PREFIX.length)
		if (isAggregatorName(agentName)) throw new Error(formatAggregatorSelectionError(labelName, "Remove the label."))
		if (!includes(availableAgentNames, agentName)) throw new Error(`Invalid selector label "${sanitizeForSingleLine(labelName)}": it names no available agent, and a label's agent name is matched case-sensitively. Available agents: ${availableAgentNames.map(name => sanitizeForSingleLine(name)).join(", ")}.`)

		selectedAgentNames.push(agentName)
	}

	if (selectedAgentNames.length === 0) return "run all agents"
	return selectedAgentNames
}

// A selector label is consumed by the run it selected for, because one left behind would narrow the next run to a subset nobody asked for.
// The trigger label leads the returned list, so the removals leave the pull request without the label that starts a run even when a later removal fails.
// The list is built from the names the pull request actually carries, never from the prefix alone, so the caller never deletes a label that GitHub would report as missing.
// Removal keys on the exact prefix and validates nothing, so a label that cannot select anything (`Reviewer - Bogus`, `Reviewer - All`, `Reviewer - Aggregator`) is still consumed before the run fails, and a near miss stays put to fail the next run too.
export function selectLabelNamesToRemove(labelNames: readonly string[], triggerLabel: string): readonly string[] {
	const labelNamesToRemove: string[] = []
	if (includes(labelNames, triggerLabel)) labelNamesToRemove.push(triggerLabel)

	for (const labelName of labelNames) {
		if (labelName === triggerLabel) continue
		if (!labelName.startsWith(REVIEWER_LABEL_PREFIX)) continue
		labelNamesToRemove.push(labelName)
	}

	return labelNamesToRemove
}
