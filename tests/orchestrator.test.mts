import { describe, it, expect } from "bun:test"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "../source/orchestrator.mts"
import type { Agent, AgentReader, AgentDirectories } from "../source/agents.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import type { Fetch } from "../source/agent-loop.mts"
import type { GitHubFetch } from "../source/github.mts"
import { makeAgent, makeCommentTriggerConfiguration, makePullRequestConfiguration, makeLocalDiffConfiguration, createMockLogger, createMockAgentFetch, buildContentSse } from "./helpers.mts"
import type { DebugWriter } from "../source/debug.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"

const silentLogger = createMockLogger()
const noopDebugWriter: DebugWriter = { writePrompt: async () => {}, writeTrace: async () => {} }

const agentDirectories: AgentDirectories = { userAgentsDirectory: "/test/user-agents", builtinAgentsDirectory: "/test/builtin-agents" }

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

function makeGithubFetch(options: { diffText?: string; baseCommit?: string; diffError?: Error; submitStatus?: number } = {}): GitHubFetch {
	return async (url: string, init: RequestInit) => {
		if (options.diffError && url.includes("/pulls/") && !url.includes("/reviews")) {
			const headers = new Headers(init.headers)
			if (headers.get("Accept") === "application/vnd.github.diff") {
				throw options.diffError
			}
			return new Response(JSON.stringify({ base: { sha: options.baseCommit ?? "base123" } }), { status: 200 })
		}
		if (url.includes("/reviews")) {
			if (options.submitStatus && options.submitStatus !== 200) {
				return new Response("Error", { status: options.submitStatus, statusText: "Error" })
			}
			return new Response(null, { status: 200 })
		}
		const headers = new Headers(init.headers)
		if (headers.get("Accept") === "application/vnd.github.diff") {
			return new Response(options.diffText ?? "", { status: 200 })
		}
		return new Response(JSON.stringify({ base: { sha: options.baseCommit ?? "base123" } }), { status: 200 })
	}
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
			agentDirectories,
			"test-model",
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
				githubFetch: makeGithubFetch({ diffText: "" }),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			agentDirectories,
			"test-model",
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review when triggered and files exist", async () => {
		let submittedReview: GitHubReviewPayload

		await runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch: async (url: string, init: RequestInit) => {
					if (url.includes("/reviews")) {
						const body = init.body
						if (typeof body === "string") submittedReview = JSON.parse(body)
						return new Response(null, { status: 200 })
					}
					const headers = new Headers(init.headers)
					if (headers.get("Accept") === "application/vnd.github.diff") {
						return new Response(SAMPLE_DIFF, { status: 200 })
					}
					return new Response(JSON.stringify({ base: { sha: "base123" } }), { status: 200 })
				},
				fetch: makeFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			agentDirectories,
			"test-model",
		)

		expect(submittedReview!).toBeDefined()
		expect(submittedReview!.event).toBe("COMMENT")
		expect(submittedReview!.body).toContain("Good work")
	})

	it("propagates error when readAgents throws", async () => {
		const readAgents: AgentReader = async () => { throw new Error("Read failure") }

		expect(runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents,
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF }),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow("Read failure")
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		expect(runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffError: new Error("API error") }),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow("API error")
	})

	it("propagates error when submitReview throws", async () => {
		expect(runOnCommentTrigger(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF, submitStatus: 500 }),
				fetch: makeFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeCommentTriggerConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow("Failed to submit review")
	})
})

describe("runOnPullRequest", () => {
	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffText: "" }),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			agentDirectories,
			"test-model",
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review after analysis", async () => {
		let submittedReview: GitHubReviewPayload

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				githubFetch: async (url: string, init: RequestInit) => {
					if (url.includes("/reviews")) {
						const body = init.body
						if (typeof body === "string") submittedReview = JSON.parse(body)
						return new Response(null, { status: 200 })
					}
					const headers = new Headers(init.headers)
					if (headers.get("Accept") === "application/vnd.github.diff") {
						return new Response(SAMPLE_DIFF, { status: 200 })
					}
					return new Response(JSON.stringify({ base: { sha: "base123" } }), { status: 200 })
				},
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			agentDirectories,
			"test-model",
		)

		expect(submittedReview!).toBeDefined()
		expect(submittedReview!.body).toContain("Great work")
	})

	it("propagates error when readAgents throws", async () => {
		const readAgents: AgentReader = async () => { throw new Error("Read failure") }

		expect(runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents,
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF }),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow("Read failure")
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		expect(runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: makeGithubFetch({ diffError: new Error("API error") }),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makePullRequestConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow("API error")
	})
})

describe("runOnLocalDiff", () => {
	it("returns early when no files changed", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			agentDirectories,
			"test-model",
		)

		expect(result).toBe("No files changed, nothing to review")
	})

	it("formats review to console", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				fetch: makeFetch("Looks good"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			agentDirectories,
			"test-model",
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
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			agentDirectories,
			"test-model",
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
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow("Failed to get diff")
	})

	it("propagates error when fetch returns invalid JSON", async () => {
		const fetch = createMockAgentFetch(buildContentSse("not json"))

		expect(runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: "Aggregator", prompt: "Aggregate." }]),
				fetch,
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration(),
			agentDirectories,
			"test-model",
		)).rejects.toThrow(/Failed to parse aggregator output as JSON/)
	})
})
