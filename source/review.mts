import type { PullRequestFile, GitHubReviewPayload } from "./github-types.mts"

export type AiReviewResult = Omit<GitHubReviewPayload, "event">

export function buildReviewPayload(aiResult: AiReviewResult): GitHubReviewPayload {
	return {
		event: "COMMENT",
		body: `## CI Agent Review\n\n${aiResult.body}`,
		comments: aiResult.comments,
	}
}

export function formatReviewForConsole(aiResult: AiReviewResult, files: PullRequestFile[]): string {
	const lines = [
		"## CI Agent Review",
		"",
		aiResult.body,
	]

	if (aiResult.comments.length > 0) {
		lines.push("", "### Line Comments")
		for (const comment of aiResult.comments) {
			lines.push(`- ${comment.path}:${comment.line} (${comment.side}): ${comment.body}`)
		}
	}

	lines.push("", "### Files Analyzed")
	for (const file of files) {
		lines.push(`- ${file.filename} (${file.status}): +${file.additions} -${file.deletions}`)
	}

	return lines.join("\n")
}
