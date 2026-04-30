import { describe, it, expect } from "bun:test"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "../source/orchestrator.mts"
import type { Agent, AgentNames, ResolveResult } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import { makeAgent, makeDiffFile, makeDiffResult, makeBaseCommitContext, makeCommentTriggerConfiguration, makePullRequestConfiguration, makeLocalDiffConfiguration } from "./helpers.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"
import type { CallApi } from "../source/ai.mts"

const silentLog = () => {}

function makeLoadAgents(agents: Agent[]): (agentNames: AgentNames) => Promise<ResolveResult> {
	return async (_agentNames: AgentNames) => ({ agents, unresolvedNames: [] })
}

function makeLoadAggregator(overrides: Partial<Agent> = {}): () => Promise<Agent> {
	return async () => ({ name: "Aggregator", prompt: "Aggregate.", ...overrides })
}

function makeCallApi(body: string): CallApi {
	return async () => JSON.stringify({ body, comments: [] })
}

function makeGetBaseCommitContext(overrides: Partial<BaseCommitContext> = {}): (baseCommit: string) => Promise<BaseCommitContext> {
	return async () => makeBaseCommitContext(overrides)
}

function makeSpawnGitOk(): SpawnGit {
	return async () => ({ stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult)
}

describe("runOnCommentTrigger", () => {
	it("returns early when comment does not trigger review", async () => {
		let fetchCalled = false
		let submitCalled = false
		let reactCalled = false

		await runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => { fetchCalled = true; return makeDiffResult() },
				fetchPullRequestBaseCommit: async () => "base123",
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				log: silentLog,
				submitReview: async () => { submitCalled = true },
				reactToComment: async () => { reactCalled = true },
			},
			makeCommentTriggerConfiguration({ commentBody: "just a comment" })
		)

		expect(fetchCalled).toBe(false)
		expect(submitCalled).toBe(false)
		expect(reactCalled).toBe(false)
	})

	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => makeDiffResult(),
				fetchPullRequestBaseCommit: async () => "base123",
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				log: silentLog,
				submitReview: async () => { submitCalled = true },
				reactToComment: async () => {},
			},
			makeCommentTriggerConfiguration()
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review when triggered and files exist", async () => {
		let submittedReview: GitHubReviewPayload | null = null

		await runOnCommentTrigger(
			{
				fetchPullRequestDiff: async () => makeDiffResult({ files: [makeDiffFile()] }),
				fetchPullRequestBaseCommit: async () => "base123",
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi("Good work"),
				log: silentLog,
				submitReview: async (review) => { submittedReview = review },
				reactToComment: async () => {},
			},
			makeCommentTriggerConfiguration()
		)

		expect(submittedReview).not.toBeNull()
		expect(submittedReview!.event).toBe("COMMENT")
		expect(submittedReview!.body).toContain("Good work")
	})

	it("reacts with -1 on error", async () => {
		let reactedId = 0
		let reactedContent = ""

		try {
			await runOnCommentTrigger(
				{
					fetchPullRequestDiff: async () => makeDiffResult({ files: [makeDiffFile()] }),
					fetchPullRequestBaseCommit: async () => "base123",
					getBaseCommitContext: makeGetBaseCommitContext(),
					loadAgents: makeLoadAgents([makeAgent()]),
					loadAggregator: makeLoadAggregator(),
					callApi: makeCallApi("Good work"),
					log: silentLog,
					submitReview: async () => { throw new Error("submit failed") },
					reactToComment: async (id, content) => { reactedId = id; reactedContent = content },
				},
				makeCommentTriggerConfiguration({ commentId: 42 })
			)
			expect(false).toBe(true)
		} catch {
			expect(reactedId).toBe(42)
			expect(reactedContent).toBe("-1")
		}
	})
})

describe("runOnPullRequest", () => {
	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnPullRequest(
			{
				fetchPullRequestDiff: async () => makeDiffResult(),
				fetchPullRequestBaseCommit: async () => "base123",
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				log: silentLog,
				submitReview: async () => { submitCalled = true },
			},
			makePullRequestConfiguration()
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review after analysis", async () => {
		let submittedReview: GitHubReviewPayload | null = null

		await runOnPullRequest(
			{
				fetchPullRequestDiff: async () => makeDiffResult({ files: [makeDiffFile()] }),
				fetchPullRequestBaseCommit: async () => "base123",
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi("Great work"),
				log: silentLog,
				submitReview: async (review) => { submittedReview = review },
			},
			makePullRequestConfiguration()
		)

		expect(submittedReview).not.toBeNull()
		expect(submittedReview!.body).toContain("Great work")
	})
})

describe("runOnLocalDiff", () => {
	it("returns early when no files changed", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => makeDiffResult(),
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				log: silentLog,
			},
			makeLocalDiffConfiguration()
		)

		expect(result).toBe("No files changed, nothing to review")
	})

	it("formats review to console", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				generateLocalDiff: async () => makeDiffResult({ files: [makeDiffFile()] }),
				getBaseCommitContext: makeGetBaseCommitContext(),
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi("Looks good"),
				log: silentLog,
			},
			makeLocalDiffConfiguration()
		)

		expect(result).toContain("Looks good")
		expect(result).toContain("src/file.ts")
	})
})
