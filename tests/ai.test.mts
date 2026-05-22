import { describe, it, expect } from "bun:test"
import { analyze, callAiApi, parseAiConfiguration, type AiFetch, type AiMessage } from "../source/ai.mts"
import { consumeAiStream, buildAiToolCalls, type ToolCallAccumulator } from "../source/ai-stream.mts"
import type { Agent } from "../source/agents.mts"
import type { DebugWriter } from "../source/debug.mts"
import type { ToolCallRequest, ToolCallResult, ToolDefinition, ToolExecutor } from "../source/tool-executor.mts"
import { createMockLogger, createMockStream, makeBaseCommitContext, makeNoopToolExecutor, wrapInSse } from "./helpers.mts"

const SAMPLE_DIFF = [
	"diff --git a/src/file.ts b/src/file.ts",
	"--- a/src/file.ts",
	"+++ b/src/file.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
].join("\n")

const noopDebugWriter: DebugWriter = { writePrompt: async () => {}, writeTrace: async () => {} }

function makeAiFetchWithAggregatorOutput(aggregatorOutput: string): AiFetch {
	let callCount = 0
	return async (_messages: AiMessage[], _tools: ToolDefinition[], _signal: AbortSignal) => {
		callCount++
		const content = callCount <= 1
			? JSON.stringify({ body: "Agent result", comments: [] })
			: aggregatorOutput
		return createMockStream([wrapInSse(content)])
	}
}

function makeAiFetchFromSseLines(lines: string[]): AiFetch {
	const stream = createMockStream([lines.join("\n") + "\n"])
	return async (_messages: AiMessage[], _tools: ToolDefinition[], _signal: AbortSignal) => stream
}

function makeAiFetchFromChunks(chunks: string[]): AiFetch {
	const stream = createMockStream(chunks)
	return async (_messages: AiMessage[], _tools: ToolDefinition[], _signal: AbortSignal) => stream
}

function makeSseLine(data: unknown): string {
	return `data: ${JSON.stringify(data)}`
}

function makeFinishSseLine(reason: string = "stop"): string {
	return makeSseLine({ choices: [{ delta: {}, finish_reason: reason }] })
}

describe("parseAiConfiguration", () => {
	it("returns configuration with API key", () => {
		const result = parseAiConfiguration({
			AI_API_URL: "https://api.openai.com/v1",
			AI_MODEL: "gpt-4",
			AI_API_KEY: "sk-test-key",
		})
		expect(result).toEqual({
			apiUrl: "https://api.openai.com/v1",
			model: "gpt-4",
			apiKey: "sk-test-key",
		})
	})

	it("returns configuration without API key", () => {
		const result = parseAiConfiguration({
			AI_API_URL: "http://localhost:11434/v1",
			AI_MODEL: "llama3",
		})
		expect(result).toEqual({
			apiUrl: "http://localhost:11434/v1",
			model: "llama3",
			apiKey: undefined,
		})
	})

	it("throws when AI_API_URL is missing", () => {
		expect(() => parseAiConfiguration({ AI_MODEL: "gpt-4" })).toThrow("AI_API_URL is required")
	})

	it("throws when AI_MODEL is missing", () => {
		expect(() => parseAiConfiguration({ AI_API_URL: "https://api.openai.com/v1" })).toThrow("AI_MODEL is required")
	})

	it("throws when both AI_API_URL and AI_MODEL are missing", () => {
		expect(() => parseAiConfiguration({})).toThrow()
	})

	it("uses empty string API key when AI_API_KEY is empty string", () => {
		const result = parseAiConfiguration({
			AI_API_URL: "https://api.openai.com/v1",
			AI_MODEL: "gpt-4",
			AI_API_KEY: "",
		})
		expect(result.apiKey).toBe("")
	})
})

describe("callAiApi", () => {
	it("accumulates content from valid SSE stream", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "Hello" } }] }),
			makeSseLine({ choices: [{ delta: { content: " world" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("Hello world")
	})

	it("handles SSE stream with blank lines", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "text" } }] }),
			"",
			makeSseLine({ choices: [{ delta: { content: " more" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("text more")
	})

	it("handles empty content deltas", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { role: "assistant" } }] }),
			makeSseLine({ choices: [{ delta: { content: "hello" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("hello")
	})

	it("handles content split across chunk boundaries", async () => {
		const aiFetch = makeAiFetchFromChunks([
			'data: {"choices":[{"delta":{"content":"Hel',
			'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("Hello world")
	})

	it("terminates on [DONE] without consuming remaining stream", async () => {
		const lines = [
			makeSseLine({ choices: [{ delta: { content: "done" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
			makeSseLine({ choices: [{ delta: { content: "after" } }] }),
		]
		const aiFetch = makeAiFetchFromSseLines(lines)
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("done")
	})

	it("throws when stream has no [DONE] marker and no finish_reason", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "end" } }] }),
		])
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("AI stream ended without a finish reason")
	})

	it("returns empty string for stream with no content but valid finish", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { role: "assistant" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("")
	})

	it("propagates error from aiFetch", async () => {
		const aiFetch: AiFetch = async () => {
			throw new Error("AI API request failed: 401 Unauthorized")
		}
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("AI API request failed: 401 Unauthorized")
	})

	it("calls onTrace for reasoning chunks", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning: "thinking..." } }] }),
			makeSseLine({ choices: [{ delta: { content: "answer" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("answer")
		expect(traceChunks).toEqual(["# Reasoning\n\n", "thinking...", "\n\n", "# Content\n\n", "answer", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("streams consecutive reasoning chunks immediately", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning: "Let" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: " me" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: " think." } }] }),
			makeSseLine({ choices: [{ delta: { content: "answer" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("answer")
		expect(traceChunks).toEqual(["# Reasoning\n\n", "Let", " me", " think.", "\n\n", "# Content\n\n", "answer", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("does not include reasoning in final result", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning: "step 1" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: " step 2" } }] }),
			makeSseLine({ choices: [{ delta: { content: "final" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("final")
	})

	it("does not include reasoning_content in final result", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning_content: "step 1" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning_content: " step 2" } }] }),
			makeSseLine({ choices: [{ delta: { content: "final" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("final")
	})

	it("calls onTrace for reasoning_content chunks", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning_content: "thinking..." } }] }),
			makeSseLine({ choices: [{ delta: { content: "answer" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("answer")
		expect(traceChunks).toEqual(["# Reasoning\n\n", "thinking...", "\n\n", "# Content\n\n", "answer", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("streams consecutive reasoning_content chunks immediately", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning_content: "Let" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning_content: " me" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning_content: " think." } }] }),
			makeSseLine({ choices: [{ delta: { content: "answer" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("answer")
		expect(traceChunks).toEqual(["# Reasoning\n\n", "Let", " me", " think.", "\n\n", "# Content\n\n", "answer", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("handles chunks with both content and reasoning", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "ans", reasoning: "think" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (t) => { traceChunks.push(t) })
		expect(result).toBe("ans")
		expect(traceChunks).toEqual(["# Reasoning\n\n", "think", "\n\n", "# Content\n\n", "ans", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("closes reasoning block when stream ends without content", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning: "only reasoning" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("")
		expect(traceChunks).toEqual(["# Reasoning\n\n", "only reasoning", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("calls onTrace for content chunks when onTrace is provided", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "Hello" } }] }),
			makeSseLine({ choices: [{ delta: { content: " world" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("Hello world")
		expect(traceChunks).toEqual(["# Content\n\n", "Hello", " world", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("alternates between content and reasoning blocks in trace", async () => {
		const traceChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "start" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: "think" } }] }),
			makeSseLine({ choices: [{ delta: { content: "end" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt", async (trace) => { traceChunks.push(trace) })
		expect(result).toBe("end")
		expect(traceChunks).toEqual(["# Content\n\n", "start", "\n\n", "# Reasoning\n\n", "think", "\n\n", "# Content\n\n", "end", "\n\n", "<!-- finish_reason: stop -->\n"])
	})

	it("returns only the last content block after reasoning interrupts content", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "progress update" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: "thinking..." } }] }),
			makeSseLine({ choices: [{ delta: { content: "final answer" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")
		expect(result).toBe("final answer")
	})

	it("executes tool calls and continues the loop", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/foo.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([
				'data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				if (toolCall.name === "read_file") return { toolCallId: toolCall.id, content: "file contents here" }
				return { toolCallId: toolCall.id, content: `Unknown tool: ${toolCall.name}` }
			},
		}

		const traceChunks: string[] = []
		const result = await callAiApi({ aiFetch, toolExecutor }, "test prompt", async (t) => { traceChunks.push(t) })
		expect(result).toBe("final answer")
		expect(callCount).toBe(2)
		expect(traceChunks.some(t => t.includes("# Tool Call: read_file"))).toBe(true)
		expect(traceChunks.some(t => t.includes("# Tool Result: read_file"))).toBe(true)
	})

	it("handles multiple tool calls in a single response", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"b.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const executedCalls: string[] = []
		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				executedCalls.push(toolCall.name)
				return { toolCallId: toolCall.id, content: "contents" }
			},
		}

		const result = await callAiApi({ aiFetch, toolExecutor }, "test prompt")
		expect(result).toBe("done")
		expect(executedCalls).toEqual(["read_file", "read_file"])
	})

	it("handles tool calls split across multiple deltas", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pat"}}]}}]}\n\n',
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"h\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				return { toolCallId: toolCall.id, content: `read ${toolCall.arguments}` }
			},
		}

		const result = await callAiApi({ aiFetch, toolExecutor }, "test prompt")
		expect(result).toBe("done")
		expect(callCount).toBe(2)
	})

	it("detects context window exceeded errors", async () => {
		const aiFetch: AiFetch = async () => {
			throw new Error("This model's maximum context length is 128000 tokens")
		}
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("Context window exceeded")
	})

	it("throws when stream ends without a finish reason", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "partial" } }] }),
			"data: [DONE]",
		])
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("AI stream ended without a finish reason")
	})

	it("passes messages and tools to aiFetch", async () => {
		const captured: { messages: AiMessage[]; tools: ToolDefinition[] } = { messages: [], tools: [] }
		const aiFetch: AiFetch = async (messages, tools, _signal) => {
			captured.messages = messages
			captured.tools = tools
			return createMockStream([wrapInSse("response")])
		}

		const toolExecutor = makeNoopToolExecutor()
		await callAiApi({ aiFetch, toolExecutor }, "test prompt")

		expect(captured.messages.length).toBe(1)
		expect(captured.messages[0]!.role).toBe("user")
		expect(captured.messages[0]!.content).toBe("test prompt")
		expect(captured.tools).toEqual(toolExecutor.definitions)
	})

	it("accumulates tool call arguments across streaming deltas", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pat"}}]}}]}\n\n',
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"h\\":\\"x.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([wrapInSse("done")])
		}

		const capturedArgs: { value: string } = { value: "" }
		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				capturedArgs.value = toolCall.arguments
				return { toolCallId: toolCall.id, content: "file contents" }
			},
		}

		await callAiApi({ aiFetch, toolExecutor }, "test prompt")
		expect(capturedArgs.value).toBe('{"path":"x.ts"}')
	})

	it("sends fullContent in assistant message when continuing after tool calls", async () => {
		const capturedMessages: AiMessage[][] = []
		let callCount = 0
		const aiFetch: AiFetch = async (messages, _tools, _signal) => {
			capturedMessages.push(messages.map(m => ({ ...m })))
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"content":"progress"}}]}\n\n',
					'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n',
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([
				'data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				return { toolCallId: toolCall.id, content: "file contents" }
			},
		}

		const result = await callAiApi({ aiFetch, toolExecutor }, "test prompt")
		expect(result).toBe("final answer")

		const secondCallMessages = capturedMessages[1]!
		const assistantMessage = secondCallMessages[1]!
		expect(assistantMessage.role).toBe("assistant")
		expect(assistantMessage.content).toBe("progress")
		expect(assistantMessage.tool_calls).toBeDefined()
		expect(assistantMessage.tool_calls!.length).toBe(1)
	})

	it("serializes assistant message content as null (not omitted) when model produces only tool calls", async () => {
		const capturedMessages: AiMessage[][] = []
		let callCount = 0
		const aiFetch: AiFetch = async (messages, _tools, _signal) => {
			capturedMessages.push(messages.map(m => ({ ...m })))
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([wrapInSse("done")])
		}

		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				return { toolCallId: toolCall.id, content: "file contents" }
			},
		}

		await callAiApi({ aiFetch, toolExecutor }, "test prompt")

		const secondCallMessages = capturedMessages[1]!
		const assistantMessage = secondCallMessages[1]!
		expect(assistantMessage.role).toBe("assistant")
		expect(assistantMessage.content).toBe(null)
	})

	it("throws when finishReason is 'length'", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "partial" } }] }),
			makeSseLine({ choices: [{ delta: {}, finish_reason: "length" }] }),
			"data: [DONE]",
		])
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("AI response truncated")
	})

	it("propagates error when toolExecutor.execute throws", async () => {
		const aiFetch: AiFetch = async () => {
			return createMockStream([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(): Promise<ToolCallResult> {
				throw new Error("Tool execution failed")
			},
		}

		expect(callAiApi({ aiFetch, toolExecutor }, "test prompt")).rejects.toThrow("Tool execution failed")
	})

	it("handles multiple rounds of tool calls", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			if (callCount === 2) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"search_files","arguments":"{\\"pattern\\":\\"TODO\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([
				'data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const executedCalls: string[] = []
		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				executedCalls.push(toolCall.name)
				return { toolCallId: toolCall.id, content: "result" }
			},
		}

		const result = await callAiApi({ aiFetch, toolExecutor }, "test prompt")
		expect(result).toBe("final answer")
		expect(callCount).toBe(3)
		expect(executedCalls).toEqual(["read_file", "search_files"])
	})

	it("executes tool calls in index order", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"search_files","arguments":"{\\"pattern\\":\\"TODO\\"}"}},{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			])
		}

		const executedCalls: string[] = []
		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				executedCalls.push(toolCall.name)
				return { toolCallId: toolCall.id, content: "result" }
			},
		}

		await callAiApi({ aiFetch, toolExecutor }, "test prompt")
		expect(executedCalls).toEqual(["read_file", "search_files"])
	})

	it("sends tool result messages with matching tool_call_id", async () => {
		let callCount = 0
		const capturedMessages: AiMessage[][] = []
		const aiFetch: AiFetch = async (messages, _tools, _signal) => {
			capturedMessages.push(messages.map(m => ({ ...m })))
			callCount++
			if (callCount === 1) {
				return createMockStream([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
					"data: [DONE]\n\n",
				])
			}
			return createMockStream([wrapInSse("done")])
		}

		const toolExecutor: ToolExecutor = {
			definitions: [],
			async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
				return { toolCallId: toolCall.id, content: "file contents" }
			},
		}

		await callAiApi({ aiFetch, toolExecutor }, "test prompt")

		const secondCallMessages = capturedMessages[1]!
		const toolMessage = secondCallMessages.find(m => m.role === "tool")!
		expect(toolMessage.tool_call_id).toBe("call_1")
		expect(toolMessage.content).toBe("file contents")
	})

	it("detects context window exceeded errors with 'context window' message", async () => {
		const aiFetch: AiFetch = async () => {
			throw new Error("The context window was exceeded")
		}
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("Context window exceeded")
	})

	it("detects context window exceeded errors with 'token limit' message", async () => {
		const aiFetch: AiFetch = async () => {
			throw new Error("Token limit reached")
		}
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("Context window exceeded")
	})

	it("throws when SSE data payload is not valid JSON", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			"data: not-json{}",
			"data: [DONE]",
		])
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("Failed to parse SSE data payload as JSON")
	})

	it("throws when stream is empty", async () => {
		const aiFetch: AiFetch = async () => createMockStream([])
		expect(callAiApi({ aiFetch, toolExecutor: makeNoopToolExecutor() }, "test prompt")).rejects.toThrow("AI stream ended without a finish reason")
	})
})

describe("analyze", () => {
	it("calls aiFetch for each agent and aggregator", async () => {
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			const content = JSON.stringify({ body: "Review complete", comments: [] })
			return createMockStream([wrapInSse(content)])
		}

		const agents: Agent[] = [
			{ name: "SecurityAgent", prompt: "Check security" },
			{ name: "StyleAgent", prompt: "Check style" },
		]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		const result = await analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

		expect(result.body).toBe("Review complete")
		expect(result.comments).toEqual([])
	})

	it("passes agent outputs to aggregator prompt", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => {
			callCount++
			const content = JSON.stringify({ body: `Result ${callCount}`, comments: [] })
			return createMockStream([wrapInSse(content)])
		}

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		const result = await analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

		expect(result.body).toBe("Result 2")
	})

	it("writes prompts and streaming trace via debugWriter", async () => {
		const prompts: Array<{ agentName: string; prompt: string }> = []
		const trace: Array<{ agentName: string; chunk: string }> = []
		const debugWriter: DebugWriter = {
			writePrompt: async (agentName, prompt) => { prompts.push({ agentName, prompt }) },
			writeTrace: async (agentName, chunk) => { trace.push({ agentName, chunk }) },
		}
		const output = JSON.stringify({ body: "result", comments: [] })
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => createMockStream([wrapInSse(output)])

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		await analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

		expect(prompts.length).toBe(2)
		expect(prompts[0]!.agentName).toBe("TestAgent")
		expect(prompts[1]!.agentName).toBe("Aggregator")
		expect(trace.length).toBeGreaterThan(0)
	})

	describe("aggregator output validation", () => {
		it("returns result when aggregator output is valid with comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "Looks good",
				comments: [{ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

			expect(result.body).toBe("Looks good")
			expect(result.comments).toHaveLength(1)
			expect(result.comments[0]).toEqual({ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" })
		})

		it("returns result when aggregator output has empty comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "No issues found",
				comments: [],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

			expect(result.body).toBe("No issues found")
			expect(result.comments).toEqual([])
		})

		it("throws Error with aggregator output when output is not valid JSON", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput("not json")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow(/Failed to parse aggregator output as JSON[\s\S]*not json/)
		})

		it("throws Error with aggregator output when output is empty string", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput("")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow(/Failed to parse aggregator output as JSON/)
		})

		it("throws when aggregator output does not match expected shape", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ wrong: "shape" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is not a string", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: 123, comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is not an array", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: "test", comments: "not array" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is missing", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: "test" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is empty string", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: "", comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is missing", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects line number zero in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 0, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects negative line number in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: -1, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects non-integer line number in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1.5, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects empty comment body in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, toolExecutor: makeNoopToolExecutor(), logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})
	})
})

describe("consumeAiStream", () => {
	it("returns fullContent with all content blocks and content with last block only", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "progress update" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: "thinking..." } }] }),
			makeSseLine({ choices: [{ delta: { content: "final answer" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const stream = await aiFetch([], [], new AbortController().signal)
		const result = await consumeAiStream(stream)
		expect(result.content).toBe("final answer")
		expect(result.fullContent).toBe("progress updatefinal answer")
	})

	it("returns identical content and fullContent when there is no reasoning", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "Hello" } }] }),
			makeSseLine({ choices: [{ delta: { content: " world" } }] }),
			makeFinishSseLine(),
			"data: [DONE]",
		])
		const stream = await aiFetch([], [], new AbortController().signal)
		const result = await consumeAiStream(stream)
		expect(result.content).toBe("Hello world")
		expect(result.fullContent).toBe("Hello world")
	})
})

describe("buildAiToolCalls", () => {
	it("returns tool calls in index order regardless of insertion order", () => {
		const accumulator: ToolCallAccumulator = new Map()
		accumulator.set(2, { id: "call_2", name: "search_files", arguments: '{"pattern":"todo"}' })
		accumulator.set(0, { id: "call_0", name: "read_file", arguments: '{"path":"a.ts"}' })
		accumulator.set(1, { id: "call_1", name: "read_file", arguments: '{"path":"b.ts"}' })

		const calls = buildAiToolCalls(accumulator)

		expect(calls.map(c => c.id)).toEqual(["call_0", "call_1", "call_2"])
		expect(calls[0]!.function.name).toBe("read_file")
		expect(calls[0]!.function.arguments).toBe('{"path":"a.ts"}')
		expect(calls[2]!.function.name).toBe("search_files")
	})
})
