import { describe, it, expect } from "bun:test"
import { buildReviewPayload, formatReviewForConsole, type AiReviewResult } from "../source/review.mts"

describe("buildReviewPayload", () => {
	it("creates a review payload with COMMENT event", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const payload = buildReviewPayload(aiResult)

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

		const payload = buildReviewPayload(aiResult)

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
