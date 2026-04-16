import type { GitHubConfig } from "./github-types.mts"

export type ExecutionMode = "github" | "local-diff"

export interface EnvironmentConfig {
	mode: ExecutionMode
	eventType: string
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
	const eventType = env.EVENT_TYPE ?? "unknown"
	const commentBody = env.COMMENT_BODY ?? null

	const baseCommit = env.BASE_COMMIT
	const headCommit = env.HEAD_COMMIT

	const agentsEnv = env.AGENTS
	const agents = agentsEnv ? agentsEnv.split(",").map(a => a.trim()).filter(a => a.length > 0) : []

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

		const [owner, repoName] = repo.split("/")
		if (!owner || !repoName) {
			throw new Error(`REPO must be in format 'owner/repo', got: ${repo}`)
		}

		return {
			mode: "github",
			eventType,
			commentBody,
			github: {
				token: githubToken,
				apiUrl: githubApiUrl,
				repo,
				prNumber,
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
