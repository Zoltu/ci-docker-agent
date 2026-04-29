import { describe, it, expect } from "bun:test"
import { parseAggregatorOutput, analyze, type CallApi } from "../source/ai.mts"
import type { Agent } from "../source/agents.mts"
import { makeBaseCommitContext, makeDiffResult, makeDiffFile } from "./helpers.mts"

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

	it("throws when body is empty string", () => {
		const output = JSON.stringify({ body: "", comments: [] })

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

	it("rejects line number zero", () => {
		const output = JSON.stringify({
			body: "test",
			comments: [{ path: "src/file.ts", line: 0, side: "RIGHT", body: "comment" }],
		})

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("rejects negative line number", () => {
		const output = JSON.stringify({
			body: "test",
			comments: [{ path: "src/file.ts", line: -1, side: "RIGHT", body: "comment" }],
		})

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("rejects non-integer line number", () => {
		const output = JSON.stringify({
			body: "test",
			comments: [{ path: "src/file.ts", line: 1.5, side: "RIGHT", body: "comment" }],
		})

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})

	it("rejects empty comment body", () => {
		const output = JSON.stringify({
			body: "test",
			comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "" }],
		})

		expect(() => parseAggregatorOutput(output)).toThrow(
			"Parsed output does not match expected AiReviewResult shape"
		)
	})
})

describe("analyze", () => {
	it("calls callApi for each agent and aggregator", async () => {
		const calls: string[] = []
		const callApi: CallApi = async (prompt) => {
			calls.push(prompt)
			return JSON.stringify({ body: "Review complete", comments: [] })
		}

		const agents: Agent[] = [
			{ name: "SecurityAgent", prompt: "Check security" },
			{ name: "StyleAgent", prompt: "Check style" },
		]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
		const diffResult = makeDiffResult({ files: [makeDiffFile()] })

		const result = await analyze({ callApi }, makeBaseCommitContext(), diffResult, agents, aggregator)

		expect(calls.length).toBe(3)
		expect(result.body).toBe("Review complete")
		expect(result.comments).toEqual([])
	})

	it("passes agent outputs to aggregator prompt", async () => {
		let callCount = 0
		const callApi: CallApi = async () => {
			callCount++
			return JSON.stringify({ body: `Result ${callCount}`, comments: [] })
		}

		const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
		const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
		const diffResult = makeDiffResult({ files: [makeDiffFile()] })

		const result = await analyze({ callApi }, makeBaseCommitContext(), diffResult, agents, aggregator)

		expect(result.body).toBe("Result 2")
	})
})
