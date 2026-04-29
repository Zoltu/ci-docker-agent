import type { Agent } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { DiffResult, DiffFile } from "../source/diff.mts"
import type { GitHubConfiguration } from "../source/github-types.mts"

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
