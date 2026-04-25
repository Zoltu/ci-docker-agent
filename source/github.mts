import type { PullRequestFile, GitHubReviewPayload, GitHubConfiguration } from "./github-types.mts"
import { FILE_STATUSES } from "./github-types.mts"
import { includes } from "./typescript-helpers.mts"

const REQUEST_TIMEOUT_MILLISECONDS = 10_000
const RETRY_DELAY_MILLISECONDS = 30_000
const DEADLINE_MILLISECONDS = 300_000

export type GitHubFetch = (url: string, options: RequestInit) => Promise<Response>

export function createGithubFetch(): GitHubFetch {
	return async function githubFetch(url: string, options: RequestInit): Promise<Response> {
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

export function isPullRequestFile(value: unknown): value is PullRequestFile {
	if (typeof value !== "object") return false
	if (value === null) return false
	const object = value
	if (!("filename" in object) || typeof object.filename !== "string") return false
	if (!("status" in object) || typeof object.status !== "string" || !includes(FILE_STATUSES, object.status)) return false
	if (!("additions" in object) || typeof object.additions !== "number") return false
	if (!("deletions" in object) || typeof object.deletions !== "number") return false
	if (!("changes" in object) || typeof object.changes !== "number") return false
	if ("patch" in object && object.patch !== undefined && typeof object.patch !== "string") return false
	return true
}

export function isPullRequestFileArray(value: unknown): value is PullRequestFile[] {
	if (!Array.isArray(value)) return false
	return value.every(isPullRequestFile)
}

export function createFetchPullRequestFiles(githubFetch: GitHubFetch, configuration: GitHubConfiguration): () => Promise<PullRequestFile[]> {
	return async function fetchPullRequestFiles(): Promise<PullRequestFile[]> {
		const { apiUrl, token, owner, repositoryName, pullRequestNumber } = configuration
		const allFiles: PullRequestFile[] = []
		let page = 1

		while (true) {
			const response = await githubFetch(`${apiUrl}/repos/${owner}/${repositoryName}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, {
				method: "GET",
				headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" }
			})

			if (!response.ok) {
				const body = await response.text().catch(() => "")
				throw new Error(`Failed to fetch PR files: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
			}

			const data: unknown = await response.json()
			if (!isPullRequestFileArray(data)) throw new Error("Invalid response from GitHub API: expected array of PR files")

			allFiles.push(...data)
			if (data.length < 100) break
			page++
		}

		return allFiles
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
