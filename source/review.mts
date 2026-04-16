import type { PrFile, GitHubReviewPayload } from "./github-types.mts"

export interface AiReviewResult {
	summary: string
	lineComments: Array<{
		path: string
		line: number
		side: "LEFT" | "RIGHT"
		comment: string
	}>
}

export function buildReviewPayload(aiResult: AiReviewResult): GitHubReviewPayload {
	return {
		event: "COMMENT",
		body: `## CI Agent Review\n\n${aiResult.summary}`,
		comments: aiResult.lineComments.map(comment => ({
			path: comment.path,
			line: comment.line,
			side: comment.side,
			body: comment.comment,
		})),
	}
}

export function formatReviewForConsole(aiResult: AiReviewResult, files: PrFile[]): string {
	const lines = [
		"## CI Agent Review",
		"",
		aiResult.summary,
	]

	if (aiResult.lineComments.length > 0) {
		lines.push("", "### Line Comments")
		aiResult.lineComments.forEach(comment => {
			lines.push(`- ${comment.path}:${comment.line} (${comment.side}): ${comment.comment}`)
		})
	}

	// Include file summary
	lines.push("", "### Files Analyzed")
	files.forEach(file => {
		lines.push(
			`- ${file.filename} (${file.status}): +${file.additions} -${file.deletions}`
		)
	})

	return lines.join("\n")
}
