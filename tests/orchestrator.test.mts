import { describe, it, expect } from "bun:test"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "../source/orchestrator.mts"
import { IDENTITY_PROFILE } from "../source/provider-profiles.mts"
import type { Agent, AgentReader } from "../source/agents.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import type { Fetch } from "../source/agent-loop.mts"
import type { GitHubFetch } from "../source/github.mts"
import { makeAgent, makeCommentTriggerConfiguration, makePullRequestConfiguration, makeLocalDiffConfiguration, createMockLogger, createMockAgentFetch, buildContentSse } from "./helpers.mts"
import type { DebugWriter } from "../source/debug.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"

const silentLogger = createMockLogger()
const noopDebugWriter: DebugWriter = { writePrompt: async () => {}, writeTrace: async () => {} }

const userAgentsDirectory = "/test/user-agents"
const builtinAgentsDirectory = "/test/builtin-agents"

function makeReadAgents(agents: Agent[]): AgentReader {
	return async (_directory: string) => agents
}

function makeFetch(body: string): Fetch {
	const output = JSON.stringify({ body, comments: [] })
	return createMockAgentFetch(buildContentSse(output))
}

function makeSpawnGitOk(): SpawnGit {
	return async (params: string[]) => {
		if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
		return { stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
	}
}

function makeSpawnGitWithDiff(diffText: string): SpawnGit {
	return async (params: string[]) => {
		if (params[0] === "diff") return { stdout: diffText, stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
		if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
		return { stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
	}
}

function makeGithubFetch(options: { diffText?: string; baseCommit?: string; diffError?: Error; submitStatus?: number; submitResponses?: readonly { status: number; body?: string }[] } = {}): { githubFetch: GitHubFetch; submitCallCount: () => number; submittedReviews: () => readonly GitHubReviewPayload[] } {
	let submitIndex = 0
	const reviewBodies: GitHubReviewPayload[] = []
	const githubFetch: GitHubFetch = async (url: string, init: RequestInit) => {
		if (options.diffError && url.includes("/pulls/") && !url.includes("/reviews")) {
			const headers = new Headers(init.headers)
			if (headers.get("Accept") === "application/vnd.github.diff") {
				throw options.diffError
			}
			return new Response(JSON.stringify({ base: { sha: options.baseCommit ?? "base123" } }), { status: 200 })
		}
		if (url.includes("/reviews")) {
			submitIndex++
			if (options.submitResponses) {
				const response = options.submitResponses[Math.min(submitIndex - 1, options.submitResponses.length - 1)]!
				if (response.status === 200 && typeof init.body === "string") {
					reviewBodies.push(JSON.parse(init.body))
				}
				return new Response(response.body ?? null, { status: response.status })
			}
			if (options.submitStatus && options.submitStatus !== 200) {
				return new Response("Error", { status: options.submitStatus, statusText: "Error" })
			}
			if (typeof init.body === "string") {
				reviewBodies.push(JSON.parse(init.body))
			}
			return new Response(null, { status: 200 })
		}
		const headers = new Headers(init.headers)
		if (headers.get("Accept") === "application/vnd.github.diff") {
			return new Response(options.diffText ?? "", { status: 200 })
		}
		return new Response(JSON.stringify({ base: { sha: options.baseCommit ?? "base123" } }), { status: 200 })
	}
	return { githubFetch, submitCallCount: () => submitIndex, submittedReviews: () => reviewBodies }
}

const SAMPLE_DIFF = [
	"diff --git a/src/file.ts b/src/file.ts",
	"--- a/src/file.ts",
	"+++ b/src/file.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
].join("\n")

describe("runOnCommentTrigger", () => {
	it("returns early when comment does not trigger review", async () => {
		let fetchCalled = false
		let submitCalled = false

		await runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: async () => { fetchCalled = true; return new Response() },
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration({ commentBody: "just a comment" }),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)

		expect(fetchCalled).toBe(false)
		expect(submitCalled).toBe(false)
	})

	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffText: "" }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review when triggered and files exist", async () => {
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch,
				fetch: makeFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)

		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.event).toBe("COMMENT")
		expect(submittedReviews()[0]!.body).toContain("Good work")
	})

	it("propagates error when readAgents throws", async () => {
		const readAgents: AgentReader = async () => { throw new Error("Read failure") }

		expect(runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents,
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)).rejects.toThrow("Read failure")
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		expect(runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffError: new Error("API error") }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)).rejects.toThrow("API error")
	})

	it("propagates error when submitReview throws with a non-422 status", async () => {
		expect(runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF, submitStatus: 500 }).githubFetch,
				fetch: makeFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)).rejects.toThrow("Failed to submit review")
	})

	it("retries submit when GitHub returns 422 and accepts the corrected output", async () => {
		const capturedBodies: string[] = []
		let fetchCount = 0
		const fetch: Fetch = async (_signal, body, _headers) => {
			capturedBodies.push(body)
			fetchCount++
			const content = fetchCount === 1
				? JSON.stringify({ body: "Agent result", comments: [] })
				: (fetchCount === 2
					? JSON.stringify({ body: "First try", comments: [{ path: "src/file.ts", line: 999, side: "RIGHT", body: "wrong line" }] })
					: JSON.stringify({ body: "Second try", comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "correct line" }] }))
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(buildContentSse(content)))
					controller.close()
				}
			})
			return new Response(stream, { status: 200 })
		}

		const { githubFetch, submitCallCount, submittedReviews } = makeGithubFetch({
			diffText: SAMPLE_DIFF,
			submitResponses: [
				{ status: 422, body: JSON.stringify({ message: "Unprocessable Entity", errors: ["Line could not be resolved"] }) },
				{ status: 200 },
			],
		})

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch,
				fetch,
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)

		expect(submitCallCount()).toBe(2)
		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.body).toContain("Second try")
		expect(submittedReviews()[0]!.comments).toHaveLength(1)
		expect(submittedReviews()[0]!.comments[0]!.line).toBe(1)

		const thirdAggregatorRequest = JSON.parse(capturedBodies[2]!)
		const lastUserMessage = thirdAggregatorRequest.messages.at(-1)
		expect(lastUserMessage.role).toBe("user")
		expect(lastUserMessage.content).toContain("Your previous output failed on submission to GitHub:\nHTTP Status: 422\n{\"message\":\"Unprocessable Entity\",\"errors\":[\"Line could not be resolved\"]}")
		expect(lastUserMessage.content).toContain("Line could not be resolved")
	})

	it("does not retry on 401/403/404/429 submit errors", async () => {
		for (const status of [401, 403, 404, 429]) {
			const { githubFetch, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, submitStatus: status })

			await expect(runOnPullRequest(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
				},
				makePullRequestConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				IDENTITY_PROFILE,
			)).rejects.toThrow()

			expect(submitCallCount()).toBe(1)
		}
	})
})

describe("runOnPullRequest", () => {
	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffText: "" }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review after analysis", async () => {
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch,
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)

		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.body).toContain("Great work")
	})

	it("propagates error when readAgents throws", async () => {
		const readAgents: AgentReader = async () => { throw new Error("Read failure") }

		expect(runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents,
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)).rejects.toThrow("Read failure")
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		expect(runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffError: new Error("API error") }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			IDENTITY_PROFILE,
		)).rejects.toThrow("API error")
	})
})

describe("runOnLocalDiff", () => {
	it("returns early when no files changed", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: async () => new Response(),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(result).toBe("No files changed, nothing to review")
	})

	it("formats review to console", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch: async () => new Response(),
				fetch: makeFetch("Looks good"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(result).toContain("Looks good")
	})

	it("propagates error when validateGitRepository throws", async () => {
		const spawnGit: SpawnGit = async (params) => {
			if (params[0] === "rev-parse") return { stdout: "", stderr: "fatal: not a git repository", exitCode: 1, signalCode: null }
			if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null }
			return { stdout: "", stderr: "", exitCode: 0, signalCode: null }
		}

		expect(runOnLocalDiff(
			{
				spawnGit,
				readAgents: makeReadAgents([]),
				githubFetch: async () => new Response(),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			"/test/workspace",
			IDENTITY_PROFILE,
		)).rejects.toThrow("No git repository found")
	})

	it("propagates error when generateLocalDiff throws", async () => {
		const spawnGit: SpawnGit = async (params) => {
			if (params[0] === "diff") return { stdout: "", stderr: "diff failed", exitCode: 1, signalCode: null }
			if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null }
			return { stdout: "", stderr: "", exitCode: 0, signalCode: null }
		}

		expect(runOnLocalDiff(
			{
				spawnGit,
				readAgents: makeReadAgents([]),
				githubFetch: async () => new Response(),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			"/test/workspace",
			IDENTITY_PROFILE,
		)).rejects.toThrow("Failed to get diff")
	})

	it("feeds back the parse error and accepts the corrected output in local-diff mode", async () => {
		let callCount = 0
		const fetch: Fetch = async (_signal, _body, _headers) => {
			callCount++
			const content = callCount === 1
				? JSON.stringify({ body: "Agent result", comments: [] })
				: (callCount === 2
					? "not json"
					: JSON.stringify({ body: "Looks good", comments: [] }))
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(buildContentSse(content)))
					controller.close()
				}
			})
			return new Response(stream, { status: 200 })
		}

		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch: async () => new Response(),
				fetch,
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(callCount).toBe(3)
		expect(result).toContain("Looks good")
	})
})
