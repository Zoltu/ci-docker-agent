import type { Agent } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { DiffResult, DiffFile } from "../source/diff.mts"
import type { GitHubConfiguration } from "../source/github-types.mts"
import type { CommentTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "../source/configuration.mts"

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return { name: "TestAgent", prompt: "Test prompt.", ...overrides }
}

export function makeDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
	return {
		filename: "src/file.ts",
		status: "modified",
		additions: 1,
		deletions: 0,
		patch: "@@ -1 +1 @@\n-old\n+new",
		...overrides,
	}
}

export function makeDiffResult(overrides: Partial<DiffResult> = {}): DiffResult {
	return {
		files: [],
		binaryFiles: [],
		...overrides,
	}
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
		commentId: 1,
		workspaceDirectory: "/workspace",
		...overrides,
	}
}

export function makePullRequestConfiguration(overrides: Partial<PullRequestConfiguration> = {}): PullRequestConfiguration {
	return {
		type: "pull-request",
		agents: "run all agents",
		github: makeGitHubConfiguration(),
		workspaceDirectory: "/workspace",
		...overrides,
	}
}

export function makeLocalDiffConfiguration(overrides: Partial<LocalDiffConfiguration> = {}): LocalDiffConfiguration {
	return {
		type: "local-diff",
		agents: "run all agents",
		baseCommit: "abc",
		headCommit: "def",
		workspaceDirectory: "/workspace",
		...overrides,
	}
}
