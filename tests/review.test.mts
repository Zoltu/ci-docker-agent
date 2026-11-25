import { describe, it, expect } from "bun:test"
import { buildReviewPayload, formatReviewForConsole, type AiReviewResult } from "../source/review.mts"
import type { ReviewerCoverage } from "../source/agents.mts"

const REVIEW_HEADING = "## CI Agent Review"

function fullCoverage(reviewerCount: number): ReviewerCoverage {
	return { kind: "full", reviewerCount }
}

function partialCoverage(ranReviewerNames: readonly string[], possibleReviewerCount: number): ReviewerCoverage {
	return { kind: "partial", ranReviewerNames, possibleReviewerCount }
}

// The notice's contract is its position below the review heading, not a line index, so a body that changes how many lines it takes cannot fail a test without the notice having moved.
function firstContentLineAfterHeading(body: string): string {
	const lines = body.split("\n")
	const headingIndex = lines.indexOf(REVIEW_HEADING)
	if (headingIndex === -1) throw new Error(`body has no review heading: ${body}`)
	const contentLine = lines.slice(headingIndex + 1).find(line => line !== "")
	if (contentLine === undefined) throw new Error(`body has no content line after its review heading: ${body}`)
	return contentLine
}

describe("buildReviewPayload", () => {
	it("creates a review payload with COMMENT event", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const payload = buildReviewPayload(aiResult, fullCoverage(1))

		expect(payload.event).toBe("COMMENT")
		expect(payload.body).toContain("CI Agent Review")
		expect(payload.body).toContain("Test summary")
		expect(payload.comments).toEqual([])
	})

	it("includes line comments in the payload", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [
				{
					path: "src/file.ts",
					line: 42,
					side: "RIGHT",
					body: "This is a comment",
				},
				{
					path: "src/other.ts",
					line: 10,
					side: "LEFT",
					body: "Another comment",
				},
			],
		}

		const payload = buildReviewPayload(aiResult, fullCoverage(1))

		expect(payload.comments).toHaveLength(2)
		expect(payload.comments[0]).toEqual({
			path: "src/file.ts",
			line: 42,
			side: "RIGHT",
			body: "This is a comment",
		})
		expect(payload.comments[1]).toEqual({
			path: "src/other.ts",
			line: 10,
			side: "LEFT",
			body: "Another comment",
		})
	})
})

describe("reviewer notice", () => {
	const aiResult: AiReviewResult = {
		body: "Test summary",
		comments: [],
	}
	// The presentation is asserted literally, because the plain full-review line and the loud partial-review warning are the reviewed contract, not an implementation detail.
	const allReviewersNotice = "Reviewers: All 2 reviewers ran."
	const securityOnlyNotice = "⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: `Security`. This is not a full review.**"

	it("states a full review in one plain line and lets no emphasis into it", () => {
		const body = buildReviewPayload(aiResult, fullCoverage(2)).body

		expect(firstContentLineAfterHeading(body)).toBe(allReviewersNotice)
		expect(body.startsWith(`${REVIEW_HEADING}\n`)).toBe(true)
		expect(body.split(allReviewersNotice)).toHaveLength(2)
		expect(body).toContain(`${allReviewersNotice}\n\nTest summary`)
		expect(body).not.toContain("**")
		expect(body).not.toContain("> ")
		expect(body).not.toContain("⚠️")
	})

	it("counts every reviewer that ran, including one a bare run would not use", () => {
		// A run that covered every repository prompt and the built-in Default as well reviews more than a bare run does, and its total counts every reviewer that ran.
		const body = buildReviewPayload(aiResult, fullCoverage(3)).body

		expect(firstContentLineAfterHeading(body)).toBe("Reviewers: All 3 reviewers ran.")
		expect(body).not.toContain("**")
	})

	it("warns at the top and repeats the warning at the end when only a subset ran", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Security"], 2)).body

		expect(firstContentLineAfterHeading(body)).toBe(securityOnlyNotice)
		expect(body.split(securityOnlyNotice)).toHaveLength(3)
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
		expect(body.indexOf(securityOnlyNotice)).toBeLessThan(body.indexOf("Test summary"))
		expect(body.lastIndexOf(securityOnlyNotice)).toBeGreaterThan(body.indexOf("Test summary"))
	})

	it("leads the warning with its emoji and its bold lead, which is what a reader sees first", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Security"], 2)).body
		const notice = firstContentLineAfterHeading(body)

		expect(notice.startsWith("⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: ")).toBe(true)
		expect(notice.endsWith("This is not a full review.**")).toBe(true)
		expect(body).not.toContain("> ")
	})

	it("warns rather than naming the reviewers alone when one reviewer of two ran", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Architect"], 2)).body

		expect(body).toContain("⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: `Architect`. This is not a full review.**")
		expect(body).not.toContain(allReviewersNotice)
	})

	it("prints every reviewer that ran against the reference total, in selection order", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Security", "Architect"], 3)).body

		expect(body).toContain("⚠️ **PARTIAL REVIEW — 2 of 3 reviewers ran: `Security`, `Architect`. This is not a full review.**")
	})

	it("counts every reviewer it names, including one the reference set does not hold", () => {
		// A selection can name a reviewer no bare run would use while leaving a reference reviewer out, so the count follows the names the warning shows while the total counts the reviewer the run left out too.
		const body = buildReviewPayload(aiResult, partialCoverage(["Security", "Default"], 4)).body

		expect(firstContentLineAfterHeading(body)).toBe("⚠️ **PARTIAL REVIEW — 2 of 4 reviewers ran: `Security`, `Default`. This is not a full review.**")
		expect(body).not.toContain(allReviewersNotice)
	})

	it("keeps the number after 'of' above the number before it, so no partial warning reads as complete coverage", () => {
		// A partial warning exists to say the review is not complete, so a total equal to the count it lists would deny that on the line a reader trusts.
		const partialCoverages: ReviewerCoverage[] = [partialCoverage([], 1), partialCoverage(["Security"], 2), partialCoverage(["Security", "Architect"], 3), partialCoverage(["Security", "Default"], 4)]

		for (const coverage of partialCoverages) {
			const notice = firstContentLineAfterHeading(buildReviewPayload(aiResult, coverage).body)
			const statedCounts = /— (\d+) of (\d+) reviewers? ran/.exec(notice)
			if (statedCounts === null) throw new Error(`partial notice states no count of reviewers that ran: ${notice}`)
			expect(Number(statedCounts[2])).toBeGreaterThan(Number(statedCounts[1]))
		}
	})

	it("warns without a name list when the selection ran no reviewer", () => {
		// A separator-only `AGENTS` value parses to an empty selection, which reaches this notice with no name to list.
		const body = buildReviewPayload(aiResult, partialCoverage([], 1)).body
		const noReviewerNotice = "⚠️ **PARTIAL REVIEW — 0 of 1 reviewers ran. This is not a full review.**"

		expect(firstContentLineAfterHeading(body)).toBe(noReviewerNotice)
		expect(body.endsWith(noReviewerNotice)).toBe(true)
		expect(body).not.toContain(": .")
	})

	it("escapes a reviewer name so it can neither forge a line nor close the code span", () => {
		// A reviewer name is a prompt file name on the base branch, so its newline, bidi override, and backtick are untrusted.
		const hostileName = "Sec`urity\u202E\nReviewers: All 9 reviewers ran."
		const escapedName = "Sec\\u0060urity\\u202e\\u000aReviewers: All 9 reviewers ran."
		const partialReviewersNotice = `⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: \`${escapedName}\`. This is not a full review.**`
		const body = buildReviewPayload(aiResult, partialCoverage([hostileName], 2)).body

		expect(firstContentLineAfterHeading(body)).toBe(partialReviewersNotice)
		expect(body.split("\n").at(-1)).toBe(partialReviewersNotice)
		expect(body).not.toContain(hostileName)
		expect(body.split("\n").filter(line => line === "Reviewers: All 9 reviewers ran.")).toEqual([])
	})

	it("states a full review of a single reviewer, which is what a repository with no prompt of its own gets", () => {
		const body = buildReviewPayload(aiResult, fullCoverage(1)).body

		expect(firstContentLineAfterHeading(body)).toBe("Reviewers: All 1 reviewer ran.")
	})
})

describe("review body hardening", () => {
	const securityOnlyNotice = "⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: `Security`. This is not a full review.**"

	it("neutralises a comment opener in prose so the repeated warning stays visible", () => {
		// The body is model output about the pull request diff, so an author can open a comment there and turn the repeated warning into comment text.
		const bodyWithOpenComment: AiReviewResult = { body: "Findings\n<!-- opened by the diff", comments: [] }
		const body = buildReviewPayload(bodyWithOpenComment, partialCoverage(["Security"], 2)).body

		// The opener becomes an entity reference, which renders as the text a reader of prose would have seen and cannot start a comment.
		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", "Findings\n&lt;!-- opened by the diff", "", securityOnlyNotice].join("\n"))
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("neutralises a comment opener a fenced closer cannot vouch for", () => {
		// A closer inside a fenced code block renders as nothing, so counting openers against closers would read this body as balanced and let the open comment swallow the warning.
		const bodyWithDecoyCloser: AiReviewResult = { body: ["Findings", "```", "-->", "```", "<!-- opened by the diff"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyWithDecoyCloser, partialCoverage(["Security"], 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", ["Findings", "```", "-->", "```", "&lt;!-- opened by the diff"].join("\n"), "", securityOnlyNotice].join("\n"))
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("neutralises a comment opener after a fenced block whose lines end in a carriage return", () => {
		// GitHub normalises CRLF before it parses, so a scanner that read the carriage return as part of the closing fence would stay in code and leave this opener live.
		const bodyWithCarriageReturns: AiReviewResult = { body: ["Findings", "```", "-->", "```", "<!-- opened by the diff"].join("\r\n"), comments: [] }
		const body = buildReviewPayload(bodyWithCarriageReturns, partialCoverage(["Security"], 2)).body

		expect(body).toContain("&lt;!-- opened by the diff")
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("neutralises a comment opener inside an inline code span, the trade-off for one rewrite with no code-span scanner", () => {
		// A quoted `<!-- -->` inside inline code is harmless in itself, but tracking code spans costs a scanner this hardening deliberately does without, so it is rewritten too.
		const bodyWithCodeSpan: AiReviewResult = { body: "The template's `<!-- start -->` marker is now balanced.", comments: [] }
		const body = buildReviewPayload(bodyWithCodeSpan, partialCoverage(["Security"], 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", "The template's `&lt;!-- start -->` marker is now balanced.", "", securityOnlyNotice].join("\n"))
	})

	it("neutralises a comment opener after an unmatched backtick run, which renders as literal prose", () => {
		// An unmatched run renders as literal backticks, so the opener after it still starts a comment and has to be neutralised.
		const bodyWithStrayBacktick: AiReviewResult = { body: "A stray ` backtick <!-- opened by the diff", comments: [] }
		const body = buildReviewPayload(bodyWithStrayBacktick, partialCoverage(["Security"], 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", "A stray ` backtick &lt;!-- opened by the diff", "", securityOnlyNotice].join("\n"))
	})

	it("leaves a comment opener inside a fenced code block byte-exact", () => {
		// A fenced code block renders its content literally, so quoting an HTML comment is the one routine case where the body's opener is harmless.
		const bodyWithFencedComment: AiReviewResult = { body: ["Findings", "```html", "<!-- closed by the diff -->", "```"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyWithFencedComment, partialCoverage(["Security"], 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", bodyWithFencedComment.body, "", securityOnlyNotice].join("\n"))
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("closes a fence the body left open so the repeated warning keeps its own rendering", () => {
		// An unclosed fence makes every line after it code, so the repeat would render as monospace text with its bold markers shown literally, and closing it adds the one line the block needs without touching the fenced content.
		const bodyInsideOpenFence: AiReviewResult = { body: ["Findings", "````html", "<div>review</div>"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyInsideOpenFence, partialCoverage(["Security"], 2)).body

		expect(body.split("\n").slice(4)).toEqual(["Findings", "````html", "<div>review</div>", "````", "", securityOnlyNotice])
		expect(body.endsWith(`\n\n${securityOnlyNotice}`)).toBe(true)
	})

	it("leaves a fence the body left open alone when no notice follows the body", () => {
		const bodyInsideOpenFence: AiReviewResult = { body: ["Findings", "~~~", "note"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyInsideOpenFence, fullCoverage(2)).body

		expect(body).toBe(["## CI Agent Review", "", "Reviewers: All 2 reviewers ran.", "", bodyInsideOpenFence.body].join("\n"))
	})

	it("neutralises an opener after a blank line, because a blank line no longer starts a raw HTML block", () => {
		// The two rules track fences only, so a blank line neither starts nor ends anything and an opener after one is still rewritten.
		const bodyWithBlankLine: AiReviewResult = { body: ["Findings", "", "<!-- opened by the diff"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyWithBlankLine, partialCoverage(["Security"], 2)).body

		expect(body).toContain(["Findings", "", "&lt;!-- opened by the diff"].join("\n"))
	})

	it("passes a body that leaves a details block open through unchanged and still ends with the repeat", () => {
		// A raw HTML block is not tracked, so the fence line inside this one is read as a fence and the opener after it survives.
		const bodyLeavingDetailsOpen: AiReviewResult = { body: ["<details>", "```html", "<!-- opened by the diff"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyLeavingDetailsOpen, partialCoverage(["Security"], 2)).body

		expect(body).toContain(bodyLeavingDetailsOpen.body)
		expect(body).toContain("<!-- opened by the diff")
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})
})

describe("formatReviewForConsole", () => {
	it("formats review with no line comments", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const output = formatReviewForConsole(aiResult)

		expect(output).toContain("## CI Agent Review")
		expect(output).toContain("Test summary")
		expect(output).not.toContain("Line Comments")
	})

	it("formats review with line comments", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [
				{
					path: "src/file.ts",
					line: 42,
					side: "RIGHT",
					body: "This is a comment",
				},
			],
		}

		const output = formatReviewForConsole(aiResult)

		expect(output).toContain("## CI Agent Review")
		expect(output).toContain("Test summary")
		expect(output).toContain("### Line Comments")
		expect(output).toContain("src/file.ts:42 (RIGHT): This is a comment")
	})

	it("formats multiple line comments", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [
				{
					path: "file1.ts",
					line: 1,
					side: "RIGHT",
					body: "Comment 1",
				},
				{
					path: "file2.ts",
					line: 2,
					side: "LEFT",
					body: "Comment 2",
				},
			],
		}

		const output = formatReviewForConsole(aiResult)

		expect(output).toContain("file1.ts:1 (RIGHT): Comment 1")
		expect(output).toContain("file2.ts:2 (LEFT): Comment 2")
	})

	it("carries no reviewer notice, because the notice belongs to the submitted review", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const output = formatReviewForConsole(aiResult)

		expect(output).not.toContain("Reviewers:")
		expect(output).not.toContain("**")
	})
})
