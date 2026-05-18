import { type Fetch, readSseStream } from './sse.mts'
import { type Guard, guard, type InferGuard, isArray, isArrayOf, isLiteral, isNumber, isReadonlyArray, isRecord, isString, optional } from './typescript-helpers.mts'

const isStringOrNull: Guard<string | null> = (v): v is string | null => isString(v) || v === null

const isSseCompletionEvent = guard({
	choices: isArrayOf(guard({
		delta: guard({
			content: optional(isStringOrNull),
			reasoning: optional(isStringOrNull),
			reasoning_content: optional(isStringOrNull),
			tool_calls: optional(isArrayOf(guard({
				index: isNumber,
				id: optional(isString),
				type: optional(isString),
				function: optional(guard({
					name: optional(isString),
					arguments: optional(isString),
				})),
			}))),
		}),
		finish_reason: optional(isStringOrNull),
	})),
	usage: optional(guard({
		prompt_tokens: isNumber,
		completion_tokens: isNumber,
		total_tokens: isNumber,
	})),
})

const isAssistantMessageToolCall = guard({
	id: isString,
	type: isLiteral('function'),
	function: guard({ name: isString, arguments: isString }),
})

const isAssistantMessage: Guard<CompletionsMessage & { role: 'assistant' }> = (value): value is CompletionsMessage & { role: 'assistant' } => {
	const isValid = guard({
		role: isLiteral('assistant'),
		content: isStringOrNull,
		reasoning: optional(isStringOrNull),
		reasoning_content: optional(isStringOrNull),
		tool_calls: optional(isArrayOf(isAssistantMessageToolCall)),
	})
	if (!isValid(value)) return false
	if (value.reasoning !== undefined && value.reasoning_content !== undefined) {
		throw new Error('Assistant message has both reasoning and reasoning_content; these are mutually exclusive')
	}
	return true
}

export type CompletionsMessage =
	| { readonly role: 'system' | 'developer', readonly content: string }
	| { readonly role: 'user', readonly content: string }
	| { readonly role: 'assistant', readonly content: string | null, readonly reasoning_content?: string | null, readonly tool_calls?: readonly CompletionsToolCall[] }
	| { readonly role: 'assistant', readonly content: string | null, readonly reasoning?: string | null, readonly tool_calls?: readonly CompletionsToolCall[] }
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
	readonly frequency_penalty?: number
	readonly presence_penalty?: number
	readonly stop?: string | readonly string[]
	readonly n?: number
	readonly seed?: number
	readonly stream?: boolean
	readonly stream_options?: { include_usage?: boolean }
	readonly tools?: readonly {
		readonly type: 'function'
		readonly function: {
			readonly name: string
			readonly description?: string
			readonly parameters?: Record<string, unknown>
		}
	}[]
	readonly reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
	readonly reasoning?: {
		readonly enabled: boolean
	}
	readonly chat_template_kwargs?: {
		readonly preserve_thinking?: true
		readonly clear_thinking?: false
	}
	readonly venice_parameters?: {
		readonly disable_thinking?: boolean
		readonly strip_thinking_response?: boolean
		readonly include_venice_system_prompt?: false
	}
}

export type CompletionDelta = InferGuard<typeof isSseCompletionEvent>['choices'][number]['delta']
export type CompletionUsage = NonNullable<InferGuard<typeof isSseCompletionEvent>['usage']>

const FRAGMENT_FIELDS = new Set(['content', 'reasoning', 'reasoning_content', 'name', 'arguments'])

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue
		if (key === 'tool_calls' && isArray(value)) {
			mergeToolCalls(target, value)
			continue
		}
		const existing = target[key]
		if (FRAGMENT_FIELDS.has(key) && value === '') continue
		if (FRAGMENT_FIELDS.has(key) && isString(existing) && isString(value)) {
			target[key] = existing + value
			continue
		}
		if (FRAGMENT_FIELDS.has(key) && existing === null && isString(value)) {
			target[key] = value
			continue
		}
		// A null delta for a fragment field means "no change", not "reset to null", so it is silently dropped
		if (FRAGMENT_FIELDS.has(key) && value === null) continue
		if (isRecord(value)) {
			if (!isRecord(existing)) {
				target[key] = {}
			}
			const nested = target[key]
			if (isRecord(nested)) {
				mergeInto(nested, value)
			}
			continue
		}
		if (isReadonlyArray(value)) {
			if (isReadonlyArray(existing)) {
				target[key] = [...existing, ...value]
			} else {
				target[key] = [...value]
			}
			continue
		}
		target[key] = value
	}
}

function mergeToolCalls(target: Record<string, unknown>, toolCalls: unknown[]): void {
	if (!isReadonlyArray(target.tool_calls)) {
		target.tool_calls = []
	}
	const existing = target.tool_calls
	if (!isArray(existing)) return
	for (const toolCall of toolCalls) {
		if (!isRecord(toolCall)) continue
		const index = isNumber(toolCall.index) ? toolCall.index : existing.length
		if (!isRecord(existing[index])) {
			existing[index] = { type: 'function', function: { name: '', arguments: '' } }
		}
		const slot = existing[index]
		if (isRecord(slot)) {
			mergeInto(slot, toolCall)
			delete slot.index
		}
	}
}

function completeAccumulation(accumulator: Record<string, unknown>): CompletionsMessage {
	if ('tool_calls' in accumulator && isArray(accumulator.tool_calls) && accumulator.tool_calls.length > 0 && accumulator.content === '') {
		accumulator.content = null
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

export async function* completions(dependencies: { fetch: Fetch }, url: string, request: CompletionsRequest, options?: { headers?: Record<string, string>; signal?: AbortSignal }): AsyncGenerator<CompletionDelta, CompletionResult> {
	const headers = { 'Content-Type': 'application/json', ...options?.headers }
	const body = JSON.stringify({
		reasoning_effort: 'high',
		venice_parameters: {
			include_venice_system_prompt: false,
		},
		chat_template_kwargs: {
			clear_thinking: false,
			preserve_thinking: true,
		},
		reasoning: {
			enabled: true,
		},
		stream_options: {
			include_usage: true,
		},
		...request,
		stream: true,
	} satisfies CompletionsRequest)
	const signal = options?.signal

	const accumulator: Record<string, unknown> = { role: 'assistant', content: null }
	let finishReason: string | undefined
	let usage: CompletionUsage | undefined

	for await (const sseEvent of readSseStream(dependencies, url, { headers, body, signal })) {
		if (sseEvent.data === '[DONE]') {
			return { message: completeAccumulation(accumulator), finishReason: finishReason, usage }
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

		if (parsed.usage !== undefined) usage = parsed.usage

		if (parsed.choices.length === 0) continue
		const choice = parsed.choices[0]
		if (choice === undefined) continue
		const { delta, finish_reason } = choice

		if (finish_reason) finishReason = finish_reason

		mergeInto(accumulator, delta)

		if (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls) {
			yield delta
		}
	}
	return { message: completeAccumulation(accumulator), finishReason, usage }
}
