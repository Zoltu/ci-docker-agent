import { completions, type CompletionsMessage, type CompletionsToolCall, type CompletionDelta, type CompletionUsage, type CompletionResult, type CompletionsRequest } from './completions.mts'

export type FetchWithSignal = (signal: AbortSignal, body: string, headers?: Record<string, string>) => Promise<Response>

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

function toWireTools(tools: readonly Tool[]): CompletionsRequest['tools'] {
	if (tools.length === 0) return undefined
	return tools.map(tool => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			...(tool.description !== undefined && { description: tool.description }),
			...(tool.parameters !== undefined && { parameters: tool.parameters }),
		},
	}))
}

function getToolCalls(message: CompletionsMessage): readonly CompletionsToolCall[] | undefined {
	if (!('tool_calls' in message)) return undefined
	const toolCalls = message.tool_calls
	if (toolCalls === undefined || toolCalls.length === 0) return undefined
	return toolCalls
}

export async function* agentLoop(dependencies: { fetch: FetchWithSignal }, params: AgentLoopParams): AsyncGenerator<AgentLoopEvent, AgentLoopResult> {
	const toolMap = new Map(params.tools.map(tool => [tool.name, tool]))
	const messages: CompletionsMessage[] = [...params.messages]
	const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
	const wireTools = toWireTools(params.tools)

	while (true) {
		const controller = new AbortController()
		let idleExpired = false

		if (params.signal) {
			if (params.signal.aborted) {
				controller.abort()
			} else {
				params.signal.addEventListener('abort', () => controller.abort(), { signal: controller.signal })
			}
		}

		const idleTimer = createIdleTimer(() => {
			idleExpired = true
			controller.abort()
		}, idleTimeoutMs)

		const request: CompletionsRequest = {
			model: params.model,
			messages,
			...(wireTools && { tools: wireTools }),
			...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
		}

		const boundFetch = (body: string, headers?: Record<string, string>) => dependencies.fetch(controller.signal, body, headers)
		const gen = completions({ fetch: boundFetch }, request)

		let completionResult: CompletionResult
		try {
			idleTimer.reset()
			while (true) {
				let iterResult: IteratorResult<CompletionDelta, CompletionResult>
				try {
					iterResult = await gen.next()
				} catch (error) {
					if (idleExpired) {
						throw new Error(`Agent loop timed out due to inactivity (no delta received for ${idleTimeoutMs}ms)`)
					}
					throw error
				}
				if (iterResult.done) {
					completionResult = iterResult.value
					break
				}
				idleTimer.reset()
				yield { type: 'delta', delta: iterResult.value }
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
		const toolCalls = getToolCalls(message)
		if (!toolCalls) {
			return {
				message,
				finishReason: completionResult.finishReason,
				usage: completionResult.usage,
				messages,
			}
		}

		messages.push(message)

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
			messages.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
		}
	}
}
