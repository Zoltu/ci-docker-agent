import { describe, it, expect } from "bun:test"
import { isSubsequence, selectProviderProfile, IDENTITY_PROFILE, TOGETHER_AI_PROFILE, PPQ_AI_PROFILE, QWEN_PROFILE, GLM_PROFILE } from "../source/provider-profiles.mts"
import type { CompletionsRequest } from "../source/completions.mts"

const BASE_REQUEST: CompletionsRequest = {
	model: "test-model",
	messages: [{ role: "user", content: "hello" }],
}

describe("selectProviderProfile", () => {
	it("returns identity profile for unknown provider URL", () => {
		const profile = selectProviderProfile("https://api.unknown.com/v1", "gpt-4")
		expect(profile.overwritePaths).toEqual([])
	})

	it("returns Together.ai profile for together.ai hostname", () => {
		const profile = selectProviderProfile("https://api.together.ai/v1", "some-model")
		expect(profile).toBe(TOGETHER_AI_PROFILE)
	})

	it("returns identity profile for invalid URL", () => {
		const profile = selectProviderProfile("not-a-url", "model")
		expect(profile).toBe(IDENTITY_PROFILE)
	})

	it("returns PPQ.ai profile for api.ppq.ai hostname", () => {
		const profile = selectProviderProfile("https://api.ppq.ai", "any-model")
		expect(profile).toBe(PPQ_AI_PROFILE)
	})
})

describe("Together.ai profile prepareRequest", () => {
	it("does not add request-level config", () => {
		const result = TOGETHER_AI_PROFILE.prepareRequest(BASE_REQUEST)
		expect(result).toEqual(BASE_REQUEST)
	})

	it("moves reasoning to reasoning_content on assistant messages", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "answer", reasoning: "I thought about it" },
			],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		const assistantMessage = result.messages[1]!
		if (assistantMessage.role !== "assistant") throw new Error("expected assistant")
		if ("reasoning" in assistantMessage && assistantMessage.reasoning !== undefined) {
			throw new Error("reasoning should have been moved")
		}
		if (!("reasoning_content" in assistantMessage)) throw new Error("expected reasoning_content")
		expect(assistantMessage.reasoning_content).toBe("I thought about it")
	})

	it("does not affect non-assistant messages", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "system", content: "instructions" },
				{ role: "user", content: "hello" },
			],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		expect(result.messages[0]).toEqual({ role: "system", content: "instructions" })
		expect(result.messages[1]).toEqual({ role: "user", content: "hello" })
	})

	it("leaves assistant messages without reasoning unchanged", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "assistant", content: "answer" },
			],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		expect(result.messages[0]).toEqual({ role: "assistant", content: "answer" })
	})

	it("moves null reasoning to reasoning_content", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "assistant", content: "answer", reasoning: null },
			],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		const msg = result.messages[0]!
		if (msg.role !== "assistant") throw new Error("expected assistant")
		if (!("reasoning_content" in msg)) throw new Error("expected reasoning_content")
		expect(msg.reasoning_content).toBeNull()
	})

	it("preserves tool_calls when moving reasoning", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "assistant", content: null, reasoning: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
			],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		const msg = result.messages[0]!
		if (msg.role !== "assistant") throw new Error("expected assistant")
		if (!("tool_calls" in msg) || !msg.tool_calls) throw new Error("expected tool_calls")
		expect(msg.tool_calls).toHaveLength(1)
		expect(msg.tool_calls[0]!.function.name).toBe("read_file")
		if (!("reasoning_content" in msg)) throw new Error("expected reasoning_content")
		expect(msg.reasoning_content).toBe("thinking")
	})
})

describe("Together.ai profile overwritePaths", () => {
	it("has overwritePaths for role and the tool_calls type repetition", () => {
		const paths = TOGETHER_AI_PROFILE.overwritePaths
		expect(paths).toContainEqual(["role"])
		expect(paths).toContainEqual(["tool_calls", "type"])
		// Defensive: token_id/tool_calls.id/tool_calls.function.name are skipped — token_id is always
		// null (concatenator skips), and tool_calls id/name are one-shot or null-after-first.
		expect(paths).not.toContainEqual(["token_id"])
		expect(paths).not.toContainEqual(["tool_calls", "id"])
		expect(paths).not.toContainEqual(["tool_calls", "function", "name"])
	})
})

describe("composeProfiles", () => {
	it("is exercised end-to-end via selectProviderProfile — see 'composeProfiles deep merge' below", () => {
		// composeProfiles is private; its behavior is verified through selectProviderProfile
		// in the 'composeProfiles deep merge' describe block.
	})
})

describe("IDENTITY_PROFILE", () => {
	it("does not modify the request", () => {
		const result = IDENTITY_PROFILE.prepareRequest(BASE_REQUEST)
		expect(result).toEqual(BASE_REQUEST)
	})

	it("has no overwritePaths", () => {
		expect(IDENTITY_PROFILE.overwritePaths).toEqual([])
	})
})

describe("isSubsequence", () => {
	it("matches non-contiguous characters in order", () => {
		expect(isSubsequence("qwen36", "QaWbEcNdsomething3something6")).toBe(true)
	})

	it("matches the listed qwen36 variations", () => {
		expect(isSubsequence("qwen36", "Qwen 3.6")).toBe(true)
		expect(isSubsequence("qwen36", "Qwen/Qwen3.6-Plus")).toBe(true)
		expect(isSubsequence("qwen36", "Qwen/Qwen3.6-35B-A3B-FP8")).toBe(true)
		expect(isSubsequence("qwen36", "Qwen 3-6")).toBe(true)
		expect(isSubsequence("qwen36", "Qwen36")).toBe(true)
	})

	it("does not match Qwen 3.5 (5 != 6)", () => {
		expect(isSubsequence("qwen36", "Qwen/Qwen3.5-397B-A17B")).toBe(false)
	})

	it("does not match unrelated models", () => {
		expect(isSubsequence("qwen36", "gpt-4")).toBe(false)
		expect(isSubsequence("qwen36", "claude-3-opus")).toBe(false)
	})

	it("is case-insensitive", () => {
		expect(isSubsequence("QWEN36", "qwen 3.6")).toBe(true)
		expect(isSubsequence("qwen36", "QWEN 3.6")).toBe(true)
	})

	it("returns true for empty query", () => {
		expect(isSubsequence("", "anything")).toBe(true)
	})

	it("returns false for empty target with non-empty query", () => {
		expect(isSubsequence("qwen", "")).toBe(false)
	})

	it("returns false when query is not a subsequence (wrong order)", () => {
		expect(isSubsequence("qwen36", "36qwen")).toBe(false)
	})

	it("returns false when query is longer than target", () => {
		expect(isSubsequence("qwen36", "qwen3")).toBe(false)
	})
})

describe("selectProviderProfile model pattern matching", () => {
	it("matches qwen36 variations to QWEN_PROFILE", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen 3.6")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen/Qwen3.6-Plus")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen/Qwen3.6-35B-A3B-FP8")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen 3-6")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen36")).toBe(QWEN_PROFILE)
	})

	it("matches glm to GLM_PROFILE", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "glm-4")).toBe(GLM_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "z-ai/glm-5")).toBe(GLM_PROFILE)
	})

	it("longest pattern wins when multiple match", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen 3.6-Plus")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "gpt-4")).toBe(IDENTITY_PROFILE)
	})
})

describe("composeProfiles deep merge", () => {
	it("preserves model chat_template_kwargs through Together.ai (no provider chat_template_kwargs)", () => {
		const profile = selectProviderProfile("https://api.together.ai/v1", "Qwen 3.6")
		const prepared = profile.prepareRequest(BASE_REQUEST)
		expect(prepared.chat_template_kwargs).toEqual({ preserve_thinking: true })
	})

	it("Qwen on Together.ai still transforms messages (provider transform wins on arrays)", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "answer", reasoning: "thinking" },
			],
		}
		const profile = selectProviderProfile("https://api.together.ai/v1", "Qwen 3.6")
		const prepared = profile.prepareRequest(request)
		const assistant = prepared.messages[1] as any
		expect(assistant.reasoning).toBeUndefined()
		expect(assistant.reasoning_content).toBe("thinking")
	})

	it("unions overwritePaths from both profiles", () => {
		const profile = selectProviderProfile("https://api.together.ai/v1", "Qwen 3.6")
		expect(profile.overwritePaths).toContainEqual(["role"])
		expect(profile.overwritePaths).toContainEqual(["tool_calls", "type"])
	})
})

describe("PPQ.ai profile", () => {
	it("does not modify the request", () => {
		const result = PPQ_AI_PROFILE.prepareRequest(BASE_REQUEST)
		expect(result).toEqual(BASE_REQUEST)
	})

	it("has overwritePaths for role and reasoning_details type/format repetitions", () => {
		const paths = PPQ_AI_PROFILE.overwritePaths
		expect(paths).toContainEqual(["role"])
		expect(paths).toContainEqual(["reasoning_details", "type"])
		expect(paths).toContainEqual(["reasoning_details", "format"])
	})
})
