import { type Fetch, readSseStream } from './sse.mts'
import { type Guard, guard, type GuardedType, isArray, isArrayOf, isInteger, isLiteral, isRecord, isString, optional } from './typescript-helpers.mts'

const isStringOrNull: Guard<string | null> = (v): v is string | null => isString(v) || v === null

const isSseCompletionEvent = guard({
	choices: isArrayOf(guard({
		delta: guard({
			content: optional(isStringOrNull),
			reasoning: optional(isStringOrNull),
			reasoning_content: optional(isStringOrNull),
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
		finish_reason: optional(isStringOrNull),
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
		content: isStringOrNull,
		reasoning: optional(isStringOrNull),
		reasoning_content: optional(isStringOrNull),
		tool_calls: optional(isArrayOf(isAssistantMessageToolCall)),
	})
	if (!isValid(value)) return false
	if (value.reasoning !== undefined && value.reasoning_content !== undefined) {
		// Exception to the Guard contract: a provider sending both fields is a bug that must fail fast rather than be silently ignored.
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

export type CompletionDelta = GuardedType<typeof isSseCompletionEvent>['choices'][number]['delta']
export type CompletionUsage = NonNullable<GuardedType<typeof isSseCompletionEvent>['usage']>

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue
		if (key === 'tool_calls' && isArray(value)) {
			mergeToolCalls(target, value)
			continue
		}
		// Atomic fields that must be overwritten, not concatenated, when they reappear in a later delta
		if (key === 'role' || key === 'type' || key === 'id' || key === 'index') {
			target[key] = value
			continue
		}
		const existing = target[key]
		if (typeof existing === 'string' && typeof value === 'string' && value !== '') {
			target[key] = existing + value
		} else if (value !== null && value !== '') {
			if (isRecord(value) && isRecord(existing)) {
				mergeInto(existing, value)
			} else {
				target[key] = value
			}
		}
	}
}

// Merge streaming tool call deltas into their respective slots by index
function mergeToolCalls(target: Record<string, unknown>, toolCalls: unknown[]): void {
	const existing = target.tool_calls as unknown[]
	for (const toolCall of toolCalls) {
		if (!isRecord(toolCall)) continue
		const index = isInteger(toolCall.index) ? toolCall.index : existing.length
		if (!isRecord(existing[index])) {
			existing[index] = { type: 'function', function: { name: '', arguments: '' } }
		}
		const slot = existing[index]
		if (isRecord(slot)) {
			mergeInto(slot, toolCall)
		}
	}
}

// Final validation that the accumulated object matches the assistant message contract
function completeAccumulation(accumulator: Record<string, unknown>): CompletionsMessage {
	// Empty tool_calls array should be absent from the final message, not present as []
	if (isArray(accumulator.tool_calls) && accumulator.tool_calls.length === 0) {
		delete accumulator.tool_calls
	}
	// Strip routing index from final tool calls; it is part of the wire format, not the message schema
	if (isArray(accumulator.tool_calls)) {
		for (const toolCall of accumulator.tool_calls) {
			if (isRecord(toolCall)) delete toolCall.index
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

	const accumulator: Record<string, unknown> = { role: 'assistant', content: null, tool_calls: [] }
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
