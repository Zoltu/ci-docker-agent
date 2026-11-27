import { formatAggregatorSelectionError, isAggregatorName, type AgentNames } from "./agents.mts"
import { includes, sanitizeForSingleLine } from "./typescript-helpers.mts"

// This module supplies the trigger label value, the `Reviewer - ` selector prefix, the trigger-label match ignoring case, and the agent selection and label removal a label-triggered run derives from them.
// The workflow's gate expression, the README's trigger-label prose, and the README's `Reviewer - <Name>` wording spell these values out, so a change here has to change them too.
export const REVIEW_START_LABEL = "Review Start" as const

// The trigger label is matched ignoring case, so a label that differs from it only in case still starts a run.
const TRIGGER_LABEL_KEY = REVIEW_START_LABEL.toLowerCase()

export const REVIEWER_LABEL_PREFIX = "Reviewer - " as const

// Both patterns key on the leading word rather than on REVIEWER_LABEL_PREFIX, so a label whose prefix drifted is still caught when the real prefix changes.
const REVIEWER_WORD_PREFIX = /^reviewer/i
const REVIEW_WORD_WITH_HYPHEN = /^review\s*-/i

export function isTriggerLabel(value: string): boolean {
	return value.toLowerCase() === TRIGGER_LABEL_KEY
}

// The check stays deliberately loose: an unrelated label such as `reviewer-needed` fails the run with a message that shows the spelling it has to have, which costs less than a selector whose typo silently selected nothing.
function isNearMissSelectorLabel(labelName: string): boolean {
	if (REVIEWER_WORD_PREFIX.test(labelName)) return true
	return REVIEW_WORD_WITH_HYPHEN.test(labelName)
}

function formatNearMissSelectorError(labelName: string): string {
	return `Invalid selector label "${sanitizeForSingleLine(labelName)}": a selector label must be spelled "${REVIEWER_LABEL_PREFIX}<Name>", with a capital "R", a spaced hyphen, and <Name> matching an agent prompt file name exactly and case-sensitively. Remove the label or correct its spelling.`
}

// Matching label names against the available agents stays behind this function, because a caller that compared them itself would skip the aggregator, availability, and near-miss validation below.
// A label selects an agent only when it starts with the exact `Reviewer - ` prefix.
// A label that looks like a botched selector attempt fails the run with the spelling it has to have instead of being ignored.
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
// Every name in the returned list is one the pull request carries, so the run deletes the trigger label under the spelling the pull request lists and never asks GitHub to delete a label the pull request lacks.
// Removal keys on the exact prefix and validates nothing, so every label that carries the prefix is consumed before the run fails, even one that can select nothing (`Reviewer - Bogus`, `Reviewer - All`, `Reviewer - Aggregator`), while a near miss stays put to fail the next run too.
// GitHub keeps label names unique ignoring case, so at most one listed label matches the trigger label and the trigger label is removed once.
export function selectLabelNamesToRemove(labelNames: readonly string[]): readonly string[] {
	const listedTriggerLabelNames = labelNames.filter(isTriggerLabel)
	const selectorLabelNames = labelNames.filter(labelName => labelName.startsWith(REVIEWER_LABEL_PREFIX))

	return [...listedTriggerLabelNames, ...selectorLabelNames]
}
