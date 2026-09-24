import { completions, type CompletionDelta, type CompletionResult, type CompletionsMessage, type CompletionsRequest, type CompletionsToolCall, type CompletionUsage } from './completions.mts'
import type { ProviderProfile } from './provider-profiles.mts'
import { StreamReadError } from './sse.mts'
import { computeBackoffDelay, errorMessage, isArrayOf, isRecord, isString } from './typescript-helpers.mts'

export type Fetch = (signal: AbortSignal, body: string, headers?: Record<string, string>) => Promise<Response>
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>
export type Random = () => number

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

// Caps consecutive wasted turns: failed turns (idle stalls and mid-stream stream-read errors) retried by the turn loop, and completed turns that produced zero output tokens.
const MAX_EMPTY_TURNS = 5

const TURN_RETRY_INITIAL_BACKOFF_MILLISECONDS = 1_000
const TURN_RETRY_MAX_BACKOFF_MILLISECONDS = 30_000

// Idle sentinel: resolves when no delta arrives within the idle window, letting the stream-read loop break and retry the turn without throwing.
function createIdleTimer(timeoutMilliseconds: number): { reset: () => void; cleanup: () => void; expired: Promise<void> } {
	let timer: ReturnType<typeof setTimeout> | undefined
	let resolve: () => void
	const expired = new Promise<void>(resolveExpired => { resolve = resolveExpired })
	return {
		reset() {
			if (timer !== undefined) clearTimeout(timer)
			timer = setTimeout(resolve, timeoutMilliseconds)
		},
		cleanup() {
			clearTimeout(timer)
		},
		expired,
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

export async function* agentLoop(dependencies: { fetch: Fetch; sleep: Sleep; random: Random },  model: string, messages: readonly CompletionsMessage[], tools: readonly Tool[], profile: ProviderProfile, signal?: AbortSignal, outputValidator?: OutputValidator, idleTimeoutMilliseconds: number = 240_000): AsyncGenerator<AgentLoopEvent, AgentLoopResult> {
	// Must stay below Bun's socket idle timeout (hard-coded 300s on 1.3.12; tunable via BUN_CONFIG_HTTP_IDLE_TIMEOUT in a future Bun) so this non-throwing retry fires first on a stalled stream.
	const toolMap = new Map(tools.map(tool => [tool.name, tool]))
	const wireTools = toWireTools(tools)
	const mutableMessages: CompletionsMessage[] = [...messages]

	if (mutableMessages.length === 0) throw new Error('At least one message is required')

	// `controller` aborts the in-flight fetch when a turn is retried after a failed turn (idle stall or stream error); `signal` propagates genuine caller abort (e.g. process shutdown).
	const callerSignals: AbortSignal[] = signal ? [signal] : []

	// This loop is bounded because every tool call and response is appended to `messages`. Eventually the context window of the connected model will be exceeded and the completions() call will fail, so the loop cannot run forever.
	let emptyTurnCount = 0
	let turnRetryCount = 0
	let lastTurnFailure: { readonly kind: 'idle' } | { readonly kind: 'error'; readonly error: unknown } | undefined
	while (true) {
		const controller = new AbortController()
		const compositeSignal = AbortSignal.any([...callerSignals, controller.signal])
		const boundFetch = (body: string, headers?: Record<string, string>) => dependencies.fetch(compositeSignal, body, headers)

		const idleTimer = createIdleTimer(idleTimeoutMilliseconds)

		const baseRequest: CompletionsRequest = {
			model: model,
			messages: mutableMessages,
			max_tokens: 100_000,
			...(wireTools && { tools: wireTools }),
		}

		const preparedRequest = profile.prepareRequest(baseRequest)
		const completionsGenerator = completions({ fetch: boundFetch }, preparedRequest, profile.overwritePaths)

		let completionResult: CompletionResult | undefined
		try {
			idleTimer.reset()
			while (true) {
				const raced = await Promise.race([
					completionsGenerator.next(),
					idleTimer.expired.then(() => undefined),
				])
				if (raced === undefined) {
					// Idle window elapsed with no delta: abort the in-flight fetch so it doesn't leak, then retry the turn.
					controller.abort()
					lastTurnFailure = { kind: 'idle' }
					break
				}
				const iteratorResult = raced
				if (iteratorResult.done) {
					completionResult = iteratorResult.value
					break
				}
				idleTimer.reset()
				yield { type: 'delta', delta: iteratorResult.value }
			}
		} catch (error) {
			if (!(error instanceof StreamReadError)) throw error
			if (signal?.aborted) throw error
			controller.abort()
			lastTurnFailure = { kind: 'error', error }
			// MUST NOT continue/return: fall through to the shared failure-counting block
		} finally {
			idleTimer.cleanup()
		}

		if (completionResult === undefined) {
			turnRetryCount++
			if (turnRetryCount >= MAX_EMPTY_TURNS) {
				if (lastTurnFailure !== undefined && lastTurnFailure.kind === 'error') {
					throw new Error(`Agent loop failed: ${MAX_EMPTY_TURNS} consecutive turns failed without producing a result. Last error: ${errorMessage(lastTurnFailure.error)}`)
				}
				throw new Error(`Agent loop stalled: no delta received within ${idleTimeoutMilliseconds}ms for ${MAX_EMPTY_TURNS} consecutive turns.`)
			}
			const jitteredDelay = computeBackoffDelay(turnRetryCount - 1, TURN_RETRY_INITIAL_BACKOFF_MILLISECONDS, TURN_RETRY_MAX_BACKOFF_MILLISECONDS, dependencies.random())
			await dependencies.sleep(jitteredDelay, signal)
			continue
		}

		turnRetryCount = 0
		lastTurnFailure = undefined

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
						result = `Tool execution error: ${errorMessage(error)}`
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
			emptyTurnCount = 0
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
