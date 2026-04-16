import type { GitHubConfig, LocalDiffConfig } from "./github-types.mts"

export type ExecutionMode = "github" | "local-diff"

export interface EnvironmentConfig {
	mode: ExecutionMode
	eventType: string
	commentBody: string | null
	github?: GitHubConfig
	localDiff?: LocalDiffConfig
}

export function parseEnvironment(): EnvironmentConfig {
	const githubToken = Bun.env.GITHUB_TOKEN
	const githubApiUrl = Bun.env.GITHUB_API_URL ?? "https://api.github.com"
	const prNumberStr = Bun.env.PR_NUMBER
	const repo = Bun.env.REPO
	const eventType = Bun.env.EVENT_TYPE ?? "unknown"
	const commentBody = Bun.env.COMMENT_BODY ?? null

	const baseCommit = Bun.env.BASE_COMMIT
	const headCommit = Bun.env.HEAD_COMMIT

	// Check for local diff mode (two commit hashes provided)
	if (baseCommit && headCommit) {
		return {
			mode: "local-diff",
			eventType,
			commentBody,
			localDiff: {
				baseCommit,
				headCommit,
			},
		}
	}

	// Check for GitHub PR mode (PR link and token provided)
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
		}
	}

	// No valid configuration provided
	throw new Error(
		"Invalid configuration. Provide either:\n" +
		"  - GITHUB_TOKEN, PR_NUMBER, and REPO for GitHub PR mode\n" +
		"  - BASE_COMMIT and HEAD_COMMIT for local diff mode"
	)
}
