import { describe, it, expect } from "bun:test"
import { parseAggregatorOutput } from "../source/ai.mts"

describe("parseAggregatorOutput", () => {
	it("parses valid JSON with summary and lineComments", () => {
		const output = JSON.stringify({
			summary: "Looks good",
			lineComments: [
				{ path: "src/file.ts", line: 10, side: "RIGHT", comment: "Fix this" },
			],
		})

		const result = parseAggregatorOutput(output)

		expect(result.summary).toBe("Looks good")
		expect(result.lineComments).toHaveLength(1)
		expect(result.lineComments[0]).toEqual({
			path: "src/file.ts",
			line: 10,
			side: "RIGHT",
			comment: "Fix this",
		})
	})

	it("parses valid JSON with empty lineComments", () => {
		const output = JSON.stringify({
			summary: "No issues found",
			lineComments: [],
		})

		const result = parseAggregatorOutput(output)

		expect(result.summary).toBe("No issues found")
		expect(result.lineComments).toEqual([])
	})

	it("throws SyntaxError when output is not valid JSON", () => {
		expect(() => parseAggregatorOutput("not json")).toThrow(SyntaxError)
	})

	it("throws SyntaxError when output is empty string", () => {
		expect(() => parseAggregatorOutput("")).toThrow(SyntaxError)
	})

	it("throws when parsed JSON does not match expected shape", () => {
		const output = JSON.stringify({ wrong: "shape" })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when summary is not a string", () => {
		const output = JSON.stringify({ summary: 123, lineComments: [] })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when lineComments is not an array", () => {
		const output = JSON.stringify({ summary: "test", lineComments: "not array" })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when lineComments is missing", () => {
		const output = JSON.stringify({ summary: "test" })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when summary is missing", () => {
		const output = JSON.stringify({ lineComments: [] })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})
})
