import { describe, it, expect } from "bun:test"
import { shouldRunCI, extractAgentNames } from "../source/trigger.mts"

describe("shouldRunCI", () => {
	describe("pull_request_target event", () => {
		it("returns true for pull_request_target event", () => {
			expect(shouldRunCI("pull_request_target", null)).toEqual({ shouldRun: true, agentNames: [] })
		})

		it("returns true for pull_request_target event with comment", () => {
			expect(shouldRunCI("pull_request_target", "some comment")).toEqual({ shouldRun: true, agentNames: [] })
		})
	})

	describe("workflow_dispatch event", () => {
		it("returns true for workflow_dispatch event", () => {
			expect(shouldRunCI("workflow_dispatch", null)).toEqual({ shouldRun: true, agentNames: [] })
		})

		it("returns true for workflow_dispatch event with comment", () => {
			expect(shouldRunCI("workflow_dispatch", "some comment")).toEqual({ shouldRun: true, agentNames: [] })
		})
	})

	describe("issue_comment event", () => {
		it("returns false when comment body is null", () => {
			expect(shouldRunCI("issue_comment", null)).toEqual({ shouldRun: false, agentNames: [] })
		})

		it("returns false when comment body is empty", () => {
			expect(shouldRunCI("issue_comment", "")).toEqual({ shouldRun: false, agentNames: [] })
		})

		it("returns false when comment does not contain trigger command", () => {
			expect(shouldRunCI("issue_comment", "hello world")).toEqual({ shouldRun: false, agentNames: [] })
		})

		it("returns true when comment contains /review", () => {
			expect(shouldRunCI("issue_comment", "please /review")).toEqual({ shouldRun: true, agentNames: [] })
		})

		it("returns true when comment contains /review with agents", () => {
			expect(shouldRunCI("issue_comment", "run /review SecurityAgent, StyleAgent")).toEqual({
				shouldRun: true,
				agentNames: ["SecurityAgent", "StyleAgent"],
			})
		})
	})

	describe("unknown event (local-diff mode)", () => {
		it("returns true for unknown event", () => {
			expect(shouldRunCI("unknown", null)).toEqual({ shouldRun: true, agentNames: [] })
		})
	})

	describe("other events", () => {
		it("returns false for other unknown event types", () => {
			expect(shouldRunCI("some_other_event", null)).toEqual({ shouldRun: false, agentNames: [] })
		})
	})

	describe("agent name extraction", () => {
		it("extracts agent names from comma-separated list", () => {
			const result = shouldRunCI("issue_comment", "/review SecurityAgent, StyleAgent")
			expect(result.shouldRun).toBe(true)
			expect(result.agentNames).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("extracts single agent name", () => {
			const result = shouldRunCI("issue_comment", "/review SecurityAgent")
			expect(result.shouldRun).toBe(true)
			expect(result.agentNames).toEqual(["SecurityAgent"])
		})

		it("handles agents with spaces in names", () => {
			const result = shouldRunCI("issue_comment", "/review Security Agent, Style Agent")
			expect(result.shouldRun).toBe(true)
			expect(result.agentNames).toEqual(["Security Agent", "Style Agent"])
		})

		it("returns empty array when no agents specified", () => {
			const result = shouldRunCI("issue_comment", "/review")
			expect(result.shouldRun).toBe(true)
			expect(result.agentNames).toEqual([])
		})

		it("handles trailing comma", () => {
			const result = shouldRunCI("issue_comment", "/review SecurityAgent,")
			expect(result.shouldRun).toBe(true)
			expect(result.agentNames).toEqual(["SecurityAgent"])
		})
	})
})

describe("extractAgentNames", () => {
	it("extracts agent names from comma-separated list", () => {
		expect(extractAgentNames("/review SecurityAgent, StyleAgent")).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("extracts single agent name", () => {
		expect(extractAgentNames("/review SecurityAgent")).toEqual(["SecurityAgent"])
	})

	it("returns empty array when no agents specified", () => {
		expect(extractAgentNames("/review")).toEqual([])
	})

	it("handles trailing comma", () => {
		expect(extractAgentNames("/review SecurityAgent,")).toEqual(["SecurityAgent"])
	})

	it("handles agents with spaces in names", () => {
		expect(extractAgentNames("/review Security Agent, Style Agent")).toEqual(["Security Agent", "Style Agent"])
	})

	it("only extracts agents from the first line after the command", () => {
		expect(extractAgentNames("/review SecurityAgent\nStyleAgent")).toEqual(["SecurityAgent"])
	})

	it("trims whitespace from agent names", () => {
		expect(extractAgentNames("/review  SecurityAgent  ,  StyleAgent  ")).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("returns empty array when comment body has no trigger command", () => {
		expect(extractAgentNames("hello world")).toEqual([])
	})
})
