import { describe, it, expect } from "bun:test"
import { selectProviderProfile, IDENTITY_PROFILE, TOGETHER_AI_PROFILE, PPQ_AI_PROFILE, QWEN_PROFILE, KIMI_PROFILE, GLM_PROFILE } from "../source/provider-profiles.mts"
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

	it("keeps messages that already carry only reasoning_content as-is", () => {
		const request: CompletionsRequest = {
			model: "test",
			messages: [
				{ role: "assistant", content: "answer", reasoning_content: "already there" },
			],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		expect(result.messages[0]).toEqual({ role: "assistant", content: "answer", reasoning_content: "already there" })
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

	it("keeps reasoning_content when both fields hold the same value", () => {
		const message = { role: "assistant" as const, content: "answer", reasoning: "kept", reasoning_content: "kept" }
		const request: CompletionsRequest = {
			model: "test",
			messages: [message],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		const msg = result.messages[0]!
		if (msg.role !== "assistant") throw new Error("expected assistant")
		if ("reasoning" in msg && msg.reasoning !== undefined) throw new Error("reasoning should have been moved")
		if (!("reasoning_content" in msg)) throw new Error("expected reasoning_content")
		expect(msg.reasoning_content).toBe("kept")
	})

	it("keeps the non-empty field when the other is an empty stub", () => {
		const message = { role: "assistant" as const, content: "answer", reasoning: "real", reasoning_content: " " }
		const request: CompletionsRequest = {
			model: "test",
			messages: [message],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		const msg = result.messages[0]!
		if (msg.role !== "assistant") throw new Error("expected assistant")
		if ("reasoning" in msg && msg.reasoning !== undefined) throw new Error("reasoning should have been moved")
		if (!("reasoning_content" in msg)) throw new Error("expected reasoning_content")
		expect(msg.reasoning_content).toBe("real")
	})

	it("prefers reasoning_content silently when both fields have different values", () => {
		const message = { role: "assistant" as const, content: "answer", reasoning: "moved away", reasoning_content: "kept" }
		const request: CompletionsRequest = {
			model: "test",
			messages: [message],
		}
		const result = TOGETHER_AI_PROFILE.prepareRequest(request)
		const msg = result.messages[0]!
		if (msg.role !== "assistant") throw new Error("expected assistant")
		if ("reasoning" in msg && msg.reasoning !== undefined) throw new Error("reasoning should have been moved")
		if (!("reasoning_content" in msg)) throw new Error("expected reasoning_content")
		expect(msg.reasoning_content).toBe("kept")
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
	it("has no overwritePaths — role and tool_calls type are subsumed by ONE_SHOT_KEYS at any depth", () => {
		const paths = TOGETHER_AI_PROFILE.overwritePaths
		expect(paths).toEqual([])
	})
})

describe("composeProfiles", () => {
	it("is exercised end-to-end via selectProviderProfile — see 'composeProfiles deep merge' below", () => {
		// composeProfiles is private; its behavior is verified through selectProviderProfile
		// in the 'composeProfiles deep merge' describe block.
	})

	// Limitation: composeProfiles is module-private and no provider profile sets reasoningField,
	// so the provider-wins merge direction (second.reasoningField ?? first.reasoningField where
	// second supplies a value) cannot be exercised through the public surface. The tests below
	// only cover the case where the provider leaves reasoningField undefined and the model wins.
	it("composeProfiles uses model reasoningField when provider has none", () => {
		const qwenOnTogether = selectProviderProfile("https://api.together.ai/v1", "Qwen 3.6")
		expect(QWEN_PROFILE.reasoningField).toEqual(["reasoning_content"])
		expect(TOGETHER_AI_PROFILE.reasoningField).toBeUndefined()
		expect(qwenOnTogether.reasoningField).toEqual(["reasoning_content"])

		const glmOnPpq = selectProviderProfile("https://api.ppq.ai", "glm-4")
		expect(GLM_PROFILE.reasoningField).toEqual(["reasoning_content"])
		expect(PPQ_AI_PROFILE.reasoningField).toBeUndefined()
		expect(glmOnPpq.reasoningField).toEqual(["reasoning_content"])

		expect(IDENTITY_PROFILE.reasoningField).toBeUndefined()
		expect(selectProviderProfile("https://api.unknown.com/v1", "gpt-4").reasoningField).toBeUndefined()
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

describe("selectProviderProfile model pattern matching", () => {
	it("matches qwen variations to QWEN_PROFILE", () => {
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

	it("matches kimi to KIMI_PROFILE", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "moonshotai/Kimi-K2")).toBe(KIMI_PROFILE)
	})

	it("matches patterns case-insensitively", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "GLM-4")).toBe(GLM_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "QWEN 3.6")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "MoonshotAI/KIMI-K2")).toBe(KIMI_PROFILE)
	})

	it("does not match when the pattern only appears as a scattered subsequence", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "google/gemma-3-27b-it")).toBe(IDENTITY_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "gemini-latest-mega")).toBe(IDENTITY_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "quixotic-wave-ember-nova")).toBe(IDENTITY_PROFILE)
	})

	it("does not match unrelated models or an empty model name", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "gpt-4")).toBe(IDENTITY_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "claude-3-opus")).toBe(IDENTITY_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "")).toBe(IDENTITY_PROFILE)
	})

	it("longest pattern wins when multiple match", () => {
		expect(selectProviderProfile("https://api.unknown.com/v1", "Qwen 3.6-Plus")).toBe(QWEN_PROFILE)
		expect(selectProviderProfile("https://api.unknown.com/v1", "glm-qwen")).toBe(QWEN_PROFILE)
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
		const assistant = prepared.messages[1]
		if (assistant === undefined) throw new Error("expected assistant message")
		if (assistant.role !== "assistant") throw new Error("expected assistant")
		if ("reasoning" in assistant && assistant.reasoning !== undefined) {
			throw new Error("reasoning should have been moved")
		}
		if (!("reasoning_content" in assistant)) throw new Error("expected reasoning_content")
		expect(assistant.reasoning_content).toBe("thinking")
	})

	it("unions overwritePaths from both profiles", () => {
		const qwenOnTogether = selectProviderProfile("https://api.together.ai/v1", "Qwen 3.6")
		expect(qwenOnTogether.overwritePaths).toEqual([])
		const glmOnPpq = selectProviderProfile("https://api.ppq.ai", "glm-4")
		expect(glmOnPpq.overwritePaths).toEqual([["reasoning_details", "format"]])
	})
})

describe("PPQ.ai profile", () => {
	it("does not modify the request", () => {
		const result = PPQ_AI_PROFILE.prepareRequest(BASE_REQUEST)
		expect(result).toEqual(BASE_REQUEST)
	})

	it("has overwritePaths for reasoning_details format only — role and type are subsumed by ONE_SHOT_KEYS at any depth", () => {
		const paths = PPQ_AI_PROFILE.overwritePaths
		expect(paths).toEqual([["reasoning_details", "format"]])
	})
})
