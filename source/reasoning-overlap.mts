// Pure reasoning-overlap policy. Dependency-free leaf module — importable by
// reasoning.mts, completions.mts, and provider-profiles.mts without cycles.

// Default path through an assistant message/delta to the field that carries the model's reasoning.
export const DEFAULT_REASONING_PATH = ["reasoning"] as const

// Decides which of the reasoning/reasoning_content overlap survives: keeps the preferred field unless
// it is an empty stub. Returns the winning field name, or undefined when only one of the two values
// was present (nothing to resolve).
// null is unreachable in practice (mergeInto drops nulls) but kept defensively.
// Whitespace-only counts as empty: streaming providers commonly echo a " " stub in the mirrored field.
export function pickReasoningField(reasoning: unknown, reasoningContent: unknown, preferredField: 'reasoning' | 'reasoning_content'): 'reasoning' | 'reasoning_content' | undefined {
	if (reasoning === undefined || reasoningContent === undefined) return undefined
	const reasoningEmpty = reasoning === null || (typeof reasoning === 'string' && reasoning.trim() === '')
	const reasoningContentEmpty = reasoningContent === null || (typeof reasoningContent === 'string' && reasoningContent.trim() === '')
	// Prefer the designated field unless it's an empty stub and the other has content. When both
	// fields have content the preferred field wins; values may differ due to per-field concatenation
	// timing, which is not an error.
	if (preferredField === 'reasoning_content' && reasoningContentEmpty && !reasoningEmpty) return 'reasoning'
	if (preferredField === 'reasoning' && reasoningEmpty && !reasoningContentEmpty) return 'reasoning_content'
	return preferredField
}

// Resolves the reasoning/reasoning_content overlap down to a single field in place: deletes the losing
// field from the message and returns the winner. Thin mutating wrapper around pickReasoningField.
export function resolveReasoningOverlap(message: Record<string, unknown>, preferredField: 'reasoning' | 'reasoning_content'): 'reasoning' | 'reasoning_content' | undefined {
	const winner = pickReasoningField(message.reasoning, message.reasoning_content, preferredField)
	if (winner === undefined) return undefined
	if (winner === 'reasoning_content') delete message.reasoning
	else delete message.reasoning_content
	return winner
}
