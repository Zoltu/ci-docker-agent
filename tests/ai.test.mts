import { describe, it, expect } from "bun:test"
import { analyze, parseAiConfiguration } from "../source/ai.mts"
import { IDENTITY_PROFILE } from "../source/provider-profiles.mts"
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

function makeFetchWithAggregatorOutput(aggregatorOutputs: readonly string[]): { fetch: Fetch; capturedBodies: () => readonly string[] } {
	const capturedBodies: string[] = []
	const fetch: Fetch = async (_signal: AbortSignal, body: string, _headers?: Record<string, string>) => {
		capturedBodies.push(body)
		const callIndex = capturedBodies.length - 1
		const isAgentCall = callIndex === 0
		const aggregatorIndex = callIndex - 1
		const content = isAgentCall
			? JSON.stringify({ body: "Agent result", comments: [] })
			: aggregatorOutputs[Math.min(aggregatorIndex, aggregatorOutputs.length - 1)]!
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
	return { fetch, capturedBodies: () => capturedBodies }
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

		const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

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

		const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

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

		await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

		expect(prompts.length).toBe(2)
		expect(prompts[0]!.agentName).toBe("TestAgent")
		expect(prompts[1]!.agentName).toBe("Aggregator")
		expect(trace.length).toBeGreaterThan(0)
	})

	describe("aggregator output validation", () => {
		const validOutput = JSON.stringify({
			body: "Looks good",
			comments: [{ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" }],
		})

		it("returns result when aggregator output is valid with comments", async () => {
			const { fetch } = makeFetchWithAggregatorOutput([validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(result.comments).toHaveLength(1)
			expect(result.comments[0]).toEqual({ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" })
		})

		it("returns result when aggregator output has empty comments", async () => {
			const { fetch } = makeFetchWithAggregatorOutput([JSON.stringify({
				body: "No issues found",
				comments: [],
			})])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("No issues found")
			expect(result.comments).toEqual([])
		})

		it("feeds back the parse error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput(["not json", validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const secondRequest = JSON.parse(capturedBodies()[2]!)
			const lastUserMessage = secondRequest.messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Your previous output failed JSON parsing and validation:\nJSON Parse error: Unexpected identifier \"not\"")
		})

		it("feeds back the shape error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({ wrong: "shape" }), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			const secondRequest = JSON.parse(capturedBodies()[2]!)
			const lastUserMessage = secondRequest.messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Your previous output failed JSON parsing and validation:\nParsed output does not match expected shape:\n{\"wrong\":\"shape\"}")
		})

		it("feeds back the body-type error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({ body: 123, comments: [] }), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the comments-type error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({ body: "test", comments: "not array" }), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the missing-comments error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({ body: "test" }), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the empty-body error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({ body: "", comments: [] }), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the missing-body error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({ comments: [] }), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the zero-line-number error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 0, side: "RIGHT", body: "comment" }],
			}), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the negative-line-number error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: -1, side: "RIGHT", body: "comment" }],
			}), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the non-integer-line-number error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1.5, side: "RIGHT", body: "comment" }],
			}), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})

		it("feeds back the empty-comment-body error and accepts the corrected output", async () => {
			const { fetch, capturedBodies } = makeFetchWithAggregatorOutput([JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "" }],
			}), validOutput])
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }

			const result = await analyze({ fetch, spawnGit: noopSpawnGit, logger: createMockLogger(), debugWriter: noopDebugWriter }, makeBaseCommitContext(), SAMPLE_DIFF, agents, aggregator, "abc123", "test-model", IDENTITY_PROFILE)

			expect(result.body).toBe("Looks good")
			expect(capturedBodies().length).toBe(3)
			const lastUserMessage = JSON.parse(capturedBodies()[2]!).messages.at(-1)
			expect(lastUserMessage.role).toBe("user")
			expect(lastUserMessage.content).toContain("Parsed output does not match expected shape")
		})
	})
})
