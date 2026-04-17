import type { PrFile, GitHubReviewPayload } from "./github-types.mts"

export type AiReviewResult = Omit<GitHubReviewPayload, "event">

export function buildReviewPayload(aiResult: AiReviewResult): GitHubReviewPayload {
	return {
		event: "COMMENT",
		body: `## CI Agent Review\n\n${aiResult.body}`,
		comments: aiResult.comments,
	}
}

export function formatReviewForConsole(aiResult: AiReviewResult, files: PrFile[]): string {
	const lines = [
		"## CI Agent Review",
		"",
		aiResult.body,
	]

	if (aiResult.comments.length > 0) {
		lines.push("", "### Line Comments")
		aiResult.comments.forEach(comment => {
			lines.push(`- ${comment.path}:${comment.line} (${comment.side}): ${comment.body}`)
		})
	}

	lines.push("", "### Files Analyzed")
	files.forEach(file => {
		lines.push(
			`- ${file.filename} (${file.status}): +${file.additions} -${file.deletions}`
		)
	})

	return lines.join("\n")
}
