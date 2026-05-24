import type { GitHubReviewPayload, LineComment } from "./github-types.mts"

export type AiReviewResult = {
	body: string
	comments: LineComment[]
}

export function buildReviewPayload(aiResult: AiReviewResult): GitHubReviewPayload {
	return { event: "COMMENT", body: `## CI Agent Review\n\n${aiResult.body}`, comments: aiResult.comments }
}

export function formatReviewForConsole(aiResult: AiReviewResult): string {
	const lines = [ "## CI Agent Review", "", aiResult.body ]

	if (aiResult.comments.length > 0) {
		lines.push("", "### Line Comments")
		for (const comment of aiResult.comments) {
			lines.push(`- ${comment.path}:${comment.line} (${comment.side}): ${comment.body}`)
		}
	}

	return lines.join("\n")
}
