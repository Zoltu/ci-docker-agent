import type { PrFile, GitHubReviewPayload, GitHubConfig } from "./github-types.mts"
import { FILE_STATUSES } from "./github-types.mts"
import { includes } from "./typescript-helpers.mts"

const REQUEST_TIMEOUT_MS = 10_000
const RETRY_DELAY_MS = 30_000
const DEADLINE_MS = 300_000

async function githubFetch(url: string, options: RequestInit): Promise<Response> {
	const deadline = Date.now() + DEADLINE_MS

	while (true) {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

		try {
			const response = await fetch(url, { ...options, signal: controller.signal })
			clearTimeout(timeoutId)
			return response
		} catch (error) {
			clearTimeout(timeoutId)

			if (!controller.signal.aborted) {
				throw error
			}

			if (Date.now() >= deadline) {
				throw new Error(`GitHub API request exceeded ${DEADLINE_MS / 1000}s deadline`)
			}

			console.log(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s, retrying in ${RETRY_DELAY_MS / 1000}s`)

			await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
		}
	}
}

export function isPrFile(value: unknown): value is PrFile {
	if (typeof value !== "object") return false
	if (value === null) return false
	const obj = value
	if (!("filename" in obj) || typeof obj.filename !== "string") return false
	if (!("status" in obj) || typeof obj.status !== "string" || !includes(FILE_STATUSES, obj.status)) return false
	if (!("additions" in obj) || typeof obj.additions !== "number") return false
	if (!("deletions" in obj) || typeof obj.deletions !== "number") return false
	if (!("changes" in obj) || typeof obj.changes !== "number") return false
	if ("patch" in obj && obj.patch !== undefined && typeof obj.patch !== "string") return false
	return true
}

export function isPrFileArray(value: unknown): value is PrFile[] {
	if (!Array.isArray(value)) return false
	return value.every(isPrFile)
}

export async function fetchPrFiles(config: GitHubConfig): Promise<PrFile[]> {
	const { apiUrl, token, owner, repoName, prNumber } = config
	const allFiles: PrFile[] = []
	let page = 1

	while (true) {
		const response = await githubFetch(`${apiUrl}/repos/${owner}/${repoName}/pulls/${prNumber}/files?per_page=100&page=${page}`, {
			method: "GET",
			headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" }
		})

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new Error(`Failed to fetch PR files: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
		}

		const data: unknown = await response.json()
		if (!isPrFileArray(data)) {
			throw new Error("Invalid response from GitHub API: expected array of PR files")
		}

		allFiles.push(...data)
		if (data.length < 100) break
		page++
	}

	return allFiles
}

export async function submitReview(config: GitHubConfig, review: GitHubReviewPayload): Promise<void> {
	const { apiUrl, token, owner, repoName, prNumber } = config

	const response = await githubFetch(`${apiUrl}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`, {
		method: "POST",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify(review),
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to submit review: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
	}
}

export async function reactToComment(config: GitHubConfig, commentId: number, content: string): Promise<void> {
	const { apiUrl, token, owner, repoName } = config

	const response = await githubFetch(`${apiUrl}/repos/${owner}/${repoName}/issues/comments/${commentId}/reactions`, {
		method: "POST",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify({ content }),
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to react to comment: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
	}
}
