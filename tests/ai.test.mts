import { describe, it, expect } from "bun:test"
import { analyze, callAiApi, extractDelta, parseAiConfiguration, parseSseLine, readStreamChunks, type AiFetch } from "../source/ai.mts"
import type { Agent } from "../source/agents.mts"
import type { DebugWriter } from "../source/debug.mts"
import { createMockLogger, createMockStream, makeBaseCommitContext, wrapInSse } from "./helpers.mts"

const SAMPLE_DIFF = [
	"diff --git a/src/file.ts b/src/file.ts",
	"--- a/src/file.ts",
	"+++ b/src/file.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
].join("\n")

const noopDebugWriter: DebugWriter = { writePrompt: () => {}, writeContent: () => {}, writeReasoning: () => {} }

function makeAiFetchWithAggregatorOutput(aggregatorOutput: string): AiFetch {
	let callCount = 0
	return async (_prompt: string, _signal: AbortSignal) => {
		callCount++
		const content = callCount <= 1
			? JSON.stringify({ body: "Agent result", comments: [] })
			: aggregatorOutput
		return createMockStream([wrapInSse(content)])
	}
}

function makeAiFetchFromSseLines(lines: string[]): AiFetch {
	const stream = createMockStream([lines.join("\n") + "\n"])
	return async (_prompt: string, _signal: AbortSignal) => stream
}

function makeAiFetchFromChunks(chunks: string[]): AiFetch {
	const stream = createMockStream(chunks)
	return async (_prompt: string, _signal: AbortSignal) => stream
}

function makeSseLine(data: unknown): string {
	return `data: ${JSON.stringify(data)}`
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

describe("parseSseLine", () => {
	it("parses data line with content", () => {
		const result = parseSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}')
		expect(result).toEqual({ type: "content", payload: '{"choices":[{"delta":{"content":"hello"}}]}' })
	})

	it("returns done for data: [DONE]", () => {
		const result = parseSseLine("data: [DONE]")
		expect(result).toEqual({ type: "done" })
	})

	it("returns ignore for blank line", () => {
		expect(parseSseLine("")).toEqual({ type: "ignore" })
	})

	it("returns ignore for whitespace-only line", () => {
		expect(parseSseLine("   ")).toEqual({ type: "ignore" })
	})

	it("returns ignore for non-data line", () => {
		expect(parseSseLine("event: message")).toEqual({ type: "ignore" })
	})

	it("returns ignore for comment lines", () => {
		expect(parseSseLine(": this is a comment")).toEqual({ type: "ignore" })
	})
})

describe("extractDelta", () => {
	it("extracts content from valid chunk", () => {
		const data = { choices: [{ delta: { content: "hello" } }] }
		expect(extractDelta(data)).toEqual({ content: "hello" })
	})

	it("returns empty object when content is missing", () => {
		const data = { choices: [{ delta: {} }] }
		expect(extractDelta(data)).toEqual({})
	})

	it("returns empty object when choices is empty", () => {
		const data = { choices: [] }
		expect(extractDelta(data)).toEqual({})
	})

	it("returns empty object for non-object input", () => {
		expect(extractDelta(null)).toEqual({})
		expect(extractDelta("string")).toEqual({})
		expect(extractDelta(42)).toEqual({})
	})

	it("returns empty object when choices is missing", () => {
		expect(extractDelta({})).toEqual({})
	})

	it("returns empty object when first choice is null", () => {
		expect(extractDelta({ choices: [null] })).toEqual({})
	})

	it("returns empty object when delta is missing", () => {
		expect(extractDelta({ choices: [{}] })).toEqual({})
	})

	it("returns empty object when content is not a string", () => {
		expect(extractDelta({ choices: [{ delta: { content: 123 } }] })).toEqual({})
	})

	it("returns empty object when content is empty string", () => {
		expect(extractDelta({ choices: [{ delta: { content: "" } }] })).toEqual({})
	})

	it("extracts reasoning from delta.reasoning", () => {
		const data = { choices: [{ delta: { reasoning: "thinking..." } }] }
		expect(extractDelta(data)).toEqual({ reasoning: "thinking..." })
	})

	it("extracts reasoning from delta.reasoning_details", () => {
		const data = { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "step 1", format: "unknown", index: 0 }] } }] }
		expect(extractDelta(data)).toEqual({ reasoning: "step 1" })
	})

	it("concatenates multiple reasoning_details", () => {
		const data = { choices: [{ delta: { reasoning_details: [{ text: "step 1" }, { text: " step 2" }] } }] }
		expect(extractDelta(data)).toEqual({ reasoning: "step 1 step 2" })
	})

	it("prefers delta.reasoning over reasoning_details", () => {
		const data = { choices: [{ delta: { reasoning: "from field", reasoning_details: [{ text: "from details" }] } }] }
		expect(extractDelta(data)).toEqual({ reasoning: "from field" })
	})

	it("returns empty object when reasoning is empty string", () => {
		expect(extractDelta({ choices: [{ delta: { reasoning: "" } }] })).toEqual({})
	})

	it("extracts both content and reasoning when both present", () => {
		const data = { choices: [{ delta: { content: "answer", reasoning: "thinking" } }] }
		expect(extractDelta(data)).toEqual({ content: "answer", reasoning: "thinking" })
	})

	it("ignores reasoning_details entries without text field", () => {
		const data = { choices: [{ delta: { reasoning_details: [{ type: "other" }] } }] }
		expect(extractDelta(data)).toEqual({})
	})

	it("filters reasoning_details with non-string text", () => {
		const data = { choices: [{ delta: { reasoning_details: [{ text: 123 }] } }] }
		expect(extractDelta(data)).toEqual({})
	})
})

describe("readStreamChunks", () => {
	it("yields decoded strings from a stream", async () => {
		const stream = createMockStream(["hello", " ", "world"])
		const chunks: string[] = []
		for await (const chunk of readStreamChunks(stream)) {
			chunks.push(chunk)
		}
		expect(chunks).toEqual(["hello", " ", "world"])
	})

	it("handles empty stream", async () => {
		const stream = createMockStream([])
		const chunks: string[] = []
		for await (const chunk of readStreamChunks(stream)) {
			chunks.push(chunk)
		}
		expect(chunks).toEqual([])
	})

	it("handles multi-byte characters across chunks", async () => {
		const stream = createMockStream(["Hello ", "World"])
		const chunks: string[] = []
		for await (const chunk of readStreamChunks(stream)) {
			chunks.push(chunk)
		}
		expect(chunks).toEqual(["Hello ", "World"])
	})
})

describe("callAiApi", () => {
	it("accumulates content from valid SSE stream", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "Hello" } }] }),
			makeSseLine({ choices: [{ delta: { content: " world" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("Hello world")
	})

	it("handles SSE stream with blank lines", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "text" } }] }),
			"",
			makeSseLine({ choices: [{ delta: { content: " more" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("text more")
	})

	it("handles empty content deltas", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { role: "assistant" } }] }),
			makeSseLine({ choices: [{ delta: { content: "hello" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("hello")
	})

	it("handles content split across chunk boundaries", async () => {
		const aiFetch = makeAiFetchFromChunks([
			'data: {"choices":[{"delta":{"content":"Hel',
			'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("Hello world")
	})

	it("terminates on [DONE] without consuming remaining stream", async () => {
		const lines = [
			makeSseLine({ choices: [{ delta: { content: "done" } }] }),
			"data: [DONE]",
			makeSseLine({ choices: [{ delta: { content: "after" } }] }),
		]
		const aiFetch = makeAiFetchFromSseLines(lines)
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("done")
	})

	it("handles stream with no [DONE] marker", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "end" } }] }),
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("end")
	})

	it("returns empty string for stream with no content", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { role: "assistant" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("")
	})

	it("propagates error from aiFetch", async () => {
		const aiFetch: AiFetch = async () => {
			throw new Error("AI API request failed: 401 Unauthorized")
		}
		expect(callAiApi({ aiFetch }, "test prompt")).rejects.toThrow("AI API request failed: 401 Unauthorized")
	})

	it("calls onContent for each content chunk", async () => {
		const contentChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "Hello" } }] }),
			makeSseLine({ choices: [{ delta: { content: " world" } }] }),
			"data: [DONE]",
		])
		await callAiApi({ aiFetch }, "test prompt", (content) => { contentChunks.push(content) })
		expect(contentChunks).toEqual(["Hello", " world"])
	})

	it("calls onReasoning for reasoning chunks", async () => {
		const contentChunks: string[] = []
		const reasoningChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning: "thinking..." } }] }),
			makeSseLine({ choices: [{ delta: { content: "answer" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt", (c) => { contentChunks.push(c) }, (r) => { reasoningChunks.push(r) })
		expect(result).toBe("answer")
		expect(contentChunks).toEqual(["answer"])
		expect(reasoningChunks).toEqual(["thinking..."])
	})

	it("does not include reasoning in final result", async () => {
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { reasoning: "step 1" } }] }),
			makeSseLine({ choices: [{ delta: { reasoning: " step 2" } }] }),
			makeSseLine({ choices: [{ delta: { content: "final" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt")
		expect(result).toBe("final")
	})

	it("handles chunks with both content and reasoning", async () => {
		const contentChunks: string[] = []
		const reasoningChunks: string[] = []
		const aiFetch = makeAiFetchFromSseLines([
			makeSseLine({ choices: [{ delta: { content: "ans", reasoning: "think" } }] }),
			"data: [DONE]",
		])
		const result = await callAiApi({ aiFetch }, "test prompt", (c) => { contentChunks.push(c) }, (r) => { reasoningChunks.push(r) })
		expect(result).toBe("ans")
		expect(contentChunks).toEqual(["ans"])
		expect(reasoningChunks).toEqual(["think"])
	})
})

describe("analyze", () => {
	it("calls aiFetch for each agent and aggregator", async () => {
		const calls: string[] = []
		const aiFetch: AiFetch = async (prompt, _signal) => {
			calls.push(prompt)
			const content = JSON.stringify({ body: "Review complete", comments: [] })
			return createMockStream([wrapInSse(content)])
		}

		const agents: Agent[] = [
			{ name: "SecurityAgent", prompt: "Check security" },
			{ name: "StyleAgent", prompt: "Check style" },
		]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		const result = await analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

		expect(calls.length).toBe(3)
		expect(result.body).toBe("Review complete")
		expect(result.comments).toEqual([])
	})

	it("passes agent outputs to aggregator prompt", async () => {
		let callCount = 0
		const aiFetch: AiFetch = async (_prompt, _signal) => {
			callCount++
			const content = JSON.stringify({ body: `Result ${callCount}`, comments: [] })
			return createMockStream([wrapInSse(content)])
		}

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		const result = await analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

		expect(result.body).toBe("Result 2")
	})

	it("writes prompts and streaming content via debugWriter", async () => {
		const prompts: Array<{ agentName: string; prompt: string }> = []
		const content: Array<{ agentName: string; chunk: string }> = []
		const reasoning: Array<{ agentName: string; chunk: string }> = []
		const debugWriter: DebugWriter = {
			writePrompt: (agentName, prompt) => { prompts.push({ agentName, prompt }) },
			writeContent: (agentName, chunk) => { content.push({ agentName, chunk }) },
			writeReasoning: (agentName, chunk) => { reasoning.push({ agentName, chunk }) },
		}
		const output = JSON.stringify({ body: "result", comments: [] })
		const aiFetch: AiFetch = async (_prompt, _signal) => createMockStream([wrapInSse(output)])

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		await analyze({ aiFetch, logger: createMockLogger(), debugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

		expect(prompts.length).toBe(2)
		expect(prompts[0]!.agentName).toBe("TestAgent")
		expect(prompts[1]!.agentName).toBe("Aggregator")
		expect(content.length).toBe(2)
		expect(content[0]!.agentName).toBe("TestAgent")
		expect(content[0]!.chunk).toBe(output)
		expect(content[1]!.agentName).toBe("Aggregator")
	})

	describe("aggregator output validation", () => {
		it("returns result when aggregator output is valid with comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "Looks good",
				comments: [{ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

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

			const result = await analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)

			expect(result.body).toBe("No issues found")
			expect(result.comments).toEqual([])
		})

		it("throws Error with aggregator output when output is not valid JSON", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput("not json")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow(/Failed to parse aggregator output as JSON[\s\S]*not json/)
		})

		it("throws Error with aggregator output when output is empty string", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput("")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow(/Failed to parse aggregator output as JSON/)
		})

		it("throws when aggregator output does not match expected shape", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ wrong: "shape" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is not a string", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: 123, comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is not an array", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: "test", comments: "not array" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is missing", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: "test" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is empty string", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ body: "", comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is missing", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({ comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects line number zero in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 0, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects negative line number in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: -1, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects non-integer line number in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1.5, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects empty comment body in aggregator comments", async () => {
			const aiFetch = makeAiFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ aiFetch, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})
	})
})
