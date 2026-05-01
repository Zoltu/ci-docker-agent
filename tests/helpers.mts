import type { Agent } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { GitHubConfiguration } from "../source/github-types.mts"
import type { CommentTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "../source/configuration.mts"

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return { name: "TestAgent", prompt: "Test prompt.", ...overrides }
}

export function makeBaseCommitContext(overrides: Partial<BaseCommitContext> = {}): BaseCommitContext {
	return {
		fileList: [],
		fileContents: new Map(),
		...overrides,
	}
}

export function makeGitHubConfiguration(overrides: Partial<GitHubConfiguration> = {}): GitHubConfiguration {
	return {
		token: "test-token",
		apiUrl: "https://api.github.com",
		repository: "owner/repo",
		owner: "owner",
		repositoryName: "repo",
		pullRequestNumber: 42,
		...overrides,
	}
}

export function makeCommentTriggerConfiguration(overrides: Partial<CommentTriggerConfiguration> = {}): CommentTriggerConfiguration {
	return {
		type: "comment-trigger",
		github: makeGitHubConfiguration(),
		commentBody: "/review",
		...overrides,
	}
}

export function makePullRequestConfiguration(overrides: Partial<PullRequestConfiguration> = {}): PullRequestConfiguration {
	return {
		type: "pull-request",
		agents: "run all agents",
		github: makeGitHubConfiguration(),
		...overrides,
	}
}

export function makeLocalDiffConfiguration(overrides: Partial<LocalDiffConfiguration> = {}): LocalDiffConfiguration {
	return {
		type: "local-diff",
		agents: "run all agents",
		baseCommit: "abc",
		headCommit: "def",
		...overrides,
	}
}
