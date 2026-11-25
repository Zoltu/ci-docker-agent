import { describe, it, expect } from "bun:test"
import { buildReviewPayload, formatReviewForConsole, type AiReviewResult } from "../source/review.mts"
import type { ReviewerCoverage } from "../source/agents.mts"

function fullCoverage(reviewerCount: number): ReviewerCoverage {
	return { kind: "full", reviewerCount }
}

function partialCoverage(ranReviewerNames: readonly string[], ranReferenceReviewerCount: number, referenceReviewerCount: number): ReviewerCoverage {
	return { kind: "partial", ranReviewerNames, ranReferenceReviewerCount, referenceReviewerCount }
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
	const allReviewersNotice = "Reviewers: All ran (2 of 2)."
	const securityOnlyNotice = "> **Reviewers: only 1 of 2 ran (`Security`). The remaining reviewers did not run, so this is not a full review.**"

	it("states a full review in one plain line and lets no emphasis into it", () => {
		const body = buildReviewPayload(aiResult, fullCoverage(2)).body

		expect(body.split("\n").slice(0, 3)).toEqual(["## CI Agent Review", "", allReviewersNotice])
		expect(body.split(allReviewersNotice)).toHaveLength(2)
		expect(body).toContain(`${allReviewersNotice}\n\nTest summary`)
		expect(body).not.toContain("**")
		expect(body).not.toContain("> ")
	})

	it("prints the reviewer count the coverage carries, even above the reference set", () => {
		// A run that covered every repository prompt and the built-in Default as well reviews more than a bare run does, and its total counts every reviewer that ran.
		const body = buildReviewPayload(aiResult, fullCoverage(3)).body

		expect(body.split("\n")[2]).toBe("Reviewers: All ran (3 of 3).")
		expect(body).not.toContain("**")
	})

	it("warns at the top and repeats the warning at the end when only a subset ran", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Security"], 1, 2)).body

		expect(body.split("\n").slice(0, 3)).toEqual(["## CI Agent Review", "", securityOnlyNotice])
		expect(body.split(securityOnlyNotice)).toHaveLength(3)
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
		expect(body.indexOf(securityOnlyNotice)).toBeLessThan(body.indexOf("Test summary"))
		expect(body.lastIndexOf(securityOnlyNotice)).toBeGreaterThan(body.indexOf("Test summary"))
	})

	it("warns rather than naming the reviewers alone when one reviewer of two ran", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Architect"], 1, 2)).body

		expect(body).toContain("> **Reviewers: only 1 of 2 ran (`Architect`). The remaining reviewers did not run, so this is not a full review.**")
		expect(body).not.toContain(allReviewersNotice)
	})

	it("prints the reference counts beside every reviewer that ran, in run order", () => {
		const body = buildReviewPayload(aiResult, partialCoverage(["Security", "Architect"], 2, 3)).body

		expect(body).toContain("> **Reviewers: only 2 of 3 ran (`Security`, `Architect`). The remaining reviewers did not run, so this is not a full review.**")
	})

	it("names a repeated reviewer once in the counts while the list keeps every reviewer that ran", () => {
		// The counts treat two spellings of one reviewer as one reviewer, while the listed names are every reviewer that actually ran.
		const body = buildReviewPayload(aiResult, partialCoverage(["Security", "security"], 1, 2)).body

		expect(body.split("\n")[2]).toBe("> **Reviewers: only 1 of 2 ran (`Security`, `security`). The remaining reviewers did not run, so this is not a full review.**")
		expect(body).not.toContain(allReviewersNotice)
	})

	it("escapes a reviewer name so it can neither forge a line nor close the code span", () => {
		// A reviewer name is a prompt file name on the base branch, so its newline, bidi override, and backtick are untrusted.
		const hostileName = "Sec`urity\u202E\n> **Reviewers: All ran (2 of 2)."
		const escapedName = "Sec\\u0060urity\\u202e\\u000a> **Reviewers: All ran (2 of 2)."
		const partialReviewersNotice = `> **Reviewers: only 1 of 2 ran (\`${escapedName}\`). The remaining reviewers did not run, so this is not a full review.**`
		const body = buildReviewPayload(aiResult, partialCoverage([hostileName], 1, 2)).body

		expect(body.split("\n")).toHaveLength(7)
		expect(body.split("\n")[2]).toBe(partialReviewersNotice)
		expect(body.endsWith(partialReviewersNotice)).toBe(true)
		expect(body).not.toContain(hostileName)
	})

	it("states a full review of a single reviewer, which is what a repository with no prompt of its own gets", () => {
		const body = buildReviewPayload(aiResult, fullCoverage(1)).body

		expect(body.split("\n")[2]).toBe("Reviewers: All ran (1 of 1).")
	})
})

describe("review body hardening", () => {
	const securityOnlyNotice = "> **Reviewers: only 1 of 2 ran (`Security`). The remaining reviewers did not run, so this is not a full review.**"

	it("neutralises a comment opener in prose so the repeated warning stays visible", () => {
		// The body is model output about the pull request diff, so an author can open a comment there and turn the repeated warning into comment text.
		const bodyWithOpenComment: AiReviewResult = { body: "Findings\n<!-- opened by the diff", comments: [] }
		const body = buildReviewPayload(bodyWithOpenComment, partialCoverage(["Security"], 1, 2)).body

		// The opener becomes an entity reference, which renders as the text a reader of prose would have seen and cannot start a comment.
		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", "Findings\n&lt;!-- opened by the diff", "", securityOnlyNotice].join("\n"))
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("neutralises a comment opener a fenced closer cannot vouch for", () => {
		// A closer inside a fenced code block renders as nothing, so counting openers against closers would read this body as balanced and let the open comment swallow the warning.
		const bodyWithDecoyCloser: AiReviewResult = { body: ["Findings", "```", "-->", "```", "<!-- opened by the diff"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyWithDecoyCloser, partialCoverage(["Security"], 1, 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", ["Findings", "```", "-->", "```", "&lt;!-- opened by the diff"].join("\n"), "", securityOnlyNotice].join("\n"))
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("neutralises a comment opener after a fenced block whose lines end in a carriage return", () => {
		// GitHub normalises CRLF before it parses, so a scanner that read the carriage return as part of the closing fence would stay in code and leave this opener live.
		const bodyWithCarriageReturns: AiReviewResult = { body: ["Findings", "```", "-->", "```", "<!-- opened by the diff"].join("\r\n"), comments: [] }
		const body = buildReviewPayload(bodyWithCarriageReturns, partialCoverage(["Security"], 1, 2)).body

		expect(body).toContain("&lt;!-- opened by the diff")
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("neutralises a comment opener inside an inline code span, the trade-off for one rewrite with no code-span scanner", () => {
		// A quoted `<!-- -->` inside inline code is harmless in itself, but tracking code spans costs a scanner this hardening deliberately does without, so it is rewritten too.
		const bodyWithCodeSpan: AiReviewResult = { body: "The template's `<!-- start -->` marker is now balanced.", comments: [] }
		const body = buildReviewPayload(bodyWithCodeSpan, partialCoverage(["Security"], 1, 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", "The template's `&lt;!-- start -->` marker is now balanced.", "", securityOnlyNotice].join("\n"))
	})

	it("neutralises a comment opener after an unmatched backtick run, which renders as literal prose", () => {
		// An unmatched run renders as literal backticks, so the opener after it still starts a comment and has to be neutralised.
		const bodyWithStrayBacktick: AiReviewResult = { body: "A stray ` backtick <!-- opened by the diff", comments: [] }
		const body = buildReviewPayload(bodyWithStrayBacktick, partialCoverage(["Security"], 1, 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", "A stray ` backtick &lt;!-- opened by the diff", "", securityOnlyNotice].join("\n"))
	})

	it("leaves a comment opener inside a fenced code block byte-exact", () => {
		// A fenced code block renders its content literally, so quoting an HTML comment is the one routine case where the body's opener is harmless.
		const bodyWithFencedComment: AiReviewResult = { body: ["Findings", "```html", "<!-- closed by the diff -->", "```"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyWithFencedComment, partialCoverage(["Security"], 1, 2)).body

		expect(body).toBe(["## CI Agent Review", "", securityOnlyNotice, "", bodyWithFencedComment.body, "", securityOnlyNotice].join("\n"))
		expect(body.endsWith(securityOnlyNotice)).toBe(true)
	})

	it("closes a fence the body left open so the repeated warning keeps its own rendering", () => {
		// An unclosed fence makes every line after it code, so the repeat would render as monospace text with its blockquote and bold markers shown literally, and closing it adds the one line the block needs without touching the fenced content.
		const bodyInsideOpenFence: AiReviewResult = { body: ["Findings", "````html", "<div>review</div>"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyInsideOpenFence, partialCoverage(["Security"], 1, 2)).body

		expect(body.split("\n").slice(4)).toEqual(["Findings", "````html", "<div>review</div>", "````", "", securityOnlyNotice])
		expect(body.endsWith(`\n\n${securityOnlyNotice}`)).toBe(true)
	})

	it("leaves a fence the body left open alone when no notice follows the body", () => {
		const bodyInsideOpenFence: AiReviewResult = { body: ["Findings", "~~~", "note"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyInsideOpenFence, fullCoverage(2)).body

		expect(body).toBe(["## CI Agent Review", "", "Reviewers: All ran (2 of 2).", "", bodyInsideOpenFence.body].join("\n"))
	})

	it("neutralises an opener after a blank line, because a blank line no longer starts a raw HTML block", () => {
		// The two rules track fences only, so a blank line neither starts nor ends anything and an opener after one is still rewritten.
		const bodyWithBlankLine: AiReviewResult = { body: ["Findings", "", "<!-- opened by the diff"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyWithBlankLine, partialCoverage(["Security"], 1, 2)).body

		expect(body).toContain(["Findings", "", "&lt;!-- opened by the diff"].join("\n"))
	})

	it("passes a body that leaves a details block open through unchanged and still ends with the repeat", () => {
		// A raw HTML block is not tracked, so the fence line inside this one is read as a fence and the opener after it survives: the top notice is the primary signal and the repeat is best effort.
		const bodyLeavingDetailsOpen: AiReviewResult = { body: ["<details>", "```html", "<!-- opened by the diff"].join("\n"), comments: [] }
		const body = buildReviewPayload(bodyLeavingDetailsOpen, partialCoverage(["Security"], 1, 2)).body

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
