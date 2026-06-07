import { describe, it, expect } from "bun:test"
import { completions, type CompletionsRequest, type CompletionDelta, type CompletionResult } from "../source/completions.mts"
import type { Fetch } from "../source/sse.mts"
import { createMockFetch } from "./helpers.mts"

function createBodyCapturingFetch(): { fetch: Fetch; getBody: () => string | undefined } {
	let capturedBody: string | undefined
	const fetch: Fetch = async (body: string, _headers?: Record<string, string>) => {
		capturedBody = body
		const encoder = new TextEncoder()
		const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(roleOnly))
				controller.enqueue(encoder.encode("data: [DONE]\n\n"))
				controller.close()
			}
		})
		return new Response(stream, { status: 200 })
	}
	return { fetch, getBody: () => capturedBody }
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish_reason: string | null = null): object {
	return {
		id,
		object: "chat.completion.chunk",
		created: 1234,
		model,
		choices: [{ index: 0, delta, finish_reason }],
	}
}

function usageChunk(id: string, model: string, usage: object): object {
	return {
		id,
		object: "chat.completion.chunk",
		created: 1234,
		model,
		choices: [],
		usage,
	}
}

function buildSseFromChunks(chunks: object[]): string {
	return chunks.map((c, i) => {
		if (i !== 0) return `data: ${JSON.stringify(c)}\n\n`
		const obj = c as { choices: Array<{ delta: Record<string, unknown> }> }
		const firstDelta = obj.choices?.[0]?.delta
		if (!firstDelta || 'role' in firstDelta) return `data: ${JSON.stringify(c)}\n\n`
		return `data: ${JSON.stringify({ ...obj, choices: [{ ...obj.choices[0], delta: { role: "assistant", ...firstDelta } }] })}\n\n`
	}).join("") + "data: [DONE]\n\n"
}

async function collectStream(gen: AsyncGenerator<CompletionDelta, CompletionResult>): Promise<{ deltas: CompletionDelta[], result: CompletionResult }> {
	const deltas: CompletionDelta[] = []
	while (true) {
		const { value, done } = await gen.next()
		if (done) return { deltas, result: value }
		deltas.push(value)
	}
}

const BASE_REQUEST: CompletionsRequest = {
	model: "test-model",
	messages: [{ role: "user", content: "hello" }],
}

describe("completions", () => {
	describe("deltas", () => {
		it("yields content deltas", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { role: "assistant" }),
				chunk("1", "test-model", { content: "Hello" }),
				chunk("1", "test-model", { content: " world" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant" },
				{ content: "Hello" },
				{ content: " world" },
				{},
			])
		})

		it("yields reasoning from reasoning field", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning: "thinking..." }),
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant", reasoning: "thinking..." },
				{ content: "answer" },
				{},
			])
		})

		it("yields reasoning from reasoning_content field", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning_content: "thinking..." }),
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant", reasoning_content: "thinking..." },
				{ content: "answer" },
				{},
			])
		})

		it("yields tool call deltas in a single chunk", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"src/foo.ts"}' },
					}],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{
					role: "assistant",
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"src/foo.ts"}' } }],
				},
			])
		})

		it("yields fragmented tool call deltas across multiple chunks", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }],
				}),
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, function: { arguments: '{"pat' } }],
				}),
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, function: { arguments: 'h":"a.ts"}' } }],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] },
				{ tool_calls: [{ index: 0, function: { arguments: '{"pat' } }] },
				{ tool_calls: [{ index: 0, function: { arguments: 'h":"a.ts"}' } }] },
			])
		})

		it("yields multiple tool calls in one delta", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [
						{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
						{ index: 1, id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
					],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{
					role: "assistant",
					tool_calls: [
						{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
						{ index: 1, id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
					],
				},
			])
		})

		it("yields role-only deltas", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { role: "assistant" }),
				chunk("1", "test-model", { content: "response" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant" },
				{ content: "response" },
				{},
			])
		})

		it("yields empty content deltas", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "" }),
				chunk("1", "test-model", { content: "real" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant", content: "" },
				{ content: "real" },
				{},
			])
		})

		it("stops at [DONE] sentinel", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "done" }),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([{ role: "assistant", content: "done" }])
		})

		it("throws when SSE event fails guard validation", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			await expect(collectStream(completions({ fetch }, BASE_REQUEST, []))).rejects.toThrow("Unexpected SSE event structure")
		})

		it("accepts null usage in SSE event (GLM-5.1 via Together.ai)", async () => {
			const glChunk = {
				id: "omPxi4g-2byqsH-a04c8c1e3b39db23",
				object: "chat.completion.chunk",
				created: 1780299387,
				model: "zai-org/GLM-5.1",
				choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: "Let" }, finish_reason: null }],
				usage: null,
			}
			const sse = `data: ${JSON.stringify(glChunk)}\n\ndata: ${JSON.stringify({ ...glChunk, choices: [{ index: 0, delta: { content: " me explain" }, finish_reason: null }], usage: null })}\n\ndata: ${JSON.stringify({ ...glChunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null })}\n\ndata: [DONE]\n\n`
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.finishReason).toBe("stop")
			expect(result.usage).toBeUndefined()
			expect(result.message.content).toBe(" me explain")
			if ("reasoning" in result.message) expect(result.message.reasoning).toBe("Let")
		})

		it("accepts null optional string fields in SSE event", async () => {
			const sse = buildSseFromChunks([
				{ id: "1", object: "chat.completion.chunk", created: 1234, model: "test-model", choices: [{ index: 0, delta: { content: null, reasoning: null, reasoning_content: null } }] },
				chunk("1", "test-model", { content: "actual" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { deltas } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(deltas).toEqual([
				{ role: "assistant", content: null, reasoning: null, reasoning_content: null },
				{ content: "actual" },
				{},
			])
		})

		it("throws on HTTP error", async () => {
			const fetch: Fetch = async () => new Response("forbidden", { status: 403, statusText: "Forbidden" })
			await expect(collectStream(completions({ fetch }, BASE_REQUEST, []))).rejects.toThrow("HTTP 403 Forbidden")
		})

		it("throws on invalid JSON in SSE data", async () => {
			const fetch = createMockFetch("data: {bad json\n\n")
			await expect(collectStream(completions({ fetch }, BASE_REQUEST, []))).rejects.toThrow("Failed to parse SSE data as JSON")
		})

		})

	describe("result", () => {
		it("returns assistant message with content and reasoning_content", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning_content: "thinking" }),
				chunk("1", "test-model", { content: "Hello" }),
				chunk("1", "test-model", { content: " world" }),
				chunk("1", "test-model", {}, "stop"),
				usageChunk("1", "test-model", {
					prompt_tokens: 50,
					completion_tokens: 5,
					total_tokens: 55,
					prompt_tokens_details: { cached_tokens: 0 },
				}),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
				content: "Hello world",
				reasoning_content: "thinking",
			})
		})

		it("returns assistant message without reasoning_content when none streamed", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
				content: "answer",
			})
		})

		it("returns assistant message with tool_calls", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [
						{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } },
						{ index: 1, id: "call_2", type: "function", function: { name: "search", arguments: "" } },
					],
				}),
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, function: { arguments: '{"pat' } }],
				}),
				chunk("1", "test-model", {
					tool_calls: [
						{ index: 0, function: { arguments: 'h":"a.ts"}' } },
						{ index: 1, function: { arguments: '{"q":"test"}' } },
					],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
					{ id: "call_2", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
				],
			})
		})

		it("preserves reasoning as separate field from reasoning_content", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning: "hmm" }),
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
				content: "answer",
				reasoning: "hmm",
			})
		})

		it("round-trips unknown fields from delta", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi", custom_field: "value" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message.role).toBe("assistant")
			expect(result.message.content).toBe("hi")
			const obj: Record<string, unknown> = { ...result.message }
			expect(obj.custom_field).toBe("value")
		})

		it("round-trips reasoning without reasoning_content", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning: "thinking..." }),
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
				content: "answer",
				reasoning: "thinking...",
			})
			if ("reasoning_content" in result.message) throw new Error("reasoning_content should not be present")
		})

		it("round-trips reasoning_content without reasoning", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning_content: "thinking..." }),
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
				content: "answer",
				reasoning_content: "thinking...",
			})
			if ("reasoning" in result.message) throw new Error("reasoning should not be present")
		})

		it("throws when both reasoning and reasoning_content are present", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { reasoning: "deep thought", reasoning_content: "surface thought" }),
				chunk("1", "test-model", { content: "answer" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			await expect(collectStream(completions({ fetch }, BASE_REQUEST, []))).rejects.toThrow(
				"Assistant message has both reasoning and reasoning_content; these are mutually exclusive"
			)
		})

		it("merges fragmented tool call across multiple deltas", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: "" } }],
				}),
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pat' } }],
				}),
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, function: { arguments: 'h":"a.ts"}' } }],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			if (!("tool_calls" in result.message) || !result.message.tool_calls) throw new Error("expected tool_calls")
			expect(result.message.tool_calls[0]).toEqual({
				id: "call_1",
				type: "function",
				function: { name: "read_file", arguments: '{"path":"a.ts"}' },
			})
		})

		it("merges multiple tool calls at different indices", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "a", arguments: "" } }],
				}),
				chunk("1", "test-model", {
					tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "b", arguments: "" } }],
				}),
				chunk("1", "test-model", {}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			if (!("tool_calls" in result.message) || !result.message.tool_calls) throw new Error("expected tool_calls")
			expect(result.message.tool_calls).toHaveLength(2)
			expect(result.message.tool_calls[0]).toEqual({ id: "call_1", type: "function", function: { name: "a", arguments: "" } })
			expect(result.message.tool_calls[1]).toEqual({ id: "call_2", type: "function", function: { name: "b", arguments: "" } })
		})

		it("strips routing index from every array item in the accumulator (not just tool_calls)", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", {
					reasoning_details: [{ type: "reasoning.text", text: "thinking", format: "unknown", index: 0 }],
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "" } }],
				}, "tool_calls"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			if (!("tool_calls" in result.message) || !result.message.tool_calls) throw new Error("expected tool_calls")
			expect(result.message.tool_calls[0]).not.toHaveProperty("index")
			const obj: Record<string, unknown> = { ...result.message }
			const reasoningDetails = obj.reasoning_details as Array<Record<string, unknown>> | undefined
			expect(reasoningDetails).toBeDefined()
			expect(reasoningDetails![0]).not.toHaveProperty("index")
			expect(reasoningDetails![0]).toEqual({ type: "reasoning.text", text: "thinking", format: "unknown" })
		})

		it("throws when SSE event has invalid field types", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: 123 }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			await expect(collectStream(completions({ fetch }, BASE_REQUEST, []))).rejects.toThrow("Unexpected SSE event structure")
		})

		it("returns empty assistant message for stream with no content", async () => {
			const fetch = createMockFetch(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.message).toEqual({
				role: "assistant",
			})
		})

		it("returns finish_reason from last chunk with a non-null finish_reason", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.finishReason).toBe("stop")
		})

		it("returns undefined finish_reason when no non-null finish_reason received", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.finishReason).toBeUndefined()
		})

		it("returns last finish_reason when multiple are received", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
				chunk("1", "test-model", {}, "stop"),
				chunk("1", "test-model", {}, "length"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.finishReason).toBe("length")
		})

		it("returns usage from last usage chunk", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
				chunk("1", "test-model", {}, "stop"),
				usageChunk("1", "test-model", {
					prompt_tokens: 100,
					completion_tokens: 10,
					total_tokens: 110,
				}),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			const usage = result.usage!
			expect(usage.prompt_tokens).toBe(100)
			expect(usage.completion_tokens).toBe(10)
			expect(usage.total_tokens).toBe(110)
		})

		it("returns undefined usage when no usage chunk received", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
				chunk("1", "test-model", {}, "stop"),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.usage).toBeUndefined()
		})

		it("returns last usage when multiple usage chunks received", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
				usageChunk("1", "test-model", {
					prompt_tokens: 50,
					completion_tokens: 5,
					total_tokens: 55,
				}),
				chunk("1", "test-model", {}, "stop"),
				usageChunk("1", "test-model", {
					prompt_tokens: 100,
					completion_tokens: 10,
					total_tokens: 110,
				}),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			expect(result.usage).toEqual({
				prompt_tokens: 100,
				completion_tokens: 10,
				total_tokens: 110,
			})
		})

		it("preserves extra keys on usage object", async () => {
			const sse = buildSseFromChunks([
				chunk("1", "test-model", { content: "hi" }),
				chunk("1", "test-model", {}, "stop"),
				usageChunk("1", "test-model", {
					prompt_tokens: 100,
					completion_tokens: 10,
					total_tokens: 110,
				}),
			])
			const fetch = createMockFetch(sse)
			const { result } = await collectStream(completions({ fetch }, BASE_REQUEST, []))
			const usage = result.usage!
			expect(usage.prompt_tokens).toBe(100)
		})
	})

	describe("serialization", () => {
		it("builds request body with wire-format fields", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				model: "test-model",
				messages: [
					{ role: "system", content: "You are helpful." },
					{ role: "user", content: "hello" },
					{ role: "assistant", content: null, reasoning_content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "read_file", arguments: "{}" } }] },
					{ role: "tool", content: "file contents", tool_call_id: "call_0" },
				],
				max_tokens: 500,
				temperature: 0.7,
				top_p: 0.9,
				stop: ["\n"],
				n: 1,
				seed: 42,
				stream_options: { include_usage: true },
				tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }],
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.model).toBe("test-model")
			expect(parsed.stream).toBe(true)
			expect(parsed.max_tokens).toBe(500)
			expect(parsed.max_completion_tokens).toBeUndefined()
			expect(parsed.temperature).toBe(0.7)
			expect(parsed.top_p).toBe(0.9)
			expect(parsed.stop).toEqual(["\n"])
			expect(parsed.n).toBe(1)
			expect(parsed.seed).toBe(42)
			expect(parsed.stream_options).toEqual({ include_usage: true })
			expect(parsed.tools).toHaveLength(1)
			const [sys, user, assistant, tool] = parsed.messages
			expect(sys.role).toBe("system")
			expect(user.role).toBe("user")
			expect(assistant.role).toBe("assistant")
			expect(assistant.tool_calls).toHaveLength(1)
			expect(assistant.tool_calls[0].function.name).toBe("read_file")
			expect(assistant.reasoning_content).toBe(null)
			expect(tool.role).toBe("tool")
			expect(tool.tool_call_id).toBe("call_0")
		})

		it("omits undefined optional fields from request body", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			await collectStream(completions({ fetch }, BASE_REQUEST, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.max_tokens).toBeUndefined()
			expect(parsed.temperature).toBeUndefined()
			expect(parsed.tools).toBeUndefined()
			expect(parsed.stream_options).toEqual({ include_usage: true })
		})

		it("uses max_completion_tokens when provided", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = { ...BASE_REQUEST, max_completion_tokens: 2000 }
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.max_completion_tokens).toBe(2000)
			expect(parsed.max_tokens).toBeUndefined()
		})

		it("always sets stream to true in the body", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			await collectStream(completions({ fetch }, BASE_REQUEST, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.stream).toBe(true)
		})

		it("serializes tool messages with tool_call_id", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				model: "test-model",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: null, reasoning_content: null, tool_calls: [
						{ id: "call_0", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
						{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
					] },
					{ role: "tool", content: "file contents", tool_call_id: "call_0" },
					{ role: "tool", content: "search results", tool_call_id: "call_1" },
				],
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.messages).toHaveLength(4)
			expect(parsed.messages[0]).toEqual({ role: "user", content: "hello" })
			expect(parsed.messages[1]).toEqual({
				role: "assistant",
				content: null,
				reasoning_content: null,
				tool_calls: [
					{ id: "call_0", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
					{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
				],
			})
			expect(parsed.messages[2]).toEqual({ role: "tool", content: "file contents", tool_call_id: "call_0" })
			expect(parsed.messages[3]).toEqual({ role: "tool", content: "search results", tool_call_id: "call_1" })
		})

		it("includes reasoning_content in serialized assistant messages", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				model: "test-model",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "answer", reasoning_content: "I thought about it" },
				],
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.messages[1]).toEqual({
				role: "assistant",
				content: "answer",
				reasoning_content: "I thought about it",
			})
		})

		it("serializes reasoning_content as null when null", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				model: "test-model",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "answer", reasoning_content: null },
				],
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.messages[1]).toEqual({
				role: "assistant",
				content: "answer",
				reasoning_content: null,
			})
		})

		it("serializes extra top-level properties on the request as-is", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				...BASE_REQUEST,
				arbitrary_extension_field: "extension value",
				arbitrary_extension_object: { nested_key: 42 },
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.arbitrary_extension_field).toBe("extension value")
			expect(parsed.arbitrary_extension_object).toEqual({ nested_key: 42 })
		})

		it("serializes a null extra property as null in the body", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				...BASE_REQUEST,
				arbitrary_nullable_field: null,
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect(parsed.arbitrary_nullable_field).toBeNull()
		})

		it("omits undefined extra properties from the body", async () => {
			const { fetch, getBody } = createBodyCapturingFetch()
			const request: CompletionsRequest = {
				...BASE_REQUEST,
				arbitrary_undefined_field: undefined,
			}
			await collectStream(completions({ fetch }, request, []))
			const parsed = JSON.parse(getBody()!)
			expect("arbitrary_undefined_field" in parsed).toBe(false)
		})
	})
})
