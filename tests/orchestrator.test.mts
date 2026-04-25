import { describe, it, expect } from "bun:test"
import { runAnalysis, runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "../source/orchestrator.mts"
import type { Agent, ResolveResult } from "../source/agents.mts"
import type { PullRequestFile, GitHubConfiguration, GitHubReviewPayload } from "../source/github-types.mts"
import type { CallApi } from "../source/ai.mts"

function makeGitHubConfiguration(): GitHubConfiguration {
	return {
		token: "test-token",
		apiUrl: "https://api.github.com",
		repository: "owner/repo",
		owner: "owner",
		repositoryName: "repo",
		pullRequestNumber: 42,
	}
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return { name: "TestAgent", prompt: "Test prompt.", ...overrides }
}

function makePullRequestFile(overrides: Partial<PullRequestFile> = {}): PullRequestFile {
	return {
		filename: "src/file.ts",
		status: "modified",
		additions: 1,
		deletions: 0,
		changes: 1,
		...overrides,
	}
}

function makeLoadAgents(agents: Agent[]): () => Promise<ResolveResult> {
	return async () => ({ agents, unresolvedNames: [] })
}

function makeLoadAggregator(overrides: Partial<Agent> = {}): () => Promise<Agent> {
	return async () => ({ name: "Aggregator", prompt: "Aggregate.", ...overrides })
}

function makeCallApi(body: string): CallApi {
	return async () => JSON.stringify({ body, comments: [] })
}

describe("runAnalysis", () => {
	it("calls loadAgents, loadAggregator, and analyze", async () => {
		const agents = [makeAgent()]
		const loadAgents = makeLoadAgents(agents)
		const loadAggregator = makeLoadAggregator()
		let callApiCount = 0
		const callApi = async () => {
			callApiCount++
			return JSON.stringify({ body: `Result ${callApiCount}`, comments: [] })
		}
		const files = [makePullRequestFile()]

		const result = await runAnalysis({ loadAgents, loadAggregator, callApi }, "run all agents", files)

		expect(result.body).toBe("Result 2")
		expect(callApiCount).toBe(2)
	})
})

describe("runOnCommentTrigger", () => {
	it("returns early when comment does not trigger review", async () => {
		let fetchCalled = false
		let submitCalled = false
		let reactCalled = false

		await runOnCommentTrigger(
			{
				fetchPullRequestFiles: async () => { fetchCalled = true; return [] },
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				submitReview: async () => { submitCalled = true },
				reactToComment: async () => { reactCalled = true },
			},
			{ type: "comment-trigger", github: makeGitHubConfiguration(), commentBody: "just a comment", commentId: 1 }
		)

		expect(fetchCalled).toBe(false)
		expect(submitCalled).toBe(false)
		expect(reactCalled).toBe(false)
	})

	it("returns early when no files changed", async () => {
		let submitCalled = false

		await runOnCommentTrigger(
			{
				fetchPullRequestFiles: async () => [],
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				submitReview: async () => { submitCalled = true },
				reactToComment: async () => {},
			},
			{ type: "comment-trigger", github: makeGitHubConfiguration(), commentBody: "/review", commentId: 1 }
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review when triggered and files exist", async () => {
		let submittedReview: GitHubReviewPayload | null = null

		await runOnCommentTrigger(
			{
				fetchPullRequestFiles: async () => [makePullRequestFile()],
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi("Good work"),
				submitReview: async (review) => { submittedReview = review },
				reactToComment: async () => {},
			},
			{ type: "comment-trigger", github: makeGitHubConfiguration(), commentBody: "/review", commentId: 1 }
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
					fetchPullRequestFiles: async () => [makePullRequestFile()],
					loadAgents: makeLoadAgents([makeAgent()]),
					loadAggregator: makeLoadAggregator(),
					callApi: makeCallApi("Good work"),
					submitReview: async () => { throw new Error("submit failed") },
					reactToComment: async (id, content) => { reactedId = id; reactedContent = content },
				},
				{ type: "comment-trigger", github: makeGitHubConfiguration(), commentBody: "/review", commentId: 42 }
			)
			expect(false).toBe(true) // should throw
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
				fetchPullRequestFiles: async () => [],
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
				submitReview: async () => { submitCalled = true },
			},
			{ type: "pull-request", agents: "run all agents", github: makeGitHubConfiguration() }
		)

		expect(submitCalled).toBe(false)
	})

	it("submits review after analysis", async () => {
		let submittedReview: GitHubReviewPayload | null = null

		await runOnPullRequest(
			{
				fetchPullRequestFiles: async () => [makePullRequestFile()],
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi("Great work"),
				submitReview: async (review) => { submittedReview = review },
			},
			{ type: "pull-request", agents: "run all agents", github: makeGitHubConfiguration() }
		)

		expect(submittedReview).not.toBeNull()
		expect(submittedReview!.body).toContain("Great work")
	})
})

describe("runOnLocalDiff", () => {
	it("returns early when no files changed", async () => {
		const result = await runOnLocalDiff(
			{
				generateLocalDiff: async () => [],
				loadAgents: makeLoadAgents([]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi(""),
			},
			{ type: "local-diff", agents: "run all agents", baseCommit: "abc", headCommit: "def", workspaceDirectory: "/workspace" }
		)

		expect(result).toBe("No files changed, nothing to review")
	})

	it("formats review to console", async () => {
		const result = await runOnLocalDiff(
			{
				generateLocalDiff: async () => [makePullRequestFile()],
				loadAgents: makeLoadAgents([makeAgent()]),
				loadAggregator: makeLoadAggregator(),
				callApi: makeCallApi("Looks good"),
			},
			{ type: "local-diff", agents: "run all agents", baseCommit: "abc", headCommit: "def", workspaceDirectory: "/workspace" }
		)

		expect(result).toContain("Looks good")
		expect(result).toContain("src/file.ts")
	})
})
