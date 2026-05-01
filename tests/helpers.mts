import type { Agent } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { CommentTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "../source/configuration.mts"
import type { GitHubConfiguration } from "../source/github-types.mts"
import type { Logger } from "../source/logger.mts"

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

export function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	const encodedChunks = chunks.map(chunk => encoder.encode(chunk))
	let index = 0
	return new ReadableStream({
		pull(controller) {
			if (index >= encodedChunks.length) {
				controller.close()
				return
			}
			controller.enqueue(encodedChunks[index])
			index++
		}
	})
}

export function wrapInSse(content: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
}

export function createMockLogger(): Logger {
	return {
		log: () => {},
	}
}
