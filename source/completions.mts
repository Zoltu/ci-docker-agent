import { DEFAULT_REASONING_PATH, resolveReasoningOverlap } from './reasoning.mts'
import { type Fetch, readSseStream } from './sse.mts'
import { DANGEROUS_KEYS, guard, type GuardedType, isArray, isArrayOf, isInteger, isLiteral, isRecord, isString, optional } from './typescript-helpers.mts'

const REASONING_CONTENT_FIELD = 'reasoning_content' as const

// Token counts cannot be negative; isInteger alone accepts negatives.
function isNonNegativeInteger(value: unknown): value is number {
	return isInteger(value) && value >= 0
}

const isSseCompletionEvent = guard({
	choices: isArrayOf(guard({
		delta: optional(guard({
			role: optional(isLiteral('assistant')),
			content: optional(isString),
			reasoning: optional(isString),
			reasoning_content: optional(isString),
			tool_calls: optional(isArrayOf(guard({
				index: isInteger,
				id: optional(isString),
				type: optional(isLiteral('function')),
				function: guard({
					name: optional(isString),
					arguments: optional(isString),
				}),
			}))),
		})),
		finish_reason: optional(isString),
	})),
	usage: optional(guard({
		prompt_tokens: optional(isNonNegativeInteger),
		completion_tokens: isNonNegativeInteger,
		total_tokens: optional(isNonNegativeInteger),
	})),
})

const isAssistantMessageToolCall = guard({
	id: isString,
	type: isLiteral('function'),
	function: guard({ name: isString, arguments: isString }),
})

const isAssistantMessageGuard = guard({
	role: isLiteral('assistant'),
	content: optional(isString),
	reasoning: optional(isString),
	reasoning_content: optional(isString),
	tool_calls: optional(isArrayOf(isAssistantMessageToolCall)),
})

export const isAssistantMessage = (value: unknown): value is CompletionsMessage & { role: 'assistant' } => {
	return isAssistantMessageGuard(value)
}

export type CompletionsMessage =
	| { readonly role: 'system' | 'developer', readonly content: string }
	| { readonly role: 'user', readonly content: string }
	| { readonly role: 'assistant', readonly content?: string | null, readonly reasoning?: string | null, readonly reasoning_content?: string | null, readonly tool_calls?: readonly CompletionsToolCall[] }
	| { readonly role: 'tool', readonly content: string, readonly tool_call_id: string }

export interface CompletionsToolCall {
	readonly id: string
	readonly type: 'function'
	readonly function: {
		readonly name: string
		readonly arguments: string
	}
}

export interface CompletionsRequest {
	readonly model: string
	readonly messages: readonly CompletionsMessage[]
	readonly max_tokens?: number
	readonly max_completion_tokens?: number
	readonly temperature?: number
	readonly top_p?: number
	readonly stop?: string | readonly string[]
	readonly n?: number
	readonly seed?: number
	readonly stream?: boolean
	readonly stream_options?: {
		readonly include_usage?: boolean
		readonly [extension: string]: unknown
	}
	readonly tools?: readonly {
		readonly type: 'function'
		readonly function: {
			readonly name: string
			readonly description?: string
			readonly parameters?: Record<string, unknown>
			readonly [extension: string]: unknown
		}
		readonly [extension: string]: unknown
	}[]
	readonly tool_choice?: 'none' | 'auto' | 'required' | {
		readonly type: 'function'
		readonly function: { readonly name: string }
		readonly [extension: string]: unknown
	}
	readonly [extension: string]: unknown
}

export type CompletionDelta = NonNullable<GuardedType<typeof isSseCompletionEvent>['choices'][number]['delta']>
export type CompletionUsage = NonNullable<GuardedType<typeof isSseCompletionEvent>['usage']>

function isOverwritePath(fieldPath: readonly string[], overwritePaths: readonly (readonly string[])[]): boolean {
	return overwritePaths.some(pattern => pattern.length === fieldPath.length && pattern.every((segment, i) => segment === fieldPath[i]))
}

// These keys use overwrite semantics at any path depth (repeated values replace, not concatenate).
// This supersedes profile-level overwritePaths entries for these keys.
const ONE_SHOT_KEYS = new Set(['role', 'id', 'type', 'name'])

function isOneShotKey(key: string, currentPath: readonly string[]): boolean {
	if (!ONE_SHOT_KEYS.has(key)) return false
	// `function.name` merges below instead: it may arrive as fragments or as a verbatim echo.
	if (key === 'name' && currentPath[currentPath.length - 1] === 'function') return false
	return true
}

// `function.name` streams in fragments on some providers ("read_" + "file") but is echoed verbatim
// in every delta on others. Distinct values concatenate as fragments; an identical echo carries no
// new information and must not double.
function isEchoedFunctionName(key: string, currentPath: readonly string[], existing: string, value: string): boolean {
	if (key !== 'name') return false
	if (currentPath[currentPath.length - 1] !== 'function') return false
	return existing === value
}

// Cloning copy that strips dangerous keys at every level: structuredClone preserves them, and copying
// a record that owns `__proto__` would smuggle it past mergeInto's per-key sanitization.
function sanitizeClone(value: unknown): unknown {
	if (isArray(value)) return value.map(sanitizeClone)
	if (isRecord(value)) {
		const result: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value)) {
			if (DANGEROUS_KEYS.has(key)) continue
			result[key] = sanitizeClone(item)
		}
		return result
	}
	return value
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, overwritePaths: readonly (readonly string[])[], currentPath: readonly string[] = []): void {
	for (const [key, value] of Object.entries(source)) {
		if (DANGEROUS_KEYS.has(key)) continue
		if (value === undefined) continue
		if (value === null) continue

		if (isOneShotKey(key, currentPath)) {
			target[key] = value
			continue
		}

		const fieldPath = [...currentPath, key]
		const existing = target[key]

		if (isOverwritePath(fieldPath, overwritePaths)) {
			target[key] = value
			continue
		}

		if (typeof value === 'string') {
			if (typeof existing === 'string') {
				if (isEchoedFunctionName(key, currentPath, existing, value)) continue
				target[key] = existing + value
				continue
			}
			target[key] = value
			continue
		}

		// Arrays whose items are {index: n} records (e.g. tool_calls) merge by index; other arrays overwrite.
		if (isArray(value)) {
			const allHaveIndex = value.every(item => isRecord(item) && isInteger(item.index))
			if (!allHaveIndex) {
				target[key] = sanitizeClone(value)
				continue
			}
			const arr: unknown[] = isArray(existing) ? existing : []
			target[key] = arr
			const seenIndices = new Set<number>()
			for (const item of value) {
				if (!isRecord(item)) throw new Error(`Array item is not an object: ${JSON.stringify(item)}`)
				if (!isInteger(item.index)) throw new Error(`Array item missing integer index: ${JSON.stringify(item)}`)
				if (item.index < 0 || item.index > 1024) throw new Error(`Array item index out of bounds: ${item.index}`)
				const index = item.index
				if (seenIndices.has(index)) throw new Error(`Duplicate array item index within one delta: ${index}`)
				seenIndices.add(index)
				if (!isRecord(arr[index])) {
					arr[index] = {}
				}
				const slot = arr[index]
				if (isRecord(slot)) {
					mergeInto(slot, item, overwritePaths, fieldPath)
				}
			}
			continue
		}

		// Records: merge into existing record or initialize an empty one to avoid mutating the source reference
		if (isRecord(value)) {
			if (!isRecord(existing)) {
				target[key] = {}
			}
			const nested = target[key]
			if (isRecord(nested)) {
				mergeInto(nested, value, overwritePaths, fieldPath)
			}
			continue
		}

		// Default: overwrite with latest value
		target[key] = value
	}
}

// Recursively removes the streaming-side `index` routing key from records inside arrays.
function stripIndex(value: unknown): void {
	if (!isRecord(value)) return
	for (const item of Object.values(value)) {
		if (isArray(item)) {
			for (const entry of item) {
				if (isRecord(entry)) {
					delete entry.index
					stripIndex(entry)
				}
			}
		} else if (isRecord(item)) {
			stripIndex(item)
		}
	}
}

function applyToolCallDefaults(accumulator: Record<string, unknown>): void {
	const toolCalls = accumulator.tool_calls
	if (!isArray(toolCalls)) return
	for (const toolCall of toolCalls) {
		if (toolCall === undefined || toolCall === null) continue
		if (!isRecord(toolCall)) continue
		if (toolCall.type === undefined) toolCall.type = 'function'
		if (toolCall.id === undefined) toolCall.id = ''
		const fn = toolCall.function
		if (isRecord(fn) && fn.arguments === undefined) fn.arguments = ''
	}
}

// Final validation that the accumulated object matches the assistant message contract
function completeAccumulation(accumulator: Record<string, unknown>, reasoningField?: readonly [string, ...string[]]): CompletionsMessage {
	// Index-merged arrays accumulate sparse slots across deltas; compact every array (not just tool_calls) before finalizing.
	for (const [key, value] of Object.entries(accumulator)) {
		if (DANGEROUS_KEYS.has(key)) continue
		if (!isArray(value)) continue
		accumulator[key] = value.filter(item => item !== undefined && item !== null)
	}
	// The `index` is a streaming-side routing key used by mergeInto to know which slot each delta belongs to.
	// Once accumulation is complete the slot is established and the routing is done, so the field is not part of the message.
	stripIndex(accumulator)
	applyToolCallDefaults(accumulator)
	const preferredField = reasoningField?.[0] === REASONING_CONTENT_FIELD ? REASONING_CONTENT_FIELD : DEFAULT_REASONING_PATH[0]
	resolveReasoningOverlap(accumulator, preferredField)
	// completions() always accumulates an assistant message; a stream that never sends a role delta still produced one.
	if (accumulator.role === undefined) accumulator.role = 'assistant'
	if (!isAssistantMessage(accumulator)) {
		throw new Error(`Invalid accumulated message: ${JSON.stringify(accumulator)}`)
	}
	return accumulator
}

export interface CompletionResult {
	message: CompletionsMessage
	finishReason?: string
	usage?: CompletionUsage
}

export async function* completions(dependencies: { fetch: Fetch }, request: CompletionsRequest, overwritePaths: readonly (readonly string[])[], reasoningField?: readonly [string, ...string[]]): AsyncGenerator<CompletionDelta, CompletionResult> {
	const body = JSON.stringify({
		...request,
		stream_options: { ...request.stream_options, include_usage: true },
		stream: true,
	} satisfies CompletionsRequest)

	const accumulator: Record<string, unknown> = {}
	let finishReason: string | undefined
	let usage: CompletionUsage | undefined

	for await (const sseEvent of readSseStream(dependencies, body, { 'Content-Type': 'application/json' })) {
		if (sseEvent.data === '[DONE]') {
			return { message: completeAccumulation(accumulator, reasoningField), finishReason, usage }
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(sseEvent.data)
		} catch (error) {
			throw new Error(`Failed to parse SSE data as JSON: ${sseEvent.data}`, { cause: error })
		}

		if (!isSseCompletionEvent(parsed)) {
			throw new Error(`Unexpected SSE event structure: ${sseEvent.data}`)
		}

		if (parsed.usage) usage = parsed.usage

		if (parsed.choices.length === 0) continue
		const choice = parsed.choices[0]
		if (choice === undefined) continue
		const { delta, finish_reason } = choice

		if (finish_reason) finishReason = finish_reason

		if (delta === undefined) continue
		if (delta === null) continue

		mergeInto(accumulator, delta, overwritePaths)

		yield delta
	}
	return { message: completeAccumulation(accumulator, reasoningField), finishReason, usage }
}
