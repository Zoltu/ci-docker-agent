import type { AgentNames } from "./agents.mts"
import type { GitHubConfiguration } from "./github-types.mts"
import { includes, parseCommaSeparatedList } from "./typescript-helpers.mts"

const EVENT_TYPES = ["pull_request_target", "workflow_dispatch", "issue_comment", "local"] as const

export type EventType = typeof EVENT_TYPES[number]

export interface CommentTriggerConfiguration {
	type: "comment-trigger"
	github: GitHubConfiguration
	commentBody: string
}

export interface PullRequestConfiguration {
	type: "pull-request"
	agents: AgentNames
	github: GitHubConfiguration
}

export interface LocalDiffConfiguration {
	type: "local-diff"
	agents: AgentNames
	baseCommit: string
	headCommit: string
}

export type Configuration = CommentTriggerConfiguration | PullRequestConfiguration | LocalDiffConfiguration

type TryResult<T> = { ok: true; value: T } | { ok: false; reason: string }

function parseAgents(value: string | undefined): AgentNames {
	if (!value) return "run all agents"
	return parseCommaSeparatedList(value)
}

function tryParseGitHubConfiguration(environment: Record<string, string | undefined>): TryResult<GitHubConfiguration> {
	const token = environment.GITHUB_TOKEN
	const pullRequestNumberString = environment.PR_NUMBER
	const repository = environment.REPO

	if (!token || !pullRequestNumberString || !repository) {
		const missing = []
		if (!token) missing.push("GITHUB_TOKEN")
		if (!pullRequestNumberString) missing.push("PR_NUMBER")
		if (!repository) missing.push("REPO")
		return { ok: false, reason: `GitHub mode requires ${missing.join(" and ")}` }
	}

	const pullRequestNumber = Number.parseInt(pullRequestNumberString, 10)
	if (Number.isNaN(pullRequestNumber)) return { ok: false, reason: `PR_NUMBER must be a valid number, got: ${pullRequestNumberString}` }

	const parts = repository.split("/")
	if (parts.length !== 2) return { ok: false, reason: `REPO must be in format 'owner/repo', got: ${repository}` }
	const owner = parts[0]
	const repositoryName = parts[1]
	if (!owner || !repositoryName) return { ok: false, reason: `REPO must be in format 'owner/repo', got: ${repository}` }

	const apiUrl = environment.GITHUB_API_URL ?? "https://api.github.com"

	return { ok: true, value: { token, apiUrl, repository, owner, repositoryName, pullRequestNumber } }
}

function tryGetLocalDiffConfiguration(environment: Record<string, string | undefined>, agents: AgentNames): TryResult<LocalDiffConfiguration> {
	const eventType = environment.EVENT_TYPE
	if (eventType && eventType !== "local") return { ok: false, reason: `EVENT_TYPE must be 'local' or unset for local diff mode. Got: ${eventType}` }

	const baseCommit = environment.BASE_COMMIT
	const headCommit = environment.HEAD_COMMIT

	if (!baseCommit || !headCommit) {
		if (!baseCommit && !headCommit) return { ok: false, reason: "BASE_COMMIT and HEAD_COMMIT are not set" }
		if (!headCommit) return { ok: false, reason: "HEAD_COMMIT is required when BASE_COMMIT is provided" }
		return { ok: false, reason: "BASE_COMMIT is required when HEAD_COMMIT is provided" }
	}

	return { ok: true, value: { type: "local-diff", agents, baseCommit, headCommit } }
}

function tryGetCommentTriggerConfiguration(environment: Record<string, string | undefined>): TryResult<CommentTriggerConfiguration> {
	const eventType = environment.EVENT_TYPE
	if (eventType !== "issue_comment") return { ok: false, reason: "EVENT_TYPE is not 'issue_comment'" }

	const githubResult = tryParseGitHubConfiguration(environment)
	if (!githubResult.ok) return githubResult

	const commentBody = environment.COMMENT_BODY ?? ""

	return { ok: true, value: { type: "comment-trigger", github: githubResult.value, commentBody } }
}

function tryGetPullRequestConfiguration(environment: Record<string, string | undefined>, agents: AgentNames): TryResult<PullRequestConfiguration> {
	const eventType = environment.EVENT_TYPE
	if (eventType === "issue_comment") return { ok: false, reason: "EVENT_TYPE is 'issue_comment', which requires comment trigger mode" }
	if (eventType === "local") return { ok: false, reason: "EVENT_TYPE is 'local', which requires local diff mode" }
	if (eventType && !includes(EVENT_TYPES, eventType)) return { ok: false, reason: `EVENT_TYPE must be one of: ${EVENT_TYPES.join(", ")}. Got: ${eventType}` }

	const githubResult = tryParseGitHubConfiguration(environment)
	if (!githubResult.ok) return githubResult

	return { ok: true, value: { type: "pull-request", agents, github: githubResult.value } }
}

export function createGetConfiguration(environment: Record<string, string | undefined>): () => Configuration {
	return function getConfiguration(): Configuration {
	const agents = parseAgents(environment.AGENTS)

	const localResult = tryGetLocalDiffConfiguration(environment, agents)
	if (localResult.ok) return localResult.value

	const commentResult = tryGetCommentTriggerConfiguration(environment)
	if (commentResult.ok) return commentResult.value

	const pullRequestResult = tryGetPullRequestConfiguration(environment, agents)
	if (pullRequestResult.ok) return pullRequestResult.value

	const reasons = [localResult, commentResult, pullRequestResult]
		.filter((r): r is { ok: false; reason: string } => !r.ok)
		.map(r => r.reason)
	throw new Error(`No valid configuration found:\n${reasons.map(r => `- ${r}`).join("\n")}`)
	}
}
