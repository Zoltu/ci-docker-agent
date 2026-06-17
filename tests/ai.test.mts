import { describe, it, expect } from "bun:test"
import { analyze, createFetch, parseAiConfiguration, type Sleep, type Random, type Now } from "../source/ai.mts"
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

describe("createFetch", () => {
	const BASE_TIME = 1_700_000_000_000

	function response(status: number, headers: Record<string, string> = {}): Response {
		return new Response(null, { status, headers })
	}

	function createFakeHttpFetch(responses: readonly Response[]): { httpFetch: Fetch; callCount: () => number } {
		let i = 0
		return {
			httpFetch: async () => responses[Math.min(i++, responses.length - 1)]!,
			callCount: () => i,
		}
	}

	function createFakeSleep(): { sleep: Sleep; delays: number[] } {
		const delays: number[] = []
		return {
			sleep: async (ms) => { delays.push(ms) },
			delays,
		}
	}

	const fixedRandom: Random = () => 1
	const constantNow = (time: number): Now => () => time
	function scriptedNow(values: readonly number[]): Now {
		let i = 0
		return () => values[Math.min(i++, values.length - 1)]!
	}

	function buildFetch(responses: readonly Response[], now: Now = constantNow(BASE_TIME)): { fetch: Fetch; callCount: () => number; delays: () => number[] } {
		const http = createFakeHttpFetch(responses)
		const sleep = createFakeSleep()
		const fetch = createFetch({ httpFetch: http.httpFetch, sleep: sleep.sleep, random: fixedRandom, now })
		return { fetch, callCount: http.callCount, delays: () => sleep.delays }
	}

	it("returns a success response without retrying", async () => {
		const { fetch, callCount, delays } = buildFetch([response(200)])
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(200)
		expect(callCount()).toBe(1)
		expect(delays()).toEqual([])
	})

	it("does not retry on a non-retryable 4xx status", async () => {
		const { fetch, callCount, delays } = buildFetch([response(400)])
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(400)
		expect(callCount()).toBe(1)
		expect(delays()).toEqual([])
	})

	it("retries a 429 with exponential backoff when no headers are present", async () => {
		const { fetch, callCount, delays } = buildFetch([response(429), response(200)])
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(200)
		expect(callCount()).toBe(2)
		expect(delays()).toEqual([1_000])
	})

	it("retries a 5xx status", async () => {
		const { fetch, callCount, delays } = buildFetch([response(503), response(200)])
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(200)
		expect(callCount()).toBe(2)
		expect(delays()).toEqual([1_000])
	})

	it("honors the Retry-After header in seconds", async () => {
		const { fetch, delays } = buildFetch([response(429, { "Retry-After": "5" }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([5_000])
	})

	it("treats X-RateLimit-Reset below the epoch threshold as seconds-until-reset", async () => {
		const { fetch, delays } = buildFetch([response(429, { "X-RateLimit-Reset": "30" }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([30_000])
	})

	it("treats X-RateLimit-Reset at/above the epoch threshold as a Unix timestamp", async () => {
		const resetEpochSeconds = (BASE_TIME + 10_000) / 1000
		const { fetch, delays } = buildFetch([response(429, { "X-RateLimit-Reset": String(resetEpochSeconds) }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([10_000])
	})

	it("clamps a past Unix epoch reset to a zero base wait", async () => {
		const resetEpochSeconds = (BASE_TIME - 5_000) / 1000
		const { fetch, delays } = buildFetch([response(429, { "X-RateLimit-Reset": String(resetEpochSeconds) }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([0])
	})

	it("prefers Retry-After over X-RateLimit-Reset when both are present", async () => {
		const { fetch, delays } = buildFetch([response(429, { "Retry-After": "2", "X-RateLimit-Reset": "999" }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([2_000])
	})

	it("applies exponential backoff progression and caps at MAX_BACKOFF, then returns the final 429", async () => {
		const elevenFailures = Array.from({ length: 11 }, () => response(429))
		const { fetch, callCount, delays } = buildFetch(elevenFailures)
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(429)
		expect(callCount()).toBe(11)
		expect(delays()).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000])
	})

	it("caps a far-future reset at MAX_SINGLE_WAIT_MILLISECONDS", async () => {
		const farFutureEpochSeconds = (BASE_TIME + 10 * 60 * 1000) / 1000
		const { fetch, delays } = buildFetch([response(429, { "X-RateLimit-Reset": String(farFutureEpochSeconds) }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([240_000])
	})

	it("returns the 429 without sleeping when the deadline is already exhausted after a fetch", async () => {
		const now = scriptedNow([BASE_TIME, BASE_TIME + 301_000])
		const { fetch, callCount, delays } = buildFetch([response(429)], now)
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(429)
		expect(callCount()).toBe(1)
		expect(delays()).toEqual([])
	})

	it("caps the wait by the remaining deadline when Retry-After exceeds it", async () => {
		const now = scriptedNow([BASE_TIME, BASE_TIME, BASE_TIME + 290_000])
		const { fetch, callCount, delays } = buildFetch([response(429, { "Retry-After": "60" }), response(200)], now)
		const result = await fetch(new AbortController().signal, "body")
		expect(result.status).toBe(200)
		expect(callCount()).toBe(2)
		expect(delays()).toEqual([10_000])
	})

	it("falls back to exponential backoff when Retry-After is non-numeric", async () => {
		const { fetch, delays } = buildFetch([response(429, { "Retry-After": "soon" }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([1_000])
	})

	it("falls back to exponential backoff when X-RateLimit-Reset is non-numeric", async () => {
		const { fetch, delays } = buildFetch([response(429, { "X-RateLimit-Reset": "soon" }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([1_000])
	})

	it("falls back to exponential backoff when X-RateLimit-Reset is negative", async () => {
		const { fetch, delays } = buildFetch([response(429, { "X-RateLimit-Reset": "-5" }), response(200)])
		await fetch(new AbortController().signal, "body")
		expect(delays()).toEqual([1_000])
	})

	it("forwards the caller's abort signal to the in-flight httpFetch so requests can be cancelled mid-flight", async () => {
		const controller = new AbortController()
		let observedSignal: AbortSignal | undefined
		const httpFetch: Fetch = async (signal) => {
			observedSignal = signal
			return response(200)
		}
		const fetch = createFetch({ httpFetch, sleep: createFakeSleep().sleep, random: fixedRandom, now: constantNow(BASE_TIME) })

		await fetch(controller.signal, "body")

		expect(observedSignal).toBe(controller.signal)
	})
})
