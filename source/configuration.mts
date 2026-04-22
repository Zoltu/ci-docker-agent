import type { AgentNames } from "./agents.mts"
import type { GitHubConfig } from "./github-types.mts"
import { includes } from "./typescript-helpers.mts"

const EVENT_TYPES = ["pull_request_target", "workflow_dispatch", "issue_comment", "local"] as const

export type EventType = typeof EVENT_TYPES[number]

export interface CommentTriggerConfiguration {
	type: "comment-trigger"
	github: GitHubConfig
	commentBody: string
	commentId: number
}

export interface PullRequestConfiguration {
	type: "pull-request"
	agents: AgentNames
	github: GitHubConfig
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
	return value.split(",").map(a => a.trim()).filter(a => a.length > 0)
}

function tryParseGitHubConfig(env: Record<string, string | undefined>): TryResult<GitHubConfig> {
	const token = env.GITHUB_TOKEN
	const prNumberStr = env.PR_NUMBER
	const repo = env.REPO

	if (!token || !prNumberStr || !repo) {
		const missing = []
		if (!token) missing.push("GITHUB_TOKEN")
		if (!prNumberStr) missing.push("PR_NUMBER")
		if (!repo) missing.push("REPO")
		return { ok: false, reason: `GitHub mode requires ${missing.join(" and ")}` }
	}

	const prNumber = Number.parseInt(prNumberStr, 10)
	if (Number.isNaN(prNumber)) return { ok: false, reason: `PR_NUMBER must be a valid number, got: ${prNumberStr}` }

	const parts = repo.split("/")
	if (parts.length !== 2) return { ok: false, reason: `REPO must be in format 'owner/repo', got: ${repo}` }
	const owner = parts[0]
	const repoName = parts[1]
	if (!owner || !repoName) return { ok: false, reason: `REPO must be in format 'owner/repo', got: ${repo}` }

	const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com"

	return { ok: true, value: { token, apiUrl, repo, owner, repoName, prNumber } }
}

function tryGetLocalDiffConfiguration(env: Record<string, string | undefined>, agents: AgentNames): TryResult<LocalDiffConfiguration> {
	const baseCommit = env.BASE_COMMIT
	const headCommit = env.HEAD_COMMIT

	if (!baseCommit || !headCommit) {
		if (!baseCommit && !headCommit) return { ok: false, reason: "BASE_COMMIT and HEAD_COMMIT are not set" }
		if (!headCommit) return { ok: false, reason: "HEAD_COMMIT is required when BASE_COMMIT is provided" }
		return { ok: false, reason: "BASE_COMMIT is required when HEAD_COMMIT is provided" }
	}

	return { ok: true, value: { type: "local-diff", agents, baseCommit, headCommit } }
}

function tryGetCommentTriggerConfiguration(env: Record<string, string | undefined>): TryResult<CommentTriggerConfiguration> {
	const eventType = env.EVENT_TYPE
	if (eventType !== "issue_comment") return { ok: false, reason: "EVENT_TYPE is not 'issue_comment'" }

	const githubResult = tryParseGitHubConfig(env)
	if (!githubResult.ok) return githubResult

	const commentIdStr = env.COMMENT_ID
	if (!commentIdStr) return { ok: false, reason: "COMMENT_ID is required for comment trigger mode" }
	const commentId = Number.parseInt(commentIdStr, 10)
	if (Number.isNaN(commentId)) return { ok: false, reason: `COMMENT_ID must be a valid number, got: ${commentIdStr}` }

	const commentBody = env.COMMENT_BODY ?? ""

	return { ok: true, value: { type: "comment-trigger", github: githubResult.value, commentBody, commentId } }
}

function tryGetPullRequestConfiguration(env: Record<string, string | undefined>, agents: AgentNames): TryResult<PullRequestConfiguration> {
	const eventType = env.EVENT_TYPE
	if (eventType === "issue_comment") return { ok: false, reason: "EVENT_TYPE is 'issue_comment', which requires comment trigger mode" }
	if (eventType === "local") return { ok: false, reason: "EVENT_TYPE is 'local', which requires local diff mode" }
	if (eventType && !includes(EVENT_TYPES, eventType)) return { ok: false, reason: `EVENT_TYPE must be one of: ${EVENT_TYPES.join(", ")}. Got: ${eventType}` }

	const githubResult = tryParseGitHubConfig(env)
	if (!githubResult.ok) return githubResult

	return { ok: true, value: { type: "pull-request", agents, github: githubResult.value } }
}

export function getConfig(env: Record<string, string | undefined>): Configuration {
	const agents = parseAgents(env.AGENTS)

	const localResult = tryGetLocalDiffConfiguration(env, agents)
	if (localResult.ok) return localResult.value

	const commentResult = tryGetCommentTriggerConfiguration(env)
	if (commentResult.ok) return commentResult.value

	const pullRequestResult = tryGetPullRequestConfiguration(env, agents)
	if (pullRequestResult.ok) return pullRequestResult.value

	const reasons = [localResult, commentResult, pullRequestResult]
		.filter((r): r is { ok: false; reason: string } => !r.ok)
		.map(r => r.reason)
	throw new Error(`No valid configuration found:\n${reasons.map(r => `- ${r}`).join("\n")}`)
}
