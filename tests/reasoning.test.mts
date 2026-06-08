import { describe, expect, it } from "bun:test"
import { extractAtPath, readReasoningFromDelta } from "../source/reasoning.mts"
import type { CompletionDelta } from "../source/completions.mts"
import type { ProviderProfile } from "../source/provider-profiles.mts"

const REASONING_CONTENT_PROFILE: ProviderProfile = { prepareRequest: r => r, overwritePaths: [], reasoningField: ["reasoning_content"] }
const NESTED_PROFILE: ProviderProfile = { prepareRequest: r => r, overwritePaths: [], reasoningField: ["reasoning_details", "0", "text"] }
const IDENTITY: ProviderProfile = { prepareRequest: r => r, overwritePaths: [] }

function delta(overrides: Partial<CompletionDelta> = {}): CompletionDelta {
	return { ...overrides }
}

describe("extractAtPath", () => {
	it("returns the value at a top-level object key", () => {
		expect(extractAtPath({ a: 1, b: 2 }, ["a"])).toBe(1)
	})

	it("walks a nested object path", () => {
		expect(extractAtPath({ a: { b: { c: 42 } } }, ["a", "b", "c"])).toBe(42)
	})

	it("walks into arrays via numeric segments", () => {
		expect(extractAtPath({ items: ["x", "y", "z"] }, ["items", "1"])).toBe("y")
	})

	it("walks through array indices into nested objects", () => {
		expect(extractAtPath({ details: [{ text: "hi" }, { text: "bye" }] }, ["details", "0", "text"])).toBe("hi")
	})

	it("returns undefined when a segment cannot be resolved", () => {
		expect(extractAtPath({ a: 1 }, ["a", "b"])).toBeUndefined()
	})

	it("returns undefined when an array index is out of bounds", () => {
		expect(extractAtPath({ items: ["x"] }, ["items", "5"])).toBeUndefined()
	})

	it("returns undefined when a non-numeric segment is used on an array", () => {
		expect(extractAtPath({ items: ["x"] }, ["items", "name"])).toBeUndefined()
	})

	it("returns undefined when descending into a primitive", () => {
		expect(extractAtPath({ a: "leaf" }, ["a", "b"])).toBeUndefined()
	})

	it("returns undefined when starting from null or non-object", () => {
		expect(extractAtPath(null, ["a"])).toBeUndefined()
		expect(extractAtPath("string", ["a"])).toBeUndefined()
		expect(extractAtPath(42, ["a"])).toBeUndefined()
	})

	it("returns the value when path is empty", () => {
		expect(extractAtPath({ a: 1 }, [])).toEqual({ a: 1 })
	})

	it("resolves a nested reasoning_details path the same way it would on a real message or delta", () => {
		const value = { reasoning_details: [{ type: "text", text: "deep thought" }] }
		expect(extractAtPath(value, NESTED_PROFILE.reasoningField!)).toBe("deep thought")
	})
})

describe("readReasoningFromDelta", () => {
	it("reads reasoning from the default path", () => {
		expect(readReasoningFromDelta(delta({ reasoning: "thinking" }), IDENTITY)).toBe("thinking")
	})

	it("returns undefined when reasoning is missing on the default path", () => {
		expect(readReasoningFromDelta(delta({ content: "hi" }), IDENTITY)).toBeUndefined()
	})

	it("ignores reasoning_content on the default profile", () => {
		expect(readReasoningFromDelta(delta({ reasoning_content: "thinking" }), IDENTITY)).toBeUndefined()
	})

	it("reads reasoning_content when the profile points at it", () => {
		expect(readReasoningFromDelta(delta({ reasoning_content: "thinking" }), REASONING_CONTENT_PROFILE)).toBe("thinking")
	})

	it("ignores reasoning when the profile points at reasoning_content", () => {
		expect(readReasoningFromDelta(delta({ reasoning: "thinking" }), REASONING_CONTENT_PROFILE)).toBeUndefined()
	})

	it("returns undefined for empty string", () => {
		expect(readReasoningFromDelta(delta({ reasoning: "" }), IDENTITY)).toBeUndefined()
	})

	it("returns undefined for null", () => {
		expect(readReasoningFromDelta(delta({ reasoning: null as unknown as string }), IDENTITY)).toBeUndefined()
	})
})
