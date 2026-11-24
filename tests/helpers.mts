import type { Agent } from "../source/agents.mts"
import type { BaseCommitContext } from "../source/base-commit.mts"
import type { LabelTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "../source/configuration.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import type { GitHubConfiguration } from "../source/github-types.mts"
import { REVIEW_START_LABEL } from "../source/labels.mts"
import type { Logger } from "../source/logger.mts"
import type { Fetch as SseFetch } from "../source/sse.mts"
import type { Fetch as AgentFetch } from "../source/agent-loop.mts"

// A base commit as GitHub reports it: 40 lowercase hex characters, the width the base.sha boundary check requires.
export const BASE_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"

// A base commit from a repository that uses SHA-256 object names.
export const BASE_COMMIT_SHA_256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

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
		owner: "owner",
		repositoryName: "repo",
		pullRequestNumber: 42,
		...overrides,
	}
}

export function makeLabelTriggerConfiguration(overrides: Partial<LabelTriggerConfiguration> = {}): LabelTriggerConfiguration {
	return {
		type: "label-trigger",
		triggerLabel: REVIEW_START_LABEL,
		github: makeGitHubConfiguration(),
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

export function createMockFetch(sseText: string): SseFetch {
	return async (_body: string, _headers?: Record<string, string>) => {
		const encoder = new TextEncoder()
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText))
				controller.close()
			}
		})
		return new Response(stream, { status: 200 })
	}
}

export function buildContentSse(content: string): string {
	const firstChunk = { choices: [{ delta: { role: "assistant", content }, finish_reason: null }] }
	const finalChunk = { choices: [{ delta: {}, finish_reason: "stop" }] }
	return `data: ${JSON.stringify(firstChunk)}\n\ndata: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`
}

export function createMockAgentFetch(sseText: string): AgentFetch {
	return async (_signal: AbortSignal, _body: string, _headers?: Record<string, string>) => {
		const encoder = new TextEncoder()
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText))
				controller.close()
			}
		})
		return new Response(stream, { status: 200 })
	}
}

export function createMockLogger(): Logger {
	return {
		log: () => {},
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
