import type { GitHubConfig } from "./github-types.mts"
import { includes } from "./typescript-helpers.mts"

export type ExecutionMode = "github" | "local-diff"

const EVENT_TYPES = ["pull_request_target", "workflow_dispatch", "issue_comment", "local"] as const

export type EventType = typeof EVENT_TYPES[number]

function parseEventType(value: string | undefined): EventType {
	if (!value) return "local"
	if (includes(EVENT_TYPES, value)) return value
	throw new Error(`EVENT_TYPE must be one of: ${EVENT_TYPES.join(", ")}. Got: ${value}`)
}

export interface EnvironmentConfig {
	mode: ExecutionMode
	eventType: EventType
	commentBody: string | null
	github?: GitHubConfig
	localDiff?: {
		baseCommit: string
		headCommit: string
	}
	agents: string[]
}

export function parseEnvironment(env: Record<string, string | undefined> = Bun.env): EnvironmentConfig {
	const githubToken = env.GITHUB_TOKEN
	const githubApiUrl = env.GITHUB_API_URL ?? "https://api.github.com"
	const prNumberStr = env.PR_NUMBER
	const repo = env.REPO
	const eventType = parseEventType(env.EVENT_TYPE)
	const commentBody = env.COMMENT_BODY ?? null

	const baseCommit = env.BASE_COMMIT
	const headCommit = env.HEAD_COMMIT

	const agentsEnv = env.AGENTS
	const agents = agentsEnv ? agentsEnv.split(",").map(a => a.trim()).filter(a => a.length > 0) : []

	if (agents.length > 0 && commentBody && /^\/review\s+\S/m.test(commentBody)) {
		throw new Error("Cannot specify agents via both AGENTS environment variable and /review trigger command")
	}

	if (baseCommit && !headCommit) {
		throw new Error("HEAD_COMMIT is required when BASE_COMMIT is provided")
	}
	if (!baseCommit && headCommit) {
		throw new Error("BASE_COMMIT is required when HEAD_COMMIT is provided")
	}

	const hasGithubVars = githubToken || prNumberStr || repo
	if (hasGithubVars && (!githubToken || !prNumberStr || !repo)) {
		const missing = []
		if (!githubToken) missing.push("GITHUB_TOKEN")
		if (!prNumberStr) missing.push("PR_NUMBER")
		if (!repo) missing.push("REPO")
		throw new Error(`GitHub mode requires ${missing.join(" and ")}`)
	}

	if (baseCommit && headCommit) {
		return {
			mode: "local-diff",
			eventType,
			commentBody,
			localDiff: {
				baseCommit,
				headCommit,
			},
			agents,
		}
	}

	if (githubToken && prNumberStr && repo) {
		const prNumber = Number.parseInt(prNumberStr, 10)
		if (Number.isNaN(prNumber)) {
			throw new Error(`PR_NUMBER must be a valid number, got: ${prNumberStr}`)
		}

		const parts = repo.split("/")
		if (parts.length !== 2) {
			throw new Error(`REPO must be in format 'owner/repo', got: ${repo}`)
		}
		const owner = parts[0]
		const repoName = parts[1]
		if (!owner || !repoName) {
			throw new Error(`REPO must be in format 'owner/repo', got: ${repo}`)
		}

		const commentIdStr = env.COMMENT_ID
		const commentId = commentIdStr ? Number.parseInt(commentIdStr, 10) : undefined
		if (commentId !== undefined && Number.isNaN(commentId)) {
			throw new Error(`COMMENT_ID must be a valid number, got: ${commentIdStr}`)
		}

		return {
			mode: "github",
			eventType,
			commentBody,
			github: {
				token: githubToken,
				apiUrl: githubApiUrl,
				repo,
				owner,
				repoName,
				prNumber,
				commentId,
			},
			agents,
		}
	}

	throw new Error(
		"Invalid configuration. Provide either:\n" +
		"  - GITHUB_TOKEN, PR_NUMBER, and REPO for GitHub PR mode\n" +
		"  - BASE_COMMIT and HEAD_COMMIT for local diff mode"
	)
}
