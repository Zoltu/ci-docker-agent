import { describe, it, expect } from "bun:test"
import { buildReviewPayload, formatReviewForConsole, type AiReviewResult } from "../source/review.mts"
import { makeDiffResult, makeDiffFile } from "./helpers.mts"

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
	it("formats review with no line comments and no files", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const diffResult = makeDiffResult()
		const output = formatReviewForConsole(aiResult, diffResult)

		expect(output).toContain("## CI Agent Review")
		expect(output).toContain("Test summary")
		expect(output).not.toContain("Line Comments")
		expect(output).toContain("### Files Analyzed")
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

		const diffResult = makeDiffResult()
		const output = formatReviewForConsole(aiResult, diffResult)

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

		const diffResult = makeDiffResult()
		const output = formatReviewForConsole(aiResult, diffResult)

		expect(output).toContain("file1.ts:1 (RIGHT): Comment 1")
		expect(output).toContain("file2.ts:2 (LEFT): Comment 2")
	})

	it("includes file summary in output", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const diffResult = makeDiffResult({
			files: [
				makeDiffFile({ filename: "src/file.ts", status: "modified", additions: 10, deletions: 5 }),
				makeDiffFile({ filename: "README.md", status: "added", additions: 50, deletions: 0 }),
			],
		})

		const output = formatReviewForConsole(aiResult, diffResult)

		expect(output).toContain("### Files Analyzed")
		expect(output).toContain("src/file.ts (modified): +10 -5")
		expect(output).toContain("README.md (added): +50 -0")
	})

	it("includes binary files not analyzed", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const diffResult = makeDiffResult({
			files: [makeDiffFile()],
			binaryFiles: ["logo.png", "icon.svg"],
		})

		const output = formatReviewForConsole(aiResult, diffResult)

		expect(output).toContain("### Binary Files (Not Analyzed)")
		expect(output).toContain("- logo.png")
		expect(output).toContain("- icon.svg")
	})

	it("omits binary files section when no binary files", () => {
		const aiResult: AiReviewResult = {
			body: "Test summary",
			comments: [],
		}

		const diffResult = makeDiffResult({ files: [makeDiffFile()] })

		const output = formatReviewForConsole(aiResult, diffResult)

		expect(output).not.toContain("### Binary Files (Not Analyzed)")
	})
})
