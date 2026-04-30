import { describe, expect, it } from "bun:test"
import { getAgentsFromComment } from "../source/trigger.mts"

describe("getAgentsFromComment", () => {
	describe("no review triggered", () => {
		it("returns 'no review triggered' when comment body is null", () => {
			expect(getAgentsFromComment(null)).toBe("no review triggered")
		})

		it("returns 'no review triggered' when comment body is empty", () => {
			expect(getAgentsFromComment("")).toBe("no review triggered")
		})

		it("returns 'no review triggered' when comment does not contain trigger command", () => {
			expect(getAgentsFromComment("hello world")).toBe("no review triggered")
		})

		it("returns 'no review triggered' when /review is not at start of line", () => {
			expect(getAgentsFromComment("please /review")).toBe("no review triggered")
		})
	})

	describe("run all agents", () => {
		it("returns 'run all agents' when comment is bare /review", () => {
			expect(getAgentsFromComment("/review")).toBe("run all agents")
		})
	})

	describe("specific agents", () => {
		it("returns agent names when comment starts with /review with agents", () => {
			expect(getAgentsFromComment("/review SecurityAgent, StyleAgent")).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("extracts single agent name", () => {
			expect(getAgentsFromComment("/review SecurityAgent")).toEqual(["SecurityAgent"])
		})

		it("handles agents with spaces in names", () => {
			expect(getAgentsFromComment("/review Security Agent, Style Agent")).toEqual(["Security Agent", "Style Agent"])
		})

		it("handles trailing comma", () => {
			expect(getAgentsFromComment("/review SecurityAgent,")).toEqual(["SecurityAgent"])
		})
	})
})
