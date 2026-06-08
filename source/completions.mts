import { type Fetch, readSseStream } from './sse.mts'
import { guard, type GuardedType, isArray, isArrayOf, isInteger, isLiteral, isRecord, isString, optional } from './typescript-helpers.mts'

const isSseCompletionEvent = guard({
	choices: isArrayOf(guard({
		delta: guard({
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
		}),
		finish_reason: optional(isString),
	})),
	usage: optional(guard({
		prompt_tokens: isInteger,
		completion_tokens: isInteger,
		total_tokens: isInteger,
	})),
})

const isAssistantMessageToolCall = guard({
	id: isString,
	type: isLiteral('function'),
	function: guard({ name: isString, arguments: isString }),
})

const isAssistantMessage = (value: unknown): value is CompletionsMessage & { role: 'assistant' } => {
	const isValid = guard({
		role: isLiteral('assistant'),
		content: optional(isString),
		reasoning: optional(isString),
		reasoning_content: optional(isString),
		tool_calls: optional(isArrayOf(isAssistantMessageToolCall)),
	})
	if (!isValid(value)) return false
	if (value.reasoning && value.reasoning_content) {
		// Exception to the Guard contract: a provider sending both fields is a bug that must fail fast rather than be silently ignored.
		throw new Error('Assistant message has both reasoning and reasoning_content; these are mutually exclusive')
	}
	return true
}

export type CompletionsMessage =
	| { readonly role: 'system' | 'developer', readonly content: string }
	| { readonly role: 'user', readonly content: string }
	| { readonly role: 'assistant', readonly content?: string | null, readonly reasoning_content?: string | null, readonly tool_calls?: readonly CompletionsToolCall[] }
	| { readonly role: 'assistant', readonly content?: string | null, readonly reasoning?: string | null, readonly tool_calls?: readonly CompletionsToolCall[] }
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

export type CompletionDelta = GuardedType<typeof isSseCompletionEvent>['choices'][number]['delta']
export type CompletionUsage = NonNullable<GuardedType<typeof isSseCompletionEvent>['usage']>

function isOverwritePath(fieldPath: readonly string[], overwritePaths: readonly (readonly string[])[]): boolean {
	return overwritePaths.some(pattern => pattern.length === fieldPath.length && pattern.every((segment, i) => segment === fieldPath[i]))
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, overwritePaths: readonly (readonly string[])[], currentPath: readonly string[] = []): void {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue
		if (value === null) continue

		const fieldPath = [...currentPath, key]
		const existing = target[key]

		if (isOverwritePath(fieldPath, overwritePaths)) {
			target[key] = value
			continue
		}

		if (typeof value === 'string') {
			if (typeof existing === 'string') {
				target[key] = existing + value
				continue
			}
			target[key] = value
			continue
		}

		// Arrays: validate items and merge by index
		if (isArray(value)) {
			let arr = isArray(existing) ? existing : [] as unknown[]
			target[key] = arr
			for (const item of value) {
				if (!isRecord(item)) throw new Error(`Array item is not an object: ${JSON.stringify(item)}`)
				if (!isInteger(item.index)) throw new Error(`Array item missing integer index: ${JSON.stringify(item)}`)
				const index = item.index
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

// Final validation that the accumulated object matches the assistant message contract
function completeAccumulation(accumulator: Record<string, unknown>): CompletionsMessage {
	// The `index` is a streaming-side routing key used by mergeInto to know which slot each delta belongs to.
	// Once accumulation is complete the slot is established and the routing is done, so the field is not part of the message.
	for (const value of Object.values(accumulator)) {
		if (isArray(value)) {
			for (const item of value) {
				if (isRecord(item)) delete item.index
			}
		}
	}
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

export async function* completions(dependencies: { fetch: Fetch }, request: CompletionsRequest, overwritePaths: readonly (readonly string[])[]): AsyncGenerator<CompletionDelta, CompletionResult> {
	const body = JSON.stringify({
		stream_options: {
			include_usage: true,
		},
		...request,
		stream: true,
	} satisfies CompletionsRequest)

	const accumulator: Record<string, unknown> = {}
	let finishReason: string | undefined
	let usage: CompletionUsage | undefined

	for await (const sseEvent of readSseStream(dependencies, body, { 'Content-Type': 'application/json' })) {
		if (sseEvent.data === '[DONE]') {
			return { message: completeAccumulation(accumulator), finishReason, usage }
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

		mergeInto(accumulator, delta, overwritePaths)

		yield delta
	}
	return { message: completeAccumulation(accumulator), finishReason, usage }
}
