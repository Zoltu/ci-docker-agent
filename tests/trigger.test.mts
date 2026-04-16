import { describe, it, expect } from "bun:test"
import { shouldRunCI } from "../source/trigger.mts"

describe("shouldRunCI", () => {
	describe("pull_request_target event", () => {
		it("returns true for pull_request_target event", () => {
			expect(shouldRunCI("pull_request_target", null)).toBe(true)
		})

		it("returns true for pull_request_target event with comment", () => {
			expect(shouldRunCI("pull_request_target", "some comment")).toBe(true)
		})
	})

	describe("issue_comment event", () => {
		it("returns false when comment body is null", () => {
			expect(shouldRunCI("issue_comment", null)).toBe(false)
		})

		it("returns false when comment body is empty", () => {
			expect(shouldRunCI("issue_comment", "")).toBe(false)
		})

		it("returns false when comment does not contain trigger command", () => {
			expect(shouldRunCI("issue_comment", "hello world")).toBe(false)
		})

		it("returns true when comment contains /ci", () => {
			expect(shouldRunCI("issue_comment", "please /ci")).toBe(true)
		})

		it("returns true when comment contains /check", () => {
			expect(shouldRunCI("issue_comment", "run /check please")).toBe(true)
		})

		it("returns true when comment contains /test", () => {
			expect(shouldRunCI("issue_comment", "/test this")).toBe(true)
		})
	})

	describe("unknown event (local-diff mode)", () => {
		it("returns true for unknown event", () => {
			expect(shouldRunCI("unknown", null)).toBe(true)
		})
	})

	describe("other events", () => {
		it("returns false for other unknown event types", () => {
			expect(shouldRunCI("some_other_event", null)).toBe(false)
		})
	})
})
