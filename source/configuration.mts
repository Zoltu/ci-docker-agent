import type { GitHubConfig } from "./github-types.mts"
import { includes } from "./typescript-helpers.mts"

const EVENT_TYPES = ["pull_request_target", "workflow_dispatch", "issue_comment", "local"] as const

export type EventType = typeof EVENT_TYPES[number]

export interface CommentTriggerConfiguration {
	type: "comment-trigger"
	agents: string[]
	github: GitHubConfig
	commentBody: string
	commentId: number
}

export interface PullRequestConfiguration {
	type: "pull-request"
	agents: string[]
	github: GitHubConfig
}

export interface LocalDiffConfiguration {
	type: "local-diff"
	agents: string[]
	baseCommit: string
	headCommit: string
}

export type Configuration = CommentTriggerConfiguration | PullRequestConfiguration | LocalDiffConfiguration

function parseEventType(value: string | undefined): EventType {
	if (!value) return "local"
	if (includes(EVENT_TYPES, value)) return value
	throw new Error(`EVENT_TYPE must be one of: ${EVENT_TYPES.join(", ")}. Got: ${value}`)
}

function parseAgents(value: string | undefined): string[] {
	if (!value) return []
	return value.split(",").map(a => a.trim()).filter(a => a.length > 0)
}

function parseGitHubConfig(env: Record<string, string | undefined>): GitHubConfig {
	const token = env.GITHUB_TOKEN
	const prNumberStr = env.PR_NUMBER
	const repo = env.REPO

	if (!token && !prNumberStr && !repo) {
		throw new Error(
			"Invalid configuration. Provide either:\n" +
			"  - GITHUB_TOKEN, PR_NUMBER, and REPO for GitHub PR mode\n" +
			"  - BASE_COMMIT and HEAD_COMMIT for local diff mode"
		)
	}

	if (!token || !prNumberStr || !repo) {
		const missing = []
		if (!token) missing.push("GITHUB_TOKEN")
		if (!prNumberStr) missing.push("PR_NUMBER")
		if (!repo) missing.push("REPO")
		throw new Error(`GitHub mode requires ${missing.join(" and ")}`)
	}

	const prNumber = Number.parseInt(prNumberStr, 10)
	if (Number.isNaN(prNumber)) throw new Error(`PR_NUMBER must be a valid number, got: ${prNumberStr}`)

	const parts = repo.split("/")
	if (parts.length !== 2) throw new Error(`REPO must be in format 'owner/repo', got: ${repo}`)
	const owner = parts[0]
	const repoName = parts[1]
	if (!owner || !repoName) throw new Error(`REPO must be in format 'owner/repo', got: ${repo}`)

	const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com"

	return { token, apiUrl, repo, owner, repoName, prNumber }
}

function validateNoAgentConflict(agents: string[], commentBody: string): void {
	if (agents.length > 0 && commentBody && /^\/review\s+\S/m.test(commentBody)) throw new Error("Cannot specify agents via both AGENTS environment variable and /review trigger command")
}

export function getConfig(env: Record<string, string | undefined>): Configuration {
	const eventType = parseEventType(env.EVENT_TYPE)
	const agents = parseAgents(env.AGENTS)

	const baseCommit = env.BASE_COMMIT
	const headCommit = env.HEAD_COMMIT

	if (baseCommit && headCommit) {
		return { type: "local-diff", agents, baseCommit, headCommit }
	}

	if (baseCommit && !headCommit) throw new Error("HEAD_COMMIT is required when BASE_COMMIT is provided")
	if (!baseCommit && headCommit) throw new Error("BASE_COMMIT is required when HEAD_COMMIT is provided")

	const github = parseGitHubConfig(env)

	if (eventType === "issue_comment") {
		const commentBody = env.COMMENT_BODY ?? ""
		const commentIdStr = env.COMMENT_ID
		if (!commentIdStr) throw new Error("COMMENT_ID is required for comment trigger mode")
		const commentId = Number.parseInt(commentIdStr, 10)
		if (Number.isNaN(commentId)) throw new Error(`COMMENT_ID must be a valid number, got: ${commentIdStr}`)
		validateNoAgentConflict(agents, commentBody)
		return { type: "comment-trigger", agents, github, commentBody, commentId }
	}

	return { type: "pull-request", agents, github }
}
