import { describe, it, expect } from "bun:test"
import { agentLoop, type AgentLoopEvent, type AgentLoopResult, type Fetch, type OutputValidator, type Random, type Sleep, type Tool } from "../source/agent-loop.mts"
import type { CompletionsMessage } from "../source/completions.mts"
import { IDENTITY_PROFILE } from "../source/provider-profiles.mts"
import { FetchRetriesExhaustedError } from "../source/ai.mts"

const instantSleep: Sleep = async () => {}
const fixedRandom: Random = () => 1

function chunk(delta: Record<string, unknown>, finish_reason: string | null = null): object {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1234,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason }],
	}
}

function usageChunk(usage: object): object {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1234,
		model: "test-model",
		choices: [],
		usage,
	}
}

function buildSse(chunks: object[]): string {
	return chunks.map((c, i) => {
		if (i !== 0) return `data: ${JSON.stringify(c)}\n\n`
		const obj = c as { choices: Array<{ delta: Record<string, unknown> }> }
		const firstDelta = obj.choices?.[0]?.delta
		if (!firstDelta || 'role' in firstDelta) return `data: ${JSON.stringify(c)}\n\n`
		return `data: ${JSON.stringify({ ...obj, choices: [{ ...obj.choices[0], delta: { role: "assistant", ...firstDelta } }] })}\n\n`
	}).join("") + "data: [DONE]\n\n"
}

type ResponseProvider = (request: { messages: readonly CompletionsMessage[]; callIndex: number }) => string

function createFetchWithSignal(provider: ResponseProvider): { fetch: Fetch; callCount: () => number } {
	let callIndex = 0
	const fetchWithSignal: Fetch = async (_signal: AbortSignal, body: string, _headers?: Record<string, string>) => {
		const request = JSON.parse(body)
		const sseText = provider({ messages: request.messages, callIndex })
		callIndex++
		const encoder = new TextEncoder()
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText))
				controller.close()
			},
		})
		return new Response(stream, { status: 200 })
	}
	return { fetch: fetchWithSignal, callCount: () => callIndex }
}

function createHangingFetchWithSignal(): Fetch {
	return (signal: AbortSignal, _body: string, _headers?: Record<string, string>) => {
		return new Promise<Response>((_resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason)
				return
			}
			signal.addEventListener("abort", () => {
				reject(signal.reason)
			}, { once: true })
		})
	}
}

async function collectLoop(gen: AsyncGenerator<AgentLoopEvent, AgentLoopResult>): Promise<{ events: AgentLoopEvent[]; result: AgentLoopResult }> {
	const events: AgentLoopEvent[] = []
	while (true) {
		const { value, done } = await gen.next()
		if (done) return { events, result: value }
		events.push(value)
	}
}

const TOOLS: readonly Tool[] = [
	{
		name: "read_file",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: async (args) => {
			const parsed = JSON.parse(args)
			return `Contents of ${parsed.path}`
		},
	},
	{
		name: "search",
		description: "Search files",
		parameters: { type: "object", properties: { query: { type: "string" } } },
		execute: async (args) => {
			const parsed = JSON.parse(args)
			return `Results for ${parsed.query}`
		},
	},
]

describe("agentLoop", () => {
	describe("simple completion (no tool calls)", () => {
		it("returns the assistant message directly", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "Hello" }),
					chunk({ content: " world" }),
					chunk({}, "stop"),
				]),
			)
			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			expect(result.messages.at(-1)).toEqual({
				role: "assistant",
				content: "Hello world",
			})
			expect(result.finishReason).toBe("stop")
		})

		it("includes usage in result", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "answer" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
				]),
			)
			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			expect(result.usage).toEqual({
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			})
		})

		it("includes original messages in result", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "ok" }),
					chunk({}, "stop"),
				]),
			)
			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [
				{ role: "system", content: "You are helpful" },
				{ role: "user", content: "hi" },
			], [], IDENTITY_PROFILE))
			expect(result.messages).toEqual([
				{ role: "system", content: "You are helpful" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "ok" },
			])
		})
	})

	describe("tool call loop", () => {
		it("executes tool calls and loops until content response", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "The file shows no issues" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "review" }], TOOLS, IDENTITY_PROFILE))

			expect(callCount()).toBe(2)
			expect(result.messages.at(-1)).toEqual({
				role: "assistant",
				content: "The file shows no issues",
			})
			expect(result.finishReason).toBe("stop")
		})

		it("passes tool results back to the model", async () => {
			const { fetch } = createFetchWithSignal(({ messages, callIndex }) => {
				if (callIndex === 0) {
					return buildSse([
						chunk({
							tool_calls: [{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
							}],
						}, "tool_calls"),
					])
				}
				const lastMessage = messages[messages.length - 1]
				if (lastMessage && 'role' in lastMessage && lastMessage.role === "tool") {
					expect(lastMessage.content).toBe("Contents of src/a.ts")
					expect(lastMessage.tool_call_id).toBe("call_1")
				}
				return buildSse([
					chunk({ content: "Done" }),
					chunk({}, "stop"),
				])
			})

			await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))
		})

		it("handles multiple tool calls in one round", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [
							{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
							{ index: 1, id: "call_2", type: "function", function: { name: "search", arguments: '{"query":"TODO"}' } },
						],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "All clear" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events, result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "review" }], TOOLS, IDENTITY_PROFILE))

			const toolCallEvents = events.filter(e => e.type === "tool_call")
			const toolResultEvents = events.filter(e => e.type === "tool_result")
			expect(toolCallEvents).toHaveLength(2)
			expect(toolResultEvents).toHaveLength(2)

			expect(result.messages.at(-1)).toEqual({
				role: "assistant",
				content: "All clear",
			})
		})

		it("handles multiple rounds of tool calls", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_2", type: "function", function: { name: "search", arguments: '{"query":"TODO"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "Final answer" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "review" }], TOOLS, IDENTITY_PROFILE))

			expect(callCount()).toBe(3)
			expect(result.messages.at(-1)).toEqual({
				role: "assistant",
				content: "Final answer",
			})
		})

		it("accumulates messages across rounds", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "Done" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			expect(result.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
				{ role: "tool", content: "Contents of a.ts", tool_call_id: "call_1" },
				{ role: "assistant", content: "Done" },
			])
		})
	})

	describe("events", () => {
		it("yields delta events from completions", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ reasoning: "thinking" }),
					chunk({ content: "answer" }),
					chunk({}, "stop"),
				]),
			)
			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			const deltaEvents = events.filter(e => e.type === "delta")
			expect(deltaEvents).toHaveLength(3)
			if (deltaEvents[0]!.type === "delta") {
				expect(deltaEvents[0]!.delta.reasoning).toBe("thinking")
			}
			if (deltaEvents[1]!.type === "delta") {
				expect(deltaEvents[1]!.delta.content).toBe("answer")
			}
			if (deltaEvents[2]!.type === "delta") {
				expect(deltaEvents[2]!.delta).toEqual({})
			}
		})

		it("yields completion event with finishReason and usage", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "ok" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
				]),
			)
			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			const completionEvents = events.filter(e => e.type === "completion")
			expect(completionEvents).toHaveLength(1)
			if (completionEvents[0]!.type === "completion") {
				expect(completionEvents[0]!.finishReason).toBe("stop")
				expect(completionEvents[0]!.usage).toEqual({
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				})
			}
		})

		it("yields tool_call event before execution", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "done" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			const toolCallEvent = events.find(e => e.type === "tool_call")
			expect(toolCallEvent).toBeDefined()
			if (toolCallEvent && toolCallEvent.type === "tool_call") {
				expect(toolCallEvent.toolCall.id).toBe("call_1")
				expect(toolCallEvent.toolCall.function.name).toBe("read_file")
				expect(toolCallEvent.toolCall.function.arguments).toBe('{"path":"a.ts"}')
			}
		})

		it("yields tool_result event after execution", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "done" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			const toolResultEvent = events.find(e => e.type === "tool_result")
			expect(toolResultEvent).toBeDefined()
			if (toolResultEvent && toolResultEvent.type === "tool_result") {
				expect(toolResultEvent.toolCallId).toBe("call_1")
				expect(toolResultEvent.name).toBe("read_file")
				expect(toolResultEvent.result).toBe("Contents of a.ts")
			}
		})

		it("yields events in correct order across multiple rounds", async () => {
			const responses = [
				buildSse([
					chunk({ content: "let me check" }),
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "all good" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			const eventTypes = events.map(e => e.type)
			expect(eventTypes).toEqual([
				"delta",
				"delta",
				"completion",
				"tool_call",
				"tool_result",
				"delta",
				"delta",
				"completion",
			])
		})
	})

	describe("continuation turns", () => {
		it("continues when finishReason is undefined", async () => {
			const responses = [
				buildSse([
					chunk({ content: "partial" }),
				]),
				buildSse([
					chunk({ content: " complete" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			expect(callCount()).toBe(2)
			expect(result.finishReason).toBe("stop")
			expect(result.messages.length).toBe(3)
		})

		it("yields completion event for each turn including incomplete ones", async () => {
			const responses = [
				buildSse([
					chunk({ content: "partial" }),
				]),
				buildSse([
					chunk({ content: " done" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			const completionEvents = events.filter(e => e.type === "completion")
			expect(completionEvents).toHaveLength(2)
			if (completionEvents[0]!.type === "completion") {
				expect(completionEvents[0]!.finishReason).toBeUndefined()
			}
			if (completionEvents[1]!.type === "completion") {
				expect(completionEvents[1]!.finishReason).toBe("stop")
			}
		})

		it("continues when content is null", async () => {
			const responses = [
				buildSse([
					chunk({ reasoning: "thinking" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
				]),
				buildSse([
					chunk({ content: "answer" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			expect(callCount()).toBe(2)
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)!.content).toBe("answer")
		})

		it("continues when content is empty string", async () => {
			const responses = [
				buildSse([
					chunk({ content: "" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }),
				]),
				buildSse([
					chunk({ content: "actual answer" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			expect(callCount()).toBe(2)
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)!.content).toBe("actual answer")
		})

		it("does not continue when content is non-empty string", async () => {
			const { fetch, callCount } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "real content" }),
					chunk({}, "stop"),
				]),
			)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			expect(callCount()).toBe(1)
			expect(result.finishReason).toBe("stop")
		})

		it("continues through multiple empty turns before content", async () => {
			const responses = [
				buildSse([
					chunk({ reasoning: "thinking step 1" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
				]),
				buildSse([
					chunk({ reasoning: "thinking step 2" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 }),
				]),
				buildSse([
					chunk({ reasoning: "thinking step 3" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 22, completion_tokens: 9, total_tokens: 31 }),
				]),
				buildSse([
					chunk({ content: "final answer" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			expect(callCount()).toBe(4)
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)!.content).toBe("final answer")
		})

		it("throws when provider does not return usage on a no-content turn", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ reasoning: "thinking" }),
					chunk({}, "stop"),
				]),
			)
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("Provider did not return token usage in streaming response")
		})

		it("throws after MAX_EMPTY_TURNS consecutive responses with zero completion tokens", async () => {
			const responses = Array.from({ length: 5 }, () =>
				buildSse([
					chunk({ reasoning: "thinking" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }),
				]),
			)
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("5 consecutive responses with no output tokens")
			expect(callCount()).toBe(5)
		})

		it("resets empty-turn counter when completion tokens are greater than zero between zero-token turns", async () => {
			const responses = [
				buildSse([
					chunk({ reasoning: "thinking" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }),
				]),
				buildSse([
					chunk({ reasoning: "thinking more" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
				]),
				buildSse([
					chunk({ reasoning: "thinking again" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 15, completion_tokens: 0, total_tokens: 15 }),
				]),
				buildSse([
					chunk({ content: "final" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			expect(callCount()).toBe(4)
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)!.content).toBe("final")
		})

		it("includes prior assistant messages in subsequent requests", async () => {
			const capturedBodies: string[] = []
			const responses = [
				buildSse([
					chunk({ reasoning: "hmm" }),
					chunk({}, "stop"),
					usageChunk({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }),
				]),
				buildSse([
					chunk({ content: "answer" }),
					chunk({}, "stop"),
				]),
			]
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBodies.push(body)
				const callIndex = capturedBodies.length - 1
				const sseText = responses[callIndex] ?? responses[responses.length - 1]!
				return createMockFetchResponse(sseText)
			}

			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))

			const secondRequest = JSON.parse(capturedBodies[1]!)
			expect(secondRequest.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", reasoning: "hmm" },
			])
		})

		it("does not continue when message has tool calls", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "done" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			expect(callCount()).toBe(2)
			expect(result.finishReason).toBe("stop")
		})

		it("throws when finishReason is length", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "truncated" }),
					chunk({}, "length"),
				]),
			)
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("AI response truncated")
		})

		it("continues when no finish reason and no content, then gets tool calls", async () => {
			const responses = [
				buildSse([
					chunk({ reasoning: "let me think" }),
				]),
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "final" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			expect(callCount()).toBe(3)
			expect(result.finishReason).toBe("stop")
		})
	})

	describe("idle timeout", () => {
		it("retries the turn when no deltas arrive within idle timeout, then stalls after max retries", async () => {
			const fetch = createHangingFetchWithSignal()
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, undefined, 50))).rejects.toThrow("Agent loop stalled")
		})

		it("includes timeout duration in stall error message", async () => {
			const fetch = createHangingFetchWithSignal()
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, undefined, 123))).rejects.toThrow("123ms")
		})

		it("resets idle timer on each delta", async () => {
			const chunks = [
				`data: ${JSON.stringify(chunk({ role: "assistant", content: "chunk1" }))}\n\n`,
				`data: ${JSON.stringify(chunk({ content: "chunk2" }))}\n\n`,
				`data: ${JSON.stringify(chunk({ content: "chunk3" }))}\n\n`,
				`data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
			]
			const encoder = new TextEncoder()
			let chunkIndex = 0
			const fetchWithSignal: Fetch = async (_signal, _body, _headers) => {
				const stream = new ReadableStream({
					pull(controller) {
						if (chunkIndex < chunks.length) {
							controller.enqueue(encoder.encode(chunks[chunkIndex]))
							chunkIndex++
						}
						if (chunkIndex >= chunks.length) {
							controller.close()
						}
					},
				})
				return new Response(stream, { status: 200 })
			}
			const { result } = await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, undefined, 50))
			expect(result.finishReason).toBe("stop")
		})
	})

	describe("mid-stream errors", () => {
		it("retries the turn after a mid-stream error that follows a delta", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				const index = count++
				if (index === 0) {
					return createMockFetchResponseThenError(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`, new Error("connection reset"))
				}
				return createMockFetchResponse(buildSse([chunk({ content: "recovered" }), chunk({}, "stop")]))
			}
			const { events, result } = await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			expect(count).toBe(2)
			expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "recovered" })
			const seenContents = events.flatMap(e => e.type === "delta" ? [e.delta.content ?? ""] : [])
			expect(seenContents).toContain("partial")
			expect(seenContents).toContain("recovered")
		})

		it("retries the turn after a stream error before any delta", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				const index = count++
				if (index === 0) return createMockFetchResponseErrorImmediately(new Error("connection reset"))
				return createMockFetchResponse(buildSse([chunk({ content: "recovered" }), chunk({}, "stop")]))
			}
			const { result } = await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			expect(count).toBe(2)
			expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "recovered" })
		})

		it("does not retry when the fetch rejects", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				const index = count++
				if (index === 0) throw new Error("connection refused")
				return createMockFetchResponse(buildSse([chunk({ content: "recovered" }), chunk({}, "stop")]))
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("connection refused")
			expect(count).toBe(1)
		})

		it("does not retry when the caller's abort signal fires", async () => {
			const controller = new AbortController()
			let count = 0
			const fetchWithSignal: Fetch = (signal, _body, _headers) => {
				count++
				return new Promise<Response>((_resolve, reject) => {
					const onAbort = () => reject(new Error("aborted by caller"))
					if (signal.aborted) {
						onAbort()
						return
					}
					signal.addEventListener("abort", onAbort, { once: true })
				})
			}
			setTimeout(() => controller.abort(), 20)
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, controller.signal))).rejects.toThrow("aborted by caller")
			expect(count).toBe(1)
		})

		it("throws a stream-read failure message after MAX_EMPTY_TURNS consecutive errors", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				count++
				return createMockFetchResponseErrorImmediately(new Error("connection reset"))
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("Agent loop failed: 5 consecutive turns failed without producing a result. Last error: Stream read failed: connection reset")
			expect(count).toBe(5)
		})

		it("counts idle stalls and stream errors in a single streak", async () => {
			let count = 0
			const hangingFetch = createHangingFetchWithSignal()
			const fetchWithSignal: Fetch = (signal, body, headers) => {
				const index = count++
				if (index % 2 === 1) return hangingFetch(signal, body, headers)
				return Promise.resolve(createMockFetchResponseErrorImmediately(new Error(`failure ${index}`)))
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, undefined, 50))).rejects.toThrow("Agent loop failed: 5 consecutive turns failed without producing a result. Last error: Stream read failed: failure 4")
			expect(count).toBe(5)
		})

		it("mixed failure streak ending in idle reports idle message", async () => {
			let count = 0
			const hangingFetch = createHangingFetchWithSignal()
			const fetchWithSignal: Fetch = (signal, body, headers) => {
				const index = count++
				if (index === 0 || index === 2) return Promise.resolve(createMockFetchResponseErrorImmediately(new Error(`failure ${index}`)))
				return hangingFetch(signal, body, headers)
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, undefined, 50))).rejects.toThrow("Agent loop stalled")
			expect(count).toBe(5)
		})

		it("does not retry turn on HTTP status error", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				count++
				return new Response("service unavailable", { status: 503, statusText: "Service Unavailable" })
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("HTTP 503 Service Unavailable")
			expect(count).toBe(1)
		})

		it("does not retry on FetchRetriesExhaustedError", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				count++
				throw new FetchRetriesExhaustedError(new Error("network down"))
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow(FetchRetriesExhaustedError)
			expect(count).toBe(1)
		})

		it("does not retry on parse errors", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				count++
				return createMockFetchResponse("data: {not json\n\n")
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("Failed to parse SSE data as JSON")
			expect(count).toBe(1)
		})

		it("applies backoff between turn retries", async () => {
			const delays: number[] = []
			const recordingSleep: Sleep = async (ms) => { delays.push(ms) }
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				const index = count++
				if (index < 2) return createMockFetchResponseErrorImmediately(new Error(`failure ${index}`))
				return createMockFetchResponse(buildSse([chunk({ content: "recovered" }), chunk({}, "stop")]))
			}
			const { result } = await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: recordingSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, new AbortController().signal))
			expect(delays.length).toBeGreaterThan(0)
			for (let i = 1; i < delays.length; i++) {
				expect(delays[i]!).toBeGreaterThan(delays[i - 1]!)
			}
			expect(result.finishReason).toBe("stop")
		})

		it("backoff delays stay within bounds", async () => {
			const delays: number[] = []
			const recordingSleep: Sleep = async (ms) => { delays.push(ms) }
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				const index = count++
				if (index < 4) return createMockFetchResponseErrorImmediately(new Error(`failure ${index}`))
				return createMockFetchResponse(buildSse([chunk({ content: "recovered" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: recordingSleep, random: () => 1 }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, new AbortController().signal))
			expect(delays.length).toBeGreaterThan(0)
			for (const delay of delays) {
				expect(delay).toBeLessThanOrEqual(30_000 * 1.0)
			}
		})

		it("does not reset the retry counter when a delta arrives before the error", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				count++
				return createMockFetchResponseThenError(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`, new Error("connection reset"))
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("Agent loop failed: 5 consecutive turns failed without producing a result")
			expect(count).toBe(5)
		})

		it("resets the retry counter after a completed turn between error streaks", async () => {
			let count = 0
			const fetchWithSignal: Fetch = async () => {
				const index = count++
				if (index === 2) return createMockFetchResponse(buildSse([chunk({ content: "partial" })]))
				return createMockFetchResponseErrorImmediately(new Error(`failure ${index}`))
			}
			await expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))).rejects.toThrow("Agent loop failed: 5 consecutive turns failed without producing a result. Last error: Stream read failed: failure 7")
			expect(count).toBe(8)
		})
	})

	describe("external abort", () => {
		it("propagates error when external signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()
			const fetchWithSignal: Fetch = (signal, _body, _headers) => {
				return new Promise<Response>((_resolve, reject) => {
					if (signal.aborted) {
						reject(new DOMException("The operation was aborted.", "AbortError"))
						return
					}
				})
			}
			expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, controller.signal))).rejects.toThrow()
		})

		it("aborts in-progress request when signal fires", async () => {
			const controller = new AbortController()
			const fetchWithSignal: Fetch = (signal, _body, _headers) => {
				return new Promise<Response>((_resolve, reject) => {
					const onAbort = () => {
						reject(new DOMException("The operation was aborted.", "AbortError"))
					}
					if (signal.aborted) {
						onAbort()
						return
					}
					signal.addEventListener("abort", onAbort, { once: true })
					controller.signal.addEventListener("abort", onAbort, { once: true })
				})
			}
			setTimeout(() => controller.abort(), 30)
			expect(collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, controller.signal))).rejects.toThrow()
		})
	})

	describe("tool error handling", () => {
		it("returns error message for unknown tool", async () => {
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "unknown_tool", arguments: "{}" },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "I see the tool was not found" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events, result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			const toolResultEvent = events.find(e => e.type === "tool_result")
			if (toolResultEvent && toolResultEvent.type === "tool_result") {
				expect(toolResultEvent.result).toBe("Unknown tool: unknown_tool")
			}
			expect(result.finishReason).toBe("stop")
		})

		it("returns error message when tool execution throws", async () => {
			const failingTool: Tool = {
				name: "failing_tool",
				description: "A tool that fails",
				execute: async () => { throw new Error("Disk full") },
			}
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "failing_tool", arguments: "{}" },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "Tool failed" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events, result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [failingTool], IDENTITY_PROFILE))

			const toolResultEvent = events.find(e => e.type === "tool_result")
			if (toolResultEvent && toolResultEvent.type === "tool_result") {
				expect(toolResultEvent.result).toContain("Tool execution error")
				expect(toolResultEvent.result).toContain("Disk full")
			}
			expect(result.finishReason).toBe("stop")
		})

		it("handles non-Error thrown from tool execution", async () => {
			const stringThrowTool: Tool = {
				name: "string_throw",
				description: "Throws a string",
				execute: async () => { throw "something went wrong" },
			}
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "string_throw", arguments: "{}" },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "handled" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex] ?? responses[responses.length - 1]!)

			const { events } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [stringThrowTool], IDENTITY_PROFILE))

			const toolResultEvent = events.find(e => e.type === "tool_result")
			if (toolResultEvent && toolResultEvent.type === "tool_result") {
				expect(toolResultEvent.result).toContain("something went wrong")
			}
		})
	})

	describe("tool parameter validation", () => {
		it("throws when tool parameters is missing type field", async () => {
			const tool: Tool = {
				name: "bad_tool",
				description: "Bad tool",
				parameters: { properties: { path: { type: "string" } } },
				execute: async () => "",
			}
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "ok" }), chunk({}, "stop")]),
			)
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [tool], IDENTITY_PROFILE))).rejects.toThrow('Tool "bad_tool" parameters must be a JSON Schema object with type "object"')
		})

		it("throws when tool parameters has wrong type value", async () => {
			const tool: Tool = {
				name: "bad_tool",
				description: "Bad tool",
				parameters: { type: "string", properties: { path: { type: "string" } } },
				execute: async () => "",
			}
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "ok" }), chunk({}, "stop")]),
			)
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [tool], IDENTITY_PROFILE))).rejects.toThrow('Tool "bad_tool" parameters must be a JSON Schema object with type "object"')
		})
	})

	describe("request construction", () => {
		it("passes model to completions request", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "my-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.model).toBe("my-model")
		})

		it("converts tools to wire format", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [TOOLS[0]!], IDENTITY_PROFILE))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.tools).toEqual([{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			}])
		})

		it("omits tools from request when tools array is empty", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.tools).toBeUndefined()
		})

		it("omits description from wire format when not provided", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [{ name: "bare_tool", execute: async () => "" }], IDENTITY_PROFILE))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.tools).toEqual([{
				type: "function",
				function: { name: "bare_tool" },
			}])
		})

		it("passes messages with tool results in subsequent round", async () => {
			const capturedBodies: string[] = []
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([
					chunk({ content: "done" }),
					chunk({}, "stop"),
				]),
			]
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBodies.push(body)
				const callIndex = capturedBodies.length - 1
				const sseText = responses[callIndex] ?? responses[responses.length - 1]!
				return createMockFetchResponse(sseText)
			}

			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE))

			const secondRequest = JSON.parse(capturedBodies[1]!)
			expect(secondRequest.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
				{ role: "tool", content: "Contents of a.ts", tool_call_id: "call_1" },
			])
		})
	})

	describe("signal passing", () => {
		it("passes signal to fetch via currying", async () => {
			let capturedSignal: AbortSignal | undefined
			const fetchWithSignal: Fetch = async (signal, _body, _headers) => {
				capturedSignal = signal
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			const controller = new AbortController()
			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, controller.signal))
			expect(capturedSignal).toBeDefined()
			expect(capturedSignal!.aborted).toBe(false)
		})
	})

	describe("default idle timeout", () => {
		it("defaults to 240000ms", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "ok" }), chunk({}, "stop")]),
			)
			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			expect(result.finishReason).toBe("stop")
		})
	})

	describe("outputValidator callback", () => {
		it("terminates normally when callback returns null", async () => {
			const outputValidator: OutputValidator = async () => null
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "done" }), chunk({}, "stop")]),
			)
			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, outputValidator))
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "done" })
		})

		it("continues the loop and feeds back the callback's string as a user turn", async () => {
			const responses = [
				buildSse([
					chunk({ content: "first attempt" }),
					chunk({}, "stop"),
				]),
				buildSse([
					chunk({ content: "second attempt" }),
					chunk({}, "stop"),
				]),
			]
			const { fetch, callCount } = createFetchWithSignal(({ callIndex }) => responses[callIndex]!)

			const observedContents: string[] = []
			let callCount$ = 0
			const outputValidator: OutputValidator = async (content) => {
				observedContents.push(content)
				callCount$++
				if (callCount$ === 1) return "your previous output was invalid; please correct it"
				return null
			}

			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, outputValidator))

			expect(observedContents).toEqual(["first attempt", "second attempt"])
			expect(callCount()).toBe(2)
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "second attempt" })
			expect(result.messages.at(-2)).toEqual({ role: "user", content: "your previous output was invalid; please correct it" })
			expect(result.messages.at(-3)).toEqual({ role: "assistant", content: "first attempt" })
		})

		it("includes the injected user turn in the next completions request", async () => {
			const capturedBodies: string[] = []
			const responses = [
				buildSse([chunk({ content: "first" }), chunk({}, "stop")]),
				buildSse([chunk({ content: "second" }), chunk({}, "stop")]),
			]
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBodies.push(body)
				const callIndex = capturedBodies.length - 1
				const sseText = responses[callIndex] ?? responses[responses.length - 1]!
				return createMockFetchResponse(sseText)
			}

			let callbackCalls = 0
			const outputValidator: OutputValidator = async () => {
				callbackCalls++
				if (callbackCalls === 1) return "feedback message"
				return null
			}

			await collectLoop(agentLoop({ fetch: fetchWithSignal, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, outputValidator))

			const secondRequest = JSON.parse(capturedBodies[1]!)
			expect(secondRequest.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "first" },
				{ role: "user", content: "feedback message" },
			])
		})

		it("propagates throws from the callback", async () => {
			const outputValidator: OutputValidator = async () => { throw new Error("validator crashed") }
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "done" }), chunk({}, "stop")]),
			)
			expect(collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE, undefined, outputValidator))).rejects.toThrow("validator crashed")
		})

		it("skips the callback on tool-call turns, invokes it on content turns", async () => {
			let callbackCalls = 0
			const outputValidator: OutputValidator = async () => { callbackCalls++; return null }
			const responses = [
				buildSse([
					chunk({
						tool_calls: [{
							index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						}],
					}, "tool_calls"),
				]),
				buildSse([chunk({ content: "final" }), chunk({}, "stop")]),
			]
			const { fetch } = createFetchWithSignal(({ callIndex }) => responses[callIndex]!)

			await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], TOOLS, IDENTITY_PROFILE, undefined, outputValidator))

			expect(callbackCalls).toBe(1)
		})

		it("behaves identically to no-callback when callback is omitted", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "ok" }), chunk({}, "stop")]),
			)
			const { result } = await collectLoop(agentLoop({ fetch, sleep: instantSleep, random: fixedRandom }, "test-model", [{ role: "user", content: "hi" }], [], IDENTITY_PROFILE))
			expect(result.finishReason).toBe("stop")
			expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "ok" })
		})
	})
})

function createMockFetchResponse(sseText: string): Response {
	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(sseText))
			controller.close()
		},
	})
	return new Response(stream, { status: 200 })
}

// Delivers sseText first, then errors on the next read (chunks enqueued before controller.error in start() would be dropped).
function createMockFetchResponseThenError(sseText: string, error: unknown): Response {
	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(sseText))
		},
		pull(controller) {
			controller.error(error)
		},
	})
	return new Response(stream, { status: 200 })
}

function createMockFetchResponseErrorImmediately(error: unknown): Response {
	const stream = new ReadableStream({
		start(controller) {
			controller.error(error)
		},
	})
	return new Response(stream, { status: 200 })
}
