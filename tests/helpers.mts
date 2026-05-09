import type { Agent } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { CommentTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "../source/configuration.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import type { GitHubConfiguration } from "../source/github-types.mts"
import type { Logger } from "../source/logger.mts"
import type { ToolCallResult, ToolExecutor } from "../source/tool-executor.mts"

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return { name: "TestAgent", prompt: "Test prompt.", ...overrides }
}

export function makeBaseCommitContext(overrides: Partial<BaseCommitContext> = {}): BaseCommitContext {
	return {
		fileList: [],
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
	return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
}

export function createMockLogger(): Logger {
	return {
		log: () => {},
	}
}

export function makeNoopToolExecutor(): ToolExecutor {
	return {
		definitions: [],
		async execute(): Promise<ToolCallResult> {
			throw new Error("Unexpected tool call in test")
		},
	}
}

export function makeSpawnGit(responses: Map<string, GitDiffResult>): SpawnGit {
	return async (parameters: string[]) => {
		const key = parameters.join(" ")
		const result = responses.get(key)
		if (result) return result
		throw new Error(`Unexpected spawnGit call: ${key}`)
	}
}

export function ok(stdout: string): GitDiffResult {
	return { stdout, stderr: "", exitCode: 0, signalCode: null }
}

export function error(stderr: string): GitDiffResult {
	return { stdout: "", stderr, exitCode: 1, signalCode: null }
}

export function timeout(): GitDiffResult {
	return { stdout: "", stderr: "", exitCode: null, signalCode: "SIGTERM" }
}
