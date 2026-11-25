import type { ReviewerCoverage } from "./agents.mts"
import type { GitHubReviewPayload, LineComment } from "./github-types.mts"
import { sanitizeForSingleLine } from "./typescript-helpers.mts"

export type AiReviewResult = {
	body: string
	comments: LineComment[]
}

// The reviewers are named "All" rather than listed, so a full review says the same thing however many reviewers it had.
const ALL_REVIEWERS_NAME = "All" as const

// Both notices open with the same lead, so a reader can search the review body for which reviewers ran.
const REVIEWER_RUN_LEAD = "Reviewers: " as const

// A reviewer name arrives from a prompt file name on the base branch, so it is untrusted here: a newline or a bidi override would deform the notice, and a backtick would close the code span and render the rest of the name as markup.
// A backslash escape inside a code span renders literally and still ends it, so a backtick becomes the `\u0060` escape sanitizeForSingleLine uses for its own hazards.
const INLINE_CODE_BACKTICK_PATTERN = /`/g

function formatReviewerNames(reviewerNames: readonly string[]): string {
	return reviewerNames.map(name => `\`${sanitizeForSingleLine(name).replace(INLINE_CODE_BACKTICK_PATTERN, "\\u0060")}\``).join(", ")
}

// The full-review line is deliberately plain, because nearly every review is a full review and emphasis there would become wallpaper.
// The partial-review warning is deliberately loud, because a human auditor has to notice that reviewers were left out of the review they are reading.
// The notice is derived from the coverage value alone, so no caller can pair a warning with a covered reference set or a plain line with a narrowed one.
function formatReviewerRunNotice(coverage: ReviewerCoverage): string {
	if (coverage.kind === "full") return `${REVIEWER_RUN_LEAD}${ALL_REVIEWERS_NAME} ran (${coverage.reviewerCount} of ${coverage.reviewerCount}).`
	return `> **${REVIEWER_RUN_LEAD}only ${coverage.ranReferenceReviewerCount} of ${coverage.referenceReviewerCount} ran (${formatReviewerNames(coverage.ranReviewerNames)}). The remaining reviewers did not run, so this is not a full review.**`
}

// The review body is model output about the pull request diff, so a pull request author can steer it, and an HTML comment it leaves open turns the repeated warning into comment text and hides it.
// Counting openers against closers cannot settle that, because a closer inside a fenced code block renders as nothing while an opener after it still takes effect, so every opener outside a fenced block is rewritten and cannot start a comment.
// The rewritten opener is an entity reference, which renders as the same text a reader of prose would have seen; a fenced block renders its content literally and cannot open a comment, so its text stays byte-exact.
// The hardening is deliberately cheap and bounded. The text above the body is the primary signal and no body content can reach it, while the repeat at the end is defence in depth and best effort.
// So the design does not attempt to defeat every construct a body could leave open: a raw HTML block such as an unclosed `<details>` element, or a fence line the body placed inside one, can still swallow the repeat.
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

// A closing fence must carry the opening marker character and run at least as long as the opening fence, so the generated closer repeats that marker to that length.
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
	// The full-review claim describes the reviewers the run asked for, not what came back, and it is true only because `runAgents` awaits `Promise.all` over them, so one reviewer's failure aborts the run before a review is submitted.
	// Per-reviewer fault tolerance would make this notice report a reviewer as having run that never returned a result.
	const reviewerRunNotice = formatReviewerRunNotice(coverage)
	const neutralizedBody = neutralizeReviewBody(aiResult.body)
	const bodyLines = ["## CI Agent Review", "", reviewerRunNotice, "", neutralizedBody.text]

	// A long review scrolls the first line out of view, so a partial review states it again as the last line.
	// A fence the body left open renders that repeat as literal code, so it is closed first, adding a line and leaving the fenced content byte-exact.
	if (coverage.kind === "partial") {
		if (neutralizedBody.openFence !== null) bodyLines.push(formatFenceCloser(neutralizedBody.openFence))
		bodyLines.push("", reviewerRunNotice)
	}

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