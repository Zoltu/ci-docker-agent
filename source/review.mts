import type { ReviewerCoverage } from "./agents.mts"
import type { GitHubReviewPayload, LineComment } from "./github-types.mts"
import { sanitizeForSingleLine } from "./typescript-helpers.mts"

export type AiReviewResult = {
	body: string
	comments: LineComment[]
}

// The reviewers are named "All" rather than listed, so a full review names no individual reviewer; the count beside the name still changes with the run.
const ALL_REVIEWERS_NAME = "All" as const

// The lead is a stable anchor for the full-review line in a submitted review; the partial warning opens with its own lead instead and never carries this one.
const REVIEWER_RUN_LEAD = "Reviewers: " as const

// A reviewer name arrives from a prompt file name on the base branch, so it is untrusted here: a newline or a bidi override would deform the notice, and a backtick would close the code span and render the rest of the name as markup, which no backslash escape can prevent inside a code span.
const INLINE_CODE_BACKTICK_PATTERN = /`/g

function formatReviewerNames(reviewerNames: readonly string[]): string {
	return reviewerNames.map(name => `\`${sanitizeForSingleLine(name).replace(INLINE_CODE_BACKTICK_PATTERN, "\\u0060")}\``).join(", ")
}

// The full-review line agrees with its count, so a single reviewer reads "All 1 reviewer ran." rather than "All 1 reviewers ran.".
function formatReviewerCount(reviewerCount: number): string {
	return `${reviewerCount} ${reviewerCount === 1 ? "reviewer" : "reviewers"}`
}

// `resolveAgents` rejects two spellings of one reviewer, so that list's length is the number of reviewers that ran.
// A selection that names no reviewer leaves no name to list, so the warning drops the colon and the list rather than rendering a dangling one.
// Only `loadReviewerRun` guarantees that the claim describes exactly the agents that ran; this function takes the value as plain data and cannot check it.
function formatReviewerRunNotice(coverage: ReviewerCoverage): string {
	if (coverage.kind === "full") return `${REVIEWER_RUN_LEAD}${ALL_REVIEWERS_NAME} ${formatReviewerCount(coverage.reviewerCount)} ran.`
	// A partial notice always has a denominator above its numerator, so the denominator is plural even when it is one.
	const countedReviewers = `${coverage.ranReviewerNames.length} of ${coverage.possibleReviewerCount} reviewers ran`
	if (coverage.ranReviewerNames.length === 0) return `⚠️ **PARTIAL REVIEW — ${countedReviewers}. This is not a full review.**`
	return `⚠️ **PARTIAL REVIEW — ${countedReviewers}: ${formatReviewerNames(coverage.ranReviewerNames)}. This is not a full review.**`
}

export function buildReviewPayload(aiResult: AiReviewResult, coverage: ReviewerCoverage): GitHubReviewPayload {
	// The coverage claim is derived from the resolved agents, not from the per-reviewer results, and it holds only because `runAgents` awaits `Promise.all` over them, so one reviewer's failure aborts the run before a review is submitted.
	// Per-reviewer fault tolerance would make this notice report a reviewer as having run that never returned a result.
	const reviewerRunNotice = formatReviewerRunNotice(coverage)
	const bodyLines = ["## CI Agent Review", "", reviewerRunNotice, "", aiResult.body]

	// A long review scrolls the first line out of view, so a partial review states the same warning again as the last line; AI-written body content can hide or deform that repeat, and hardening against it was judged not worth the cost relative to the risk, because the first warning cannot be affected by body content.
	if (coverage.kind === "partial") bodyLines.push("", reviewerRunNotice)

	return { event: "COMMENT", body: bodyLines.join("\n"), comments: aiResult.comments }
}

export function formatReviewForConsole(aiResult: AiReviewResult): string {
	const lines = ["## CI Agent Review", "", aiResult.body]

	if (aiResult.comments.length > 0) {
		lines.push("", "### Line Comments")
		for (const comment of aiResult.comments) {
			lines.push(`- ${comment.path}:${comment.line} (${comment.side}): ${comment.body}`)
		}
	}

	return lines.join("\n")
}
