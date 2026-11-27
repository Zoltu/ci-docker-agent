import { describe, it, expect } from "bun:test"
import { buildReviewPayload, formatReviewForConsole, type AiReviewResult } from "../source/review.mts"
import type { ReviewerCoverage } from "../source/reviewer-coverage.mts"

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

	it("inserts the AI body unchanged, so its fence, comment opener and details tag reach GitHub as written", () => {
		const aiResult: AiReviewResult = {
			body: "Opened a fence it never closes:\n\n```ts\nconst reviewerCount = 2\n<!-- an HTML comment opener -->\n<details><summary>More</summary>",
			comments: [],
		}

		const payload = buildReviewPayload(aiResult, fullCoverage(2))

		expect(firstContentLineAfterHeading(payload.body)).toBe("Reviewers: All 2 reviewers ran.")
		expect(payload.body.endsWith(`\n\n${aiResult.body}`)).toBe(true)
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
