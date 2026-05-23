import { describe, it, expect } from "bun:test"
import { analyze, parseAiConfiguration } from "../source/ai.mts"
import type { Agent } from "../source/agents.mts"
import type { DebugWriter } from "../source/debug.mts"
import type { Fetch } from "../source/agent-loop.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import { createMockLogger, createMockAgentFetch, makeBaseCommitContext, buildContentSse } from "./helpers.mts"

const SAMPLE_DIFF = [
	"diff --git a/src/file.ts b/src/file.ts",
	"--- a/src/file.ts",
	"+++ b/src/file.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
].join("\n")

const noopDebugWriter: DebugWriter = { writePrompt: async () => {}, writeTrace: async () => {} }

const noopSpawnGit: SpawnGit = async () => ({ stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult)

function makeFetchWithAggregatorOutput(aggregatorOutput: string): Fetch {
	let callCount = 0
	return async (_signal: AbortSignal, _body: string, _headers?: Record<string, string>) => {
		callCount++
		const content = callCount <= 1
			? JSON.stringify({ body: "Agent result", comments: [] })
			: aggregatorOutput
		const encoder = new TextEncoder()
		const sseText = buildContentSse(content)
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText))
				controller.close()
			}
		})
		return new Response(stream, { status: 200 })
	}
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

describe("analyze", () => {
	it("calls fetch for each agent and aggregator", async () => {
		const fetch = createMockAgentFetch(buildContentSse(JSON.stringify({ body: "Review complete", comments: [] })))

		const agents: Agent[] = [
			{ name: "SecurityAgent", prompt: "Check security" },
			{ name: "StyleAgent", prompt: "Check style" },
		]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")

		expect(result.body).toBe("Review complete")
		expect(result.comments).toEqual([])
	})

	it("passes agent outputs to aggregator prompt", async () => {
		let callCount = 0
		const fetch: Fetch = async (_signal, _body, _headers) => {
			callCount++
			const content = JSON.stringify({ body: `Result ${callCount}`, comments: [] })
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(buildContentSse(content)))
					controller.close()
				}
			})
			return new Response(stream, { status: 200 })
		}

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")

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
		const fetch = createMockAgentFetch(buildContentSse(output))

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

		await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")

		expect(prompts.length).toBe(2)
		expect(prompts[0]!.agentName).toBe("TestAgent")
		expect(prompts[1]!.agentName).toBe("Aggregator")
		expect(trace.length).toBeGreaterThan(0)
	})

	describe("aggregator output validation", () => {
		it("returns result when aggregator output is valid with comments", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({
				body: "Looks good",
				comments: [{ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")

			expect(result.body).toBe("Looks good")
			expect(result.comments).toHaveLength(1)
			expect(result.comments[0]).toEqual({ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" })
		})

		it("returns result when aggregator output has empty comments", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({
				body: "No issues found",
				comments: [],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")

			expect(result.body).toBe("No issues found")
			expect(result.comments).toEqual([])
		})

		it("throws Error with aggregator output when output is not valid JSON", async () => {
			const fetch = makeFetchWithAggregatorOutput("not json")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow(/Failed to parse aggregator output as JSON[\s\S]*not json/)
		})

		it("throws when aggregator output does not match expected shape", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({ wrong: "shape" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is not a string", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({ body: 123, comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is not an array", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({ body: "test", comments: "not array" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is missing", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({ body: "test" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is empty string", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({ body: "", comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is missing", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({ comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects line number zero in aggregator comments", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 0, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects negative line number in aggregator comments", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: -1, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects non-integer line number in aggregator comments", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1.5, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects empty comment body in aggregator comments", async () => {
			const fetch = makeFetchWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			expect(analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model")).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})
	})
})
