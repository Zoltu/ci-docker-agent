import { describe, it, expect } from "bun:test"
import { parseAggregatorOutput } from "../source/ai.mts"

describe("parseAggregatorOutput", () => {
	it("parses valid JSON with body and comments", () => {
		const output = JSON.stringify({
			body: "Looks good",
			comments: [
				{ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" },
			],
		})

		const result = parseAggregatorOutput(output)

		expect(result.body).toBe("Looks good")
		expect(result.comments).toHaveLength(1)
		expect(result.comments[0]).toEqual({
			path: "src/file.ts",
			line: 10,
			side: "RIGHT",
			body: "Fix this",
		})
	})

	it("parses valid JSON with empty comments", () => {
		const output = JSON.stringify({
			body: "No issues found",
			comments: [],
		})

		const result = parseAggregatorOutput(output)

		expect(result.body).toBe("No issues found")
		expect(result.comments).toEqual([])
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

	it("throws when body is not a string", () => {
		const output = JSON.stringify({ body: 123, comments: [] })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when comments is not an array", () => {
		const output = JSON.stringify({ body: "test", comments: "not array" })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when comments is missing", () => {
		const output = JSON.stringify({ body: "test" })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("throws when body is missing", () => {
		const output = JSON.stringify({ comments: [] })

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})
})
