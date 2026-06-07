import type { CompletionDelta } from "./completions.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import { isRecord } from "./typescript-helpers.mts"

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
			current = current[segment]
		} else {
			return undefined
		}
	}
	return current
}

const DEFAULT_REASONING_PATH = ["reasoning"] as const

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	if (value.length === 0) return undefined
	return value
}

export function readReasoningFromDelta(delta: CompletionDelta, profile: ProviderProfile): string | undefined {
	return nonEmptyString(extractAtPath(delta, profile.reasoningField ?? DEFAULT_REASONING_PATH))
}

