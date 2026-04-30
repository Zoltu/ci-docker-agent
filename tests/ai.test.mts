import { describe, it, expect } from "bun:test"
import { analyze, type CallApi } from "../source/ai.mts"
import type { Agent } from "../source/agents.mts"
import { makeBaseCommitContext, makeDiffResult, makeDiffFile } from "./helpers.mts"

function makeCallApiWithAggregatorOutput(aggregatorOutput: string): CallApi {
	let callCount = 0
	return async () => {
		callCount++
		if (callCount <= 1) {
			return JSON.stringify({ body: "Agent result", comments: [] })
		}
		return aggregatorOutput
	}
}

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

		const result = await analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)

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

		const result = await analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)

		expect(result.body).toBe("Result 2")
	})

	describe("aggregator output validation", () => {
		it("returns result when aggregator output is valid with comments", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({
				body: "Looks good",
				comments: [{ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			const result = await analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)

			expect(result.body).toBe("Looks good")
			expect(result.comments).toHaveLength(1)
			expect(result.comments[0]).toEqual({ path: "src/file.ts", line: 10, side: "RIGHT", body: "Fix this" })
		})

		it("returns result when aggregator output has empty comments", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({
				body: "No issues found",
				comments: [],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			const result = await analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)

			expect(result.body).toBe("No issues found")
			expect(result.comments).toEqual([])
		})

		it("throws SyntaxError when aggregator output is not valid JSON", async () => {
			const callApi = makeCallApiWithAggregatorOutput("not json")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow(SyntaxError)
		})

		it("throws SyntaxError when aggregator output is empty string", async () => {
			const callApi = makeCallApiWithAggregatorOutput("")
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow(SyntaxError)
		})

		it("throws when aggregator output does not match expected shape", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({ wrong: "shape" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is not a string", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({ body: 123, comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is not an array", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({ body: "test", comments: "not array" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator comments is missing", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({ body: "test" }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is empty string", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({ body: "", comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("throws when aggregator body is missing", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({ comments: [] }))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects line number zero in aggregator comments", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 0, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects negative line number in aggregator comments", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: -1, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects non-integer line number in aggregator comments", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1.5, side: "RIGHT", body: "comment" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})

		it("rejects empty comment body in aggregator comments", async () => {
			const callApi = makeCallApiWithAggregatorOutput(JSON.stringify({
				body: "test",
				comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "" }],
			}))
			const agents: Agent[] = [{ name: "TestAgent", prompt: "Test" }]
			const aggregator: Agent = { name: "Aggregator", prompt: "Aggregate" }
			const diffResult = makeDiffResult({ files: [makeDiffFile()] })

			expect(analyze({ callApi, log: () => {} }, makeBaseCommitContext(), diffResult, agents, aggregator)).rejects.toThrow("Parsed output does not match expected AiReviewResult shape")
		})
	})
})
