import { completions, type CompletionsMessage, type CompletionsToolCall, type CompletionDelta, type CompletionUsage, type CompletionResult, type CompletionsRequest } from './completions.mts'
import { isArrayOf, isRecord, isString } from './typescript-helpers.mts'

export type Fetch = (signal: AbortSignal, body: string, headers?: Record<string, string>) => Promise<Response>

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
	readonly message: CompletionsMessage
	readonly finishReason: string
	readonly usage?: CompletionUsage
	readonly messages: readonly CompletionsMessage[]
}

export interface AgentLoopParams {
	readonly model: string
	readonly messages: readonly CompletionsMessage[]
	readonly tools: readonly Tool[]
	readonly signal?: AbortSignal
	readonly maxTokens?: number
	readonly idleTimeoutMs?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_TOOL_TIMEOUT_MS = 300_000

function createIdleTimer(callback: () => void, timeoutMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	return {
		reset() {
			if (timer !== undefined) clearTimeout(timer)
			timer = setTimeout(callback, timeoutMs)
		},
		cleanup() {
			clearTimeout(timer)
		},
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
		promise.then(resolve, reject).finally(() => clearTimeout(timer))
	})
}

function isValidToolParameters(value: Record<string, unknown>): boolean {
	if (typeof value !== 'object' || value === null) return false
	if (Array.isArray(value)) return false
	if (!('type' in value)) return false
	if (typeof value.type !== 'string' || value.type !== 'object') return false
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

export async function* agentLoop(dependencies: { fetch: Fetch }, params: AgentLoopParams): AsyncGenerator<AgentLoopEvent, AgentLoopResult> {
	const toolMap = new Map(params.tools.map(tool => [tool.name, tool]))
	const messages: CompletionsMessage[] = [...params.messages]
	const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
	const wireTools = toWireTools(params.tools)

	if (params.messages.length === 0) throw new Error('At least one message is required')

	const controller = new AbortController()
	const signals: AbortSignal[] = [controller.signal]
	if (params.signal) signals.push(params.signal)
	const compositeSignal = AbortSignal.any(signals)

	// This loop is bounded because every tool call and response is appended to `messages`. Eventually the context window of the connected model will be exceeded and the completions() call will fail, so the loop cannot run forever.
	while (true) {
		const idleTimer = createIdleTimer(() => {
			controller.abort(new Error(`Agent loop timed out due to inactivity (no delta received for ${idleTimeoutMs}ms)`))
		}, idleTimeoutMs)

		const request: CompletionsRequest = {
			model: params.model,
			messages,
			...(wireTools && { tools: wireTools }),
			...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
		}

		const boundFetch = (body: string, headers?: Record<string, string>) => dependencies.fetch(compositeSignal, body, headers)
		const completionsGenerator = completions({ fetch: boundFetch }, request)

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

		if (completionResult.finishReason === undefined) {
			throw new Error('AI stream ended without a finish reason. The response may have been interrupted before completion.')
		}

		if (completionResult.finishReason === 'length') {
			throw new Error('AI response truncated: model reached maximum output token limit (finishReason: length). Consider increasing max_tokens or reducing prompt size.')
		}

		const message = completionResult.message
		messages.push(message)

		const toolCalls = 'tool_calls' in message ? message.tool_calls : undefined
		if (!toolCalls || toolCalls.length === 0) {
			return {
				message,
				finishReason: completionResult.finishReason,
				usage: completionResult.usage,
				messages,
			}
		}

		for (const toolCall of toolCalls) {
			yield { type: 'tool_call', toolCall }

			const tool = toolMap.get(toolCall.function.name)
			let result: string
			if (!tool) {
				result = `Unknown tool: ${toolCall.function.name}`
			} else {
				try {
					result = await withTimeout(
						tool.execute(toolCall.function.arguments),
						DEFAULT_TOOL_TIMEOUT_MS,
						`Tool "${toolCall.function.name}" timed out after ${DEFAULT_TOOL_TIMEOUT_MS}ms`,
					)
				} catch (error) {
					result = `Tool execution error: ${error instanceof Error ? error.message : String(error)}`
				}
			}

			yield { type: 'tool_result', toolCallId: toolCall.id, name: toolCall.function.name, result }
			messages.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
		}
	}
}
