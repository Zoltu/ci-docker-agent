import type { PrFile, GitHubReviewPayload, GitHubConfig } from "./github-types.mts"

function isPrFile(value: unknown): value is PrFile {
	if (typeof value !== "object") return false
	if (value === null) return false
	const obj = value
	if (!("filename" in obj) || typeof obj.filename !== "string") return false
	if (!("status" in obj) || typeof obj.status !== "string") return false
	if (!("additions" in obj) || typeof obj.additions !== "number") return false
	if (!("deletions" in obj) || typeof obj.deletions !== "number") return false
	if (!("changes" in obj) || typeof obj.changes !== "number") return false
	if (!("blob_url" in obj) || typeof obj.blob_url !== "string") return false
	if (!("raw_url" in obj) || typeof obj.raw_url !== "string") return false
	if (!("contents_url" in obj) || typeof obj.contents_url !== "string") return false
	if ("patch" in obj && typeof obj.patch !== "string") return false
	return true
}

function isPrFileArray(value: unknown): value is PrFile[] {
	if (!Array.isArray(value)) return false
	return value.every(isPrFile)
}

export async function fetchPrFiles(config: GitHubConfig): Promise<PrFile[]> {
	const { apiUrl, token, owner, repoName, prNumber } = config

	const response = await fetch(`${apiUrl}/repos/${owner}/${repoName}/pulls/${prNumber}/files`, {
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github.v3+json",
		},
	})

	if (!response.ok) {
		throw new Error(`Failed to fetch PR files: ${response.statusText}`)
	}

	const data: unknown = await response.json()
	if (!isPrFileArray(data)) {
		throw new Error("Invalid response from GitHub API: expected array of PR files")
	}

	return data
}

export async function submitReview(config: GitHubConfig, review: GitHubReviewPayload): Promise<void> {
	const { apiUrl, token, owner, repoName, prNumber } = config

	const response = await fetch(`${apiUrl}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`, {
		method: "POST",
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github.v3+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(review),
	})

	if (!response.ok) {
		throw new Error(`Failed to submit review: ${response.statusText}`)
	}
}
