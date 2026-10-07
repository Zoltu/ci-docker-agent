import type { CompletionDelta } from "./completions.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import { isRecord, isString } from "./typescript-helpers.mts"

// Default path through an assistant message/delta to the field that carries the model's reasoning.
export const DEFAULT_REASONING_PATH = ["reasoning"] as const

// Walks a path through a value: non-numeric segments index into objects; numeric segments index into arrays.
// Returns the value at the path, or undefined if any segment fails to resolve.
export function extractAtPath(value: unknown, path: readonly string[]): unknown {
	let current: unknown = value
	for (const segment of path) {
		if (current === null || typeof current !== "object") return undefined
		if (Array.isArray(current)) {
			const index = Number.parseInt(segment, 10)
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
			current = current[index]
		} else if (isRecord(current)) {
			if (!Object.hasOwn(current, segment)) return undefined
			current = current[segment]
		} else {
			return undefined
		}
	}
	return current
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	if (value.length === 0) return undefined
	return value
}

export function readReasoningFromDelta(delta: CompletionDelta, profile: ProviderProfile): string | undefined {
	const path = profile.reasoningField ?? DEFAULT_REASONING_PATH
	return nonEmptyString(extractAtPath(delta, path))
}

// Decides which of the reasoning/reasoning_content overlap survives: keeps the preferred field unless
// it is an empty stub. Returns the winning field name, or undefined when only one of the two values
// was present (nothing to resolve).
// null is unreachable in practice (mergeInto drops nulls) but kept defensively.
// Whitespace-only counts as empty: streaming providers commonly echo a " " stub in the mirrored field.
export function pickReasoningField(reasoning: unknown, reasoningContent: unknown, preferredField: "reasoning" | "reasoning_content"): "reasoning" | "reasoning_content" | undefined {
	if (reasoning === undefined || reasoningContent === undefined) return undefined
	const reasoningEmpty = reasoning === null || (isString(reasoning) && reasoning.trim() === "")
	const reasoningContentEmpty = reasoningContent === null || (isString(reasoningContent) && reasoningContent.trim() === "")
	// Prefer the designated field unless it's an empty stub and the other has content. When both
	// fields have content the preferred field wins; values may differ due to per-field concatenation
	// timing, which is not an error.
	if (preferredField === "reasoning_content" && reasoningContentEmpty && !reasoningEmpty) return "reasoning"
	if (preferredField === "reasoning" && reasoningEmpty && !reasoningContentEmpty) return "reasoning_content"
	return preferredField
}

// Resolves the reasoning/reasoning_content overlap down to a single field in place: deletes the losing
// field from the message and returns the winner. Thin mutating wrapper around pickReasoningField.
export function resolveReasoningOverlap(message: Record<string, unknown>, preferredField: "reasoning" | "reasoning_content"): "reasoning" | "reasoning_content" | undefined {
	const winner = pickReasoningField(message.reasoning, message.reasoning_content, preferredField)
	if (winner === undefined) return undefined
	if (winner === "reasoning_content") delete message.reasoning
	else delete message.reasoning_content
	return winner
}

