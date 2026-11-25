import type { AgentNames } from "./agents.mts"
import type { GitHubReviewPayload, LineComment } from "./github-types.mts"

export type AiReviewResult = {
	body: string
	comments: LineComment[]
}

// The reviewers are named "All" rather than listed, so a full review says the same thing however many reviewers it had.
const ALL_REVIEWERS_NAME = "All" as const

// Both notices open with the same lead, so a reader can search the review body for which reviewers ran.
const REVIEWER_RUN_LEAD = "Reviewers: " as const

function formatReviewerNames(reviewerNames: readonly string[]): string {
	return reviewerNames.map(name => `\`${name}\``).join(", ")
}

function selectRanReviewerNames(agentNames: AgentNames, allReviewerNames: readonly string[]): readonly string[] {
	if (agentNames === "run all agents") return allReviewerNames
	return agentNames
}

// A selection that names every reviewer is the same set a run with no selector labels uses, so it is a full review however the run was asked for.
// The comparison is over names rather than sizes, because a selection of the right size can still name a reviewer the full set does not contain.
function isFullReviewerRun(ranReviewerNames: readonly string[], allReviewerNames: readonly string[]): boolean {
	if (ranReviewerNames.length !== allReviewerNames.length) return false
	const allReviewerNameSet = new Set(allReviewerNames)
	return ranReviewerNames.every(name => allReviewerNameSet.has(name))
}

// The full-review line is deliberately plain, because nearly every review is a full review and emphasis there would become wallpaper.
// The partial-review warning is deliberately loud, because a human auditor has to notice that reviewers were left out of the review they are reading.
function formatReviewerRunNotice(ranReviewerNames: readonly string[], allReviewerNames: readonly string[], isFullReview: boolean): string {
	const totalCount = allReviewerNames.length
	if (isFullReview) return `${REVIEWER_RUN_LEAD}${ALL_REVIEWERS_NAME} ran (${totalCount} of ${totalCount}).`
	return `> **${REVIEWER_RUN_LEAD}only ${ranReviewerNames.length} of ${totalCount} ran (${formatReviewerNames(ranReviewerNames)}). The remaining reviewers did not run, so this is not a full review.**`
}

export function buildReviewPayload(aiResult: AiReviewResult, agentNames: AgentNames, allReviewerNames: readonly string[]): GitHubReviewPayload {
	const ranReviewerNames = selectRanReviewerNames(agentNames, allReviewerNames)
	const isFullReview = isFullReviewerRun(ranReviewerNames, allReviewerNames)
	const reviewerRunNotice = formatReviewerRunNotice(ranReviewerNames, allReviewerNames, isFullReview)
	const bodyLines = ["## CI Agent Review", "", reviewerRunNotice, "", aiResult.body]

	// A long review scrolls the first line out of view, so a partial review states it again as the last line.
	if (!isFullReview) bodyLines.push("", reviewerRunNotice)

	return { event: "COMMENT", body: bodyLines.join("\n"), comments: aiResult.comments }
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
