import type { GitHubReviewPayload, GitHubConfiguration } from "./github-types.mts"
import { parseDiffOutput, type DiffResult } from "./diff.mts"

const REQUEST_TIMEOUT_MILLISECONDS = 10_000
const RETRY_DELAY_MILLISECONDS = 30_000
const DEADLINE_MILLISECONDS = 300_000

export type GitHubFetch = (url: string, options: RequestInit) => Promise<Response>

export function createGithubFetch(): GitHubFetch {
	return async function githubFetch(url: string, options: RequestInit): Promise<Response> {
		// Intentionally only retries rate limiting (429); all other errors fail fast
		const deadline = Date.now() + DEADLINE_MILLISECONDS

		while (true) {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MILLISECONDS)

			try {
				const response = await fetch(url, { ...options, signal: controller.signal })
				clearTimeout(timeoutId)

				if (response.status === 429) {
					if (Date.now() >= deadline) {
						throw new Error(`GitHub API request exceeded ${DEADLINE_MILLISECONDS / 1000}s deadline`)
					}

					const retryAfter = response.headers.get("Retry-After")
					const delay = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RETRY_DELAY_MILLISECONDS
					console.log(`Rate limited (429), retrying in ${delay / 1000}s`)
					await new Promise(resolve => setTimeout(resolve, delay))
					continue
				}

				return response
			} catch (error) {
				clearTimeout(timeoutId)

				if (!controller.signal.aborted) {
					throw error
				}

				if (Date.now() >= deadline) {
					throw new Error(`GitHub API request exceeded ${DEADLINE_MILLISECONDS / 1000}s deadline`)
				}

				console.log(`Request timed out after ${REQUEST_TIMEOUT_MILLISECONDS / 1000}s, retrying in ${RETRY_DELAY_MILLISECONDS / 1000}s`)

				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MILLISECONDS))
			}
		}
	}
}

export function createFetchPullRequestDiff(githubFetch: GitHubFetch, configuration: GitHubConfiguration): () => Promise<DiffResult> {
	return async function fetchPullRequestDiff(): Promise<DiffResult> {
		const { apiUrl, token, owner, repositoryName, pullRequestNumber } = configuration

		const response = await githubFetch(`${apiUrl}/repos/${owner}/${repositoryName}/pulls/${pullRequestNumber}`, {
			method: "GET",
			headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.diff" },
		})

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
		}

		const diffText = await response.text()
		return parseDiffOutput(diffText)
	}
}

export function createSubmitReview(githubFetch: GitHubFetch, configuration: GitHubConfiguration): (review: GitHubReviewPayload) => Promise<void> {
	return async function submitReview(review: GitHubReviewPayload): Promise<void> {
		const { apiUrl, token, owner, repositoryName, pullRequestNumber } = configuration

		const response = await githubFetch(`${apiUrl}/repos/${owner}/${repositoryName}/pulls/${pullRequestNumber}/reviews`, {
			method: "POST",
			headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
			body: JSON.stringify(review),
		})

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new Error(`Failed to submit review: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
		}
	}
}

export function createReactToComment(githubFetch: GitHubFetch, configuration: GitHubConfiguration): (commentId: number, content: string) => Promise<void> {
	return async function reactToComment(commentId: number, content: string): Promise<void> {
		const { apiUrl, token, owner, repositoryName } = configuration

		const response = await githubFetch(`${apiUrl}/repos/${owner}/${repositoryName}/issues/comments/${commentId}/reactions`, {
			method: "POST",
			headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		})

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new Error(`Failed to react to comment: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
		}
	}
}

function isValidPrBaseResponse(data: unknown): data is { base: { sha: string } } {
	if (typeof data !== "object") return false
	if (data === null) return false
	if (!("base" in data) || typeof data.base !== "object" || data.base === null) return false
	if (!("sha" in data.base) || typeof data.base.sha !== "string") return false
	return true
}

export function createFetchPullRequestBaseCommit(githubFetch: GitHubFetch, configuration: GitHubConfiguration): () => Promise<string> {
	return async function fetchPullRequestBaseCommit(): Promise<string> {
		const { apiUrl, token, owner, repositoryName, pullRequestNumber } = configuration

		const response = await githubFetch(`${apiUrl}/repos/${owner}/${repositoryName}/pulls/${pullRequestNumber}`, {
			method: "GET",
			headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
		})

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new Error(`Failed to fetch PR base commit: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
		}

		const data: unknown = await response.json()
		if (!isValidPrBaseResponse(data)) throw new Error("Invalid PR response: missing base.sha")

		return data.base.sha
	}
}
