import type { PRFile, GitHubReviewPayload, GitHubConfig } from "./github-types.mts"

export async function fetchPRFiles(config: GitHubConfig): Promise<PRFile[]> {
	const { apiUrl, token, repo, prNumber } = config
	const [owner, repoName] = repo.split("/")

	const response = await fetch(`${apiUrl}/repos/${owner}/${repoName}/pulls/${prNumber}/files`, {
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github.v3+json",
		},
	})

	if (!response.ok) {
		throw new Error(`Failed to fetch PR files: ${response.statusText}`)
	}

	return response.json()
}

export async function submitReview(config: GitHubConfig, review: GitHubReviewPayload): Promise<void> {
	const { apiUrl, token, repo, prNumber } = config
	const [owner, repoName] = repo.split("/")

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
