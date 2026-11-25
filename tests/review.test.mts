import { describe, it, expect } from "bun:test"
import { buildReviewPayload, formatReviewForConsole, type AiReviewResult } from "../source/review.mts"

describe("buildReviewPayload", () => {
	it("creates a review payload with COMMENT event", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const payload = buildReviewPayload(aiResult, "run all agents", ["TestAgent"])

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

		const payload = buildReviewPayload(aiResult, "run all agents", ["TestAgent"])

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
	const allReviewerNames = ["Architect", "Security"]
	// The presentation is asserted literally, because the plain full-review line and the loud partial-review warning are the reviewed contract, not an implementation detail.
	const allReviewersNotice = "Reviewers: All ran (2 of 2)."

	it("states a full review in one plain line and lets no emphasis into it", () => {
		const body = buildReviewPayload(aiResult, "run all agents", allReviewerNames).body

		expect(body.split("\n").slice(0, 3)).toEqual(["## CI Agent Review", "", allReviewersNotice])
		expect(body.split(allReviewersNotice)).toHaveLength(2)
		expect(body).toContain(`${allReviewersNotice}\n\nTest summary`)
		expect(body).not.toContain("**")
		expect(body).not.toContain("> ")
	})

	it("states a full review when every selector label was applied explicitly", () => {
		const body = buildReviewPayload(aiResult, ["Security", "Architect"], allReviewerNames).body

		expect(body.split("\n")[2]).toBe(allReviewersNotice)
		expect(body).not.toContain("**")
	})

	it("warns at the top and repeats the warning at the end when only a subset ran", () => {
		const partialReviewersNotice = "> **Reviewers: only 1 of 2 ran (`Security`). The remaining reviewers did not run, so this is not a full review.**"
		const body = buildReviewPayload(aiResult, ["Security"], allReviewerNames).body

		expect(body.split("\n").slice(0, 3)).toEqual(["## CI Agent Review", "", partialReviewersNotice])
		expect(body.split(partialReviewersNotice)).toHaveLength(3)
		expect(body.endsWith(partialReviewersNotice)).toBe(true)
		expect(body.indexOf(partialReviewersNotice)).toBeLessThan(body.indexOf("Test summary"))
		expect(body.lastIndexOf(partialReviewersNotice)).toBeGreaterThan(body.indexOf("Test summary"))
	})

	it("warns rather than naming the reviewers alone when one reviewer of two ran", () => {
		const body = buildReviewPayload(aiResult, ["Architect"], allReviewerNames).body

		expect(body).toContain("> **Reviewers: only 1 of 2 ran (`Architect`). The remaining reviewers did not run, so this is not a full review.**")
		expect(body).not.toContain(allReviewersNotice)
	})

	it("takes the total from every reviewer the run could have used and names the selection in its own order", () => {
		const body = buildReviewPayload(aiResult, ["Security", "Architect"], ["Architect", "Security", "Defender"]).body

		expect(body).toContain("> **Reviewers: only 2 of 3 ran (`Security`, `Architect`). The remaining reviewers did not run, so this is not a full review.**")
	})

	it("counts a full review of the built-in Default reviewer", () => {
		const body = buildReviewPayload(aiResult, "run all agents", ["Default"]).body

		expect(body.split("\n")[2]).toBe("Reviewers: All ran (1 of 1).")
	})

	it("leaves both notices out of the console format, which has no label concept", () => {
		const output = formatReviewForConsole(aiResult)

		expect(output).not.toContain(allReviewersNotice)
		expect(output).not.toContain("not a full review")
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
})
