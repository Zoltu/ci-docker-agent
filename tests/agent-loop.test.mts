import { describe, it, expect } from "bun:test"
import { agentLoop, type AgentLoopEvent, type AgentLoopResult, type Fetch, type Tool } from "../source/agent-loop.mts"
import type { CompletionsMessage } from "../source/completions.mts"

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
	return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
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
			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
			expect(result.message).toEqual({
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
			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
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
			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [
					{ role: "system", content: "You are helpful" },
					{ role: "user", content: "hi" },
				],
				tools: [],
			}))
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

			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "review" }],
				tools: TOOLS,
			}))

			expect(callCount()).toBe(2)
			expect(result.message).toEqual({
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

			await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))
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

			const { events, result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "review" }],
				tools: TOOLS,
			}))

			const toolCallEvents = events.filter(e => e.type === "tool_call")
			const toolResultEvents = events.filter(e => e.type === "tool_result")
			expect(toolCallEvents).toHaveLength(2)
			expect(toolResultEvents).toHaveLength(2)

			expect(result.message).toEqual({
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

			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "review" }],
				tools: TOOLS,
			}))

			expect(callCount()).toBe(3)
			expect(result.message).toEqual({
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

			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))

			expect(result.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
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
			const { events } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
			const deltaEvents = events.filter(e => e.type === "delta")
			expect(deltaEvents).toHaveLength(2)
			if (deltaEvents[0]!.type === "delta") {
				expect(deltaEvents[0]!.delta.reasoning).toBe("thinking")
			}
			if (deltaEvents[1]!.type === "delta") {
				expect(deltaEvents[1]!.delta.content).toBe("answer")
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
			const { events } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
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

			const { events } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))

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

			const { events } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))

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

			const { events } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))

			const eventTypes = events.map(e => e.type)
			expect(eventTypes).toEqual([
				"delta",
				"delta",
				"completion",
				"tool_call",
				"tool_result",
				"delta",
				"completion",
			])
		})
	})

	describe("finish reason validation", () => {
		it("throws when finishReason is undefined", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "partial" }),
				]),
			)
			expect(collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))).rejects.toThrow("AI stream ended without a finish reason")
		})

		it("yields completion event before throwing on undefined finishReason", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "partial" }),
				]),
			)
			const events: AgentLoopEvent[] = []
			const gen = agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			})
			try {
				while (true) {
					const { value, done } = await gen.next()
					if (done) break
					events.push(value)
				}
			} catch {
				// expected
			}
			const completionEvents = events.filter(e => e.type === "completion")
			expect(completionEvents).toHaveLength(1)
		})

		it("throws when finishReason is length", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([
					chunk({ content: "truncated" }),
					chunk({}, "length"),
				]),
			)
			expect(collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))).rejects.toThrow("AI response truncated")
		})
	})

	describe("idle timeout", () => {
		it("throws when no deltas arrive within idle timeout", async () => {
			const fetch = createHangingFetchWithSignal()
			expect(collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				idleTimeoutMs: 50,
			}))).rejects.toThrow("Agent loop timed out due to inactivity")
		})

		it("includes timeout duration in error message", async () => {
			const fetch = createHangingFetchWithSignal()
			expect(collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				idleTimeoutMs: 123,
			}))).rejects.toThrow("123ms")
		})

		it("resets idle timer on each delta", async () => {
			const chunks = [
				`data: ${JSON.stringify(chunk({ content: "chunk1" }))}\n\n`,
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
			const { result } = await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				idleTimeoutMs: 50,
			}))
			expect(result.finishReason).toBe("stop")
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
			expect(collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				signal: controller.signal,
			}))).rejects.toThrow()
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
			expect(collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				signal: controller.signal,
			}))).rejects.toThrow()
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

			const { events, result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))

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

			const { events, result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [failingTool],
			}))

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

			const { events } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [stringThrowTool],
			}))

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
			expect(collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [tool],
			}))).rejects.toThrow('Tool "bad_tool" parameters must be a JSON Schema object with type "object"')
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
			expect(collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [tool],
			}))).rejects.toThrow('Tool "bad_tool" parameters must be a JSON Schema object with type "object"')
		})
	})

	describe("request construction", () => {
		it("passes model to completions request", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "my-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.model).toBe("my-model")
		})

		it("passes max_tokens when provided", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				maxTokens: 500,
			}))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.max_tokens).toBe(500)
		})

		it("omits max_tokens when not provided", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.max_tokens).toBeUndefined()
		})

		it("converts tools to wire format", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [TOOLS[0]!],
			}))
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
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
			const parsed = JSON.parse(capturedBody!)
			expect(parsed.tools).toBeUndefined()
		})

		it("omits description from wire format when not provided", async () => {
			let capturedBody: string | undefined
			const fetchWithSignal: Fetch = async (_signal, body, _headers) => {
				capturedBody = body
				return createMockFetchResponse(buildSse([chunk({ content: "ok" }), chunk({}, "stop")]))
			}
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [{ name: "bare_tool", execute: async () => "" }],
			}))
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

			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: TOOLS,
			}))

			const secondRequest = JSON.parse(capturedBodies[1]!)
			expect(secondRequest.messages).toEqual([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
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
			await collectLoop(agentLoop({ fetch: fetchWithSignal }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
				signal: controller.signal,
			}))
			expect(capturedSignal).toBeDefined()
			expect(capturedSignal!.aborted).toBe(false)
		})
	})

	describe("default idle timeout", () => {
		it("defaults to 300000ms", async () => {
			const { fetch } = createFetchWithSignal(() =>
				buildSse([chunk({ content: "ok" }), chunk({}, "stop")]),
			)
			const { result } = await collectLoop(agentLoop({ fetch }, {
				model: "test-model",
				messages: [{ role: "user", content: "hi" }],
				tools: [],
			}))
			expect(result.finishReason).toBe("stop")
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
