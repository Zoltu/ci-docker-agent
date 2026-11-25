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

// The review body is model output about the pull request diff, so a pull request author can steer it, and an HTML comment it leaves open turns the repeated warning into comment text and hides it.
// Counting openers against closers cannot settle that, because a closer inside a fenced code block renders as nothing while an opener after it still takes effect, so every opener outside a fenced block is rewritten and cannot start a comment.
// The rewritten opener is an entity reference, which renders as the same text a reader of prose would have seen, while a fenced block renders its content literally and cannot open a comment, so its text stays byte-exact.
const HTML_COMMENT_OPENER = "<!--" as const
const NEUTRAL_HTML_COMMENT_OPENER = "&lt;!--" as const

const FENCE_OPENER_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSER_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

type Fence = {
	readonly character: string
	readonly length: number
}

type NeutralizedBody = {
	readonly text: string
	readonly openFence: Fence | null
}

function parseFenceOpener(line: string): Fence | null {
	const match = FENCE_OPENER_PATTERN.exec(line)
	if (match === null) return null
	const fenceRun = match[1]
	const infoString = match[2]
	if (fenceRun === undefined || infoString === undefined) return null
	// A backtick fence carries no backtick in its info string, so a line of inline code at the start of a line is prose rather than a fence.
	if (fenceRun.charAt(0) === "`" && infoString.includes("`")) return null
	return { character: fenceRun.charAt(0), length: fenceRun.length }
}

function isFenceCloser(line: string, fence: Fence): boolean {
	const match = FENCE_CLOSER_PATTERN.exec(line)
	if (match === null) return false
	const fenceRun = match[1]
	if (fenceRun === undefined) return false
	return fenceRun.charAt(0) === fence.character && fenceRun.length >= fence.length
}

function formatFenceCloser(fence: Fence): string {
	return fence.character.repeat(fence.length)
}

// A model can end every line with a carriage return while GitHub normalises them away, so fence matching ignores one and the body keeps its own bytes.
function withoutCarriageReturn(line: string): string {
	if (line.endsWith("\r")) return line.slice(0, -1)
	return line
}

// A line inside a fenced block renders literally, so it leaves byte-exact whether or not it holds an opener.
// Every other line has each opener rewritten in one pass, so no code-span tracking stands between an opener and its neutralised form.
function neutralizeReviewBody(body: string): NeutralizedBody {
	const neutralizedLines: string[] = []
	let openFence: Fence | null = null
	for (const line of body.split("\n")) {
		const fenceLine = withoutCarriageReturn(line)

		if (openFence !== null) {
			neutralizedLines.push(line)
			if (isFenceCloser(fenceLine, openFence)) openFence = null
			continue
		}

		const fence = parseFenceOpener(fenceLine)
		if (fence !== null) {
			neutralizedLines.push(line)
			openFence = fence
			continue
		}

		neutralizedLines.push(line.split(HTML_COMMENT_OPENER).join(NEUTRAL_HTML_COMMENT_OPENER))
	}
	return { text: neutralizedLines.join("\n"), openFence }
}

export function buildReviewPayload(aiResult: AiReviewResult, coverage: ReviewerCoverage): GitHubReviewPayload {
	// The coverage claim is derived from the resolved agents, not from the per-reviewer results, and it holds only because `runAgents` awaits `Promise.all` over them, so one reviewer's failure aborts the run before a review is submitted.
	// Per-reviewer fault tolerance would make this notice report a reviewer as having run that never returned a result.
	const reviewerRunNotice = formatReviewerRunNotice(coverage)
	const neutralizedBody = neutralizeReviewBody(aiResult.body)
	const bodyLines = ["## CI Agent Review", "", reviewerRunNotice, "", neutralizedBody.text]

	// A long review scrolls the first line out of view, so a partial review states the same warning again as the last line.
	// A fence the body left open renders that repeat as literal code, so it is closed first, adding a line and leaving the fenced content byte-exact.
	if (coverage.kind === "partial") {
		if (neutralizedBody.openFence !== null) bodyLines.push(formatFenceCloser(neutralizedBody.openFence))
		bodyLines.push("", reviewerRunNotice)
	}

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
