import { completions, type CompletionDelta, type CompletionResult, type CompletionsMessage, type CompletionsRequest, type CompletionsToolCall, type CompletionUsage } from './completions.mts'
import type { ProviderProfile } from './provider-profiles.mts'
import { isArrayOf, isRecord, isString } from './typescript-helpers.mts'

export type Fetch = (signal: AbortSignal, body: string, headers?: Record<string, string>) => Promise<Response>

// Return a string to feed it back to the model as a user turn and continue the loop; return null to terminate.
export type OutputValidator = (content: string) => Promise<string | null>

export interface Tool {
	readonly name: string
	readonly description?: string
	readonly parameters?: Record<string, unknown>
	readonly execute: (args: string) => Promise<string>
}

export interface AgentLoopDeltaEvent {
	readonly type: 'delta'
	readonly delta: CompletionDelta
}

export interface AgentLoopCompletionEvent {
	readonly type: 'completion'
	readonly finishReason?: string
	readonly usage?: CompletionUsage
}

export interface AgentLoopToolCallEvent {
	readonly type: 'tool_call'
	readonly toolCall: CompletionsToolCall
}

export interface AgentLoopToolResultEvent {
	readonly type: 'tool_result'
	readonly toolCallId: string
	readonly name: string
	readonly result: string
}

export type AgentLoopEvent =
	| AgentLoopDeltaEvent
	| AgentLoopCompletionEvent
	| AgentLoopToolCallEvent
	| AgentLoopToolResultEvent

export interface AgentLoopResult {
	readonly finishReason: string
	readonly usage?: CompletionUsage
	readonly messages: readonly CompletionsMessage[]
}

const MAX_EMPTY_TURNS = 5

function createIdleTimer(callback: () => void, timeoutMilliseconds: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	return {
		reset() {
			if (timer !== undefined) clearTimeout(timer)
			timer = setTimeout(callback, timeoutMilliseconds)
		},
		cleanup() {
			clearTimeout(timer)
		},
	}
}

function isValidToolParameters(value: Record<string, unknown>): boolean {
	if (value.type !== 'object') return false
	if ('properties' in value && !(isRecord(value.properties) || value.properties === undefined)) return false
	if ('required' in value && !isArrayOf(isString)(value.required)) return false
	return true
}

function toWireTools(tools: readonly Tool[]): CompletionsRequest['tools'] {
	if (tools.length === 0) return undefined
	return tools.map(tool => {
		if (tool.parameters !== undefined && !isValidToolParameters(tool.parameters)) throw new Error(`Tool "${tool.name}" parameters must be a JSON Schema object with type "object", got: ${JSON.stringify(tool.parameters)}`)
		return {
			type: 'function' as const,
			function: {
				name: tool.name,
				...(tool.description !== undefined && { description: tool.description }),
				...(tool.parameters !== undefined && { parameters: tool.parameters }),
			},
		}
	})
}

export async function* agentLoop(dependencies: { fetch: Fetch },  model: string, messages: readonly CompletionsMessage[], tools: readonly Tool[], profile: ProviderProfile, signal?: AbortSignal, outputValidator?: OutputValidator, idleTimeoutMilliseconds: number = 300_000): AsyncGenerator<AgentLoopEvent, AgentLoopResult> {
	const toolMap = new Map(tools.map(tool => [tool.name, tool]))
	const wireTools = toWireTools(tools)
	const mutableMessages: CompletionsMessage[] = [...messages]

	if (mutableMessages.length === 0) throw new Error('At least one message is required')

	const controller = new AbortController()
	const signals: AbortSignal[] = [controller.signal]
	if (signal) signals.push(signal)
	const compositeSignal = AbortSignal.any(signals)
	const boundFetch = (body: string, headers?: Record<string, string>) => dependencies.fetch(compositeSignal, body, headers)

	// This loop is bounded because every tool call and response is appended to `messages`. Eventually the context window of the connected model will be exceeded and the completions() call will fail, so the loop cannot run forever.
	let emptyTurnCount = 0
	while (true) {
		const idleTimer = createIdleTimer(() => { controller.abort(new Error(`Agent loop timed out due to inactivity (no delta received for ${idleTimeoutMilliseconds} milliseconds)`)) }, idleTimeoutMilliseconds)

		const baseRequest: CompletionsRequest = {
			model: model,
			messages: mutableMessages,
			max_tokens: 100_000,
			...(wireTools && { tools: wireTools }),
		}

		const preparedRequest = profile.prepareRequest(baseRequest)
		const completionsGenerator = completions({ fetch: boundFetch }, preparedRequest, profile.overwritePaths)

		let completionResult: CompletionResult
		try {
			idleTimer.reset()
			while (true) {
				const iteratorResult = await completionsGenerator.next()
				if (iteratorResult.done) {
					completionResult = iteratorResult.value
					break
				}
				idleTimer.reset()
				yield { type: 'delta', delta: iteratorResult.value }
			}
		} finally {
			idleTimer.cleanup()
		}

		yield { type: 'completion', finishReason: completionResult.finishReason, usage: completionResult.usage }

		if (completionResult.finishReason === 'length') {
			throw new Error('AI response truncated: model reached maximum output token limit (finishReason: length). Consider increasing max_tokens or reducing prompt size.')
		}

		if (completionResult.finishReason === 'content_filter') {
			throw new Error('AI response blocked by a content filter (finishReason: content_filter). This usually means the provider/model is paternalistically refusing to process the input. Try switching to a less paternalistic provider or model.')
		}

		const message = completionResult.message
		mutableMessages.push(message)

		const toolCalls = 'tool_calls' in message ? message.tool_calls : undefined
		if (toolCalls && toolCalls.length > 0) {
			emptyTurnCount = 0
			for (const toolCall of toolCalls) {
				yield { type: 'tool_call', toolCall }

				const tool = toolMap.get(toolCall.function.name)
				let result: string
				if (!tool) {
					result = `Unknown tool: ${toolCall.function.name}`
				} else {
					try {
						result = await tool.execute(toolCall.function.arguments)
					} catch (error) {
						result = `Tool execution error: ${error instanceof Error ? error.message : String(error)}`
					}
				}

				yield { type: 'tool_result', toolCallId: toolCall.id, name: toolCall.function.name, result }
				mutableMessages.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
			}
			continue
		}

		if (!completionResult.finishReason) continue

		if (!message.content) {
			const usage = completionResult.usage
			if (usage === undefined) throw new Error("Provider did not return token usage in streaming response; cannot determine if turn produced output.")
			if (usage.completion_tokens > 0) {
				emptyTurnCount = 0
			} else {
				emptyTurnCount++
				if (emptyTurnCount >= MAX_EMPTY_TURNS) {
					throw new Error(`Model returned ${MAX_EMPTY_TURNS} consecutive responses with no output tokens. Aborting to prevent an infinite loop.`)
				}
			}
			continue
		}

		const feedback = await outputValidator?.(message.content)
		if (feedback) {
			mutableMessages.push({ role: 'user', content: feedback })
			continue
		}

		return {
			finishReason: completionResult.finishReason,
			usage: completionResult.usage,
			messages: mutableMessages,
		}
	}
}
