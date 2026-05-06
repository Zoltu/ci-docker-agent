import { describe, it, expect } from "bun:test"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "../source/orchestrator.mts"
import type { Agent, AgentNames, ResolveResult } from "../source/agents.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import type { ToolDefinition } from "../source/tool-executor.mts"
import { makeAgent, makeCommentTriggerConfiguration, makePullRequestConfiguration, makeLocalDiffConfiguration, createMockLogger, createMockStream, wrapInSse } from "./helpers.mts"
import type { DebugWriter } from "../source/debug.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"
import type { AiFetch, AiMessage } from "../source/ai.mts"

const silentLogger = createMockLogger()
const noopDebugWriter: DebugWriter = { writePrompt: () => {}, writeTrace: () => {}, writeContent: () => {} }

function makeLoadAgents(agents: Agent[]): (agentNames: AgentNames) => Promise<ResolveResult> {
	return async (_agentNames: AgentNames) => ({ agents, unresolvedNames: [] })
}

function makeLoadAggregator(overrides: Partial<Agent> = {}): () => Promise<Agent> {
	return async () => ({ name: "Aggregator", prompt: "Aggregate.", ...overrides })
}

function makeAiFetch(body: string): AiFetch {
	const output = JSON.stringify({ body, comments: [] })
	return async (_messages: AiMessage[], _tools: ToolDefinition[], _signal: AbortSignal) => createMockStream([wrapInSse(output)])
}

function makeSpawnGitOk(): SpawnGit {
	return async () => ({ stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult)
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
				fetchPullRequestDiff: async () => { fetchCalled = true; return "" },
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => { submitCalled = true },
			},
			makeCommentTriggerConfiguration({ commentBody: "just a comment" })
		)

		expect(fetchCalled).toBe(false)
		expect(submitCalled).toBe(false)
	})

	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => "",
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => { submitCalled = true },
			},
			makeCommentTriggerConfiguration()
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review when triggered and files exist", async () => {
		let submittedReview: GitHubReviewPayload

		await runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => SAMPLE_DIFF,
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async (review) => { submittedReview = review },
			},
			makeCommentTriggerConfiguration()
		)

		expect(submittedReview!).toBeDefined()
		expect(submittedReview!.event).toBe("COMMENT")
		expect(submittedReview!.body).toContain("Good work")
	})
	it("propagates error when loadAgents throws", async () => {
		const loadAgents = async (): Promise<ResolveResult> => { throw new Error("Agent load failure") }

		expect(runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => SAMPLE_DIFF,
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents,
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => {},
			},
			makeCommentTriggerConfiguration()
		)).rejects.toThrow("Agent load failure")
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		expect(runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => { throw new Error("API error") },
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => {},
			},
			makeCommentTriggerConfiguration()
		)).rejects.toThrow("API error")
	})

	it("propagates error when submitReview throws", async () => {
		expect(runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => SAMPLE_DIFF,
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => { throw new Error("Submit failed") },
			},
			makeCommentTriggerConfiguration()
		)).rejects.toThrow("Submit failed")
	})
})

describe("runOnPullRequest", () => {
	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnPullRequest(
			{
				fetchPullRequestDiff: async () => "",
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => { submitCalled = true },
			},
			makePullRequestConfiguration()
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review after analysis", async () => {
		let submittedReview: GitHubReviewPayload

		await runOnPullRequest(
			{
				fetchPullRequestDiff: async () => SAMPLE_DIFF,
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async (review) => { submittedReview = review },
			},
			makePullRequestConfiguration()
		)

		expect(submittedReview!).toBeDefined()
		expect(submittedReview!.body).toContain("Great work")
	})
	it("propagates error when loadAgents throws", async () => {
		const loadAgents = async (): Promise<ResolveResult> => { throw new Error("Agent load failure") }

		expect(runOnPullRequest(
			{
				fetchPullRequestDiff: async () => SAMPLE_DIFF,
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents,
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => {},
			},
			makePullRequestConfiguration()
		)).rejects.toThrow("Agent load failure")
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		expect(runOnPullRequest(
			{
				fetchPullRequestDiff: async () => { throw new Error("API error") },
				fetchPullRequestBaseCommit: async () => "base123",
				spawnGit: makeSpawnGitOk(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				submitReview: async () => {},
			},
			makePullRequestConfiguration()
		)).rejects.toThrow("API error")
	})
})

describe("runOnLocalDiff", () => {
	it("returns early when no files changed", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => "",
				validateGitRepository: async () => {},
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration()
		)

		expect(result).toBe("No files changed, nothing to review")
	})

	it("formats review to console", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => SAMPLE_DIFF,
				validateGitRepository: async () => {},
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch("Looks good"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration()
		)

		expect(result).toContain("Looks good")
	})

	it("propagates error when validateGitRepository throws", async () => {
		expect(runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => "",
				validateGitRepository: () => { throw new Error("No git repository") },
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration()
		)).rejects.toThrow("No git repository")
	})

	it("propagates error when generateLocalDiff throws", async () => {
		expect(runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => { throw new Error("Diff failed") },
				validateGitRepository: async () => {},
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				aiFetch: makeAiFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration()
		)).rejects.toThrow("Diff failed")
	})

	it("propagates error when aiFetch returns invalid JSON", async () => {
		const aiFetch: AiFetch = async (_messages, _tools, _signal) => createMockStream([wrapInSse("not json")])

		expect(runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => SAMPLE_DIFF,
				validateGitRepository: async () => {},
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				aiFetch,
				logger: silentLogger,
				debugWriter: noopDebugWriter,
			},
			makeLocalDiffConfiguration()
		)).rejects.toThrow(/Failed to parse aggregator output as JSON/)
	})
})
