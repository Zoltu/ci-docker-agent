import type { AiToolCall } from "./ai-fetch.mts"

export interface DeltaText {
	content?: string
	reasoning?: string
	toolCalls?: ToolCallDelta[]
	finishReason?: string | null
}

export interface ToolCallDelta {
	index: number
	id?: string
	functionName?: string
	functionArguments?: string
}

async function* readStreamChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			yield decoder.decode(value, { stream: true })
		}
	} finally {
		reader.releaseLock()
	}
}

function parseSseLine(line: string): { type: "data"; payload: string } | { type: "done" } | { type: "ignore" } {
	const trimmed = line.trim()
	if (trimmed === "") return { type: "ignore" }
	if (!trimmed.startsWith("data: ")) return { type: "ignore" }

	const payload = trimmed.slice(6)
	if (payload === "[DONE]") return { type: "done" }

	return { type: "data", payload }
}

function isReasoningDetail(value: unknown): value is { text: string } {
	if (typeof value !== "object" || value === null) return false
	if (!("text" in value) || typeof value.text !== "string") return false
	return true
}

function extractToolCallDeltas(delta: unknown): ToolCallDelta[] {
	if (typeof delta !== "object" || delta === null) return []
	if (!("tool_calls" in delta) || !Array.isArray(delta.tool_calls)) return []

	const results: ToolCallDelta[] = []
	for (const tc of delta.tool_calls) {
		if (typeof tc !== "object" || tc === null) continue
		const entry: ToolCallDelta = { index: typeof tc.index === "number" ? tc.index : 0 }
		if ("id" in tc && typeof tc.id === "string") entry.id = tc.id
		if ("function" in tc && typeof tc.function === "object" && tc.function !== null) {
			if ("name" in tc.function && typeof tc.function.name === "string") entry.functionName = tc.function.name
			if ("arguments" in tc.function && typeof tc.function.arguments === "string") entry.functionArguments = tc.function.arguments
		}
		results.push(entry)
	}
	return results
}

function extractDelta(data: unknown): DeltaText {
	if (typeof data !== "object" || data === null) return {}
	if (!("choices" in data) || !Array.isArray(data.choices)) return {}
	if (data.choices.length === 0) return {}
	const firstChoice = data.choices[0]
	if (typeof firstChoice !== "object" || firstChoice === null) return {}
	if (!("delta" in firstChoice) || typeof firstChoice.delta !== "object" || firstChoice.delta === null) return {}

	const result: DeltaText = {}

	if ("content" in firstChoice.delta && typeof firstChoice.delta.content === "string" && firstChoice.delta.content !== "") {
		result.content = firstChoice.delta.content
	}

	if ("reasoning" in firstChoice.delta && typeof firstChoice.delta.reasoning === "string" && firstChoice.delta.reasoning !== "") {
		result.reasoning = firstChoice.delta.reasoning
	} else if ("reasoning_content" in firstChoice.delta && typeof firstChoice.delta.reasoning_content === "string" && firstChoice.delta.reasoning_content !== "") {
		result.reasoning = firstChoice.delta.reasoning_content
	} else if ("reasoning_details" in firstChoice.delta && Array.isArray(firstChoice.delta.reasoning_details)) {
		const details: unknown[] = firstChoice.delta.reasoning_details
		const reasoningText = details
			.filter(isReasoningDetail)
			.map((d: { text: string }) => d.text)
			.join("")
		if (reasoningText !== "") result.reasoning = reasoningText
	}

	const toolCallDeltas = extractToolCallDeltas(firstChoice.delta)
	if (toolCallDeltas.length > 0) result.toolCalls = toolCallDeltas

	if ("finish_reason" in firstChoice && firstChoice.finish_reason != null) {
		result.finishReason = String(firstChoice.finish_reason)
	}

	return result
}

export const RECOGNIZED_DELTA_KEYS = new Set(["content", "reasoning", "reasoning_content", "reasoning_details", "tool_calls", "role"])

function extractCachedTokens(data: unknown): number | null {
	if (typeof data !== "object" || data === null) return null
	if (!("usage" in data) || typeof data.usage !== "object" || data.usage === null) return null
	const usage = data.usage
	if (!("prompt_tokens_details" in usage) || typeof usage.prompt_tokens_details !== "object" || usage.prompt_tokens_details === null) return null
	const details = usage.prompt_tokens_details
	if (!("cached_tokens" in details) || typeof details.cached_tokens !== "number") return null
	return details.cached_tokens
}

function collectDeltaKeys(data: unknown, keysSeen: Set<string>): void {
	if (typeof data !== "object" || data === null) return
	if (!("choices" in data) || !Array.isArray(data.choices) || data.choices.length === 0) return
	const firstChoice = data.choices[0]
	if (typeof firstChoice !== "object" || firstChoice === null) return
	if (!("delta" in firstChoice) || typeof firstChoice.delta !== "object" || firstChoice.delta === null) return
	for (const key of Object.keys(firstChoice.delta)) {
		keysSeen.add(key)
	}
}

export interface ToolCallAccumulatorEntry {
	id: string
	name: string
	arguments: string
}

export type ToolCallAccumulator = Map<number, ToolCallAccumulatorEntry>

export function accumulateToolCallDeltas(accumulator: ToolCallAccumulator, deltas: ToolCallDelta[]): void {
	for (const delta of deltas) {
		const existing = accumulator.get(delta.index)
		if (existing) {
			if (delta.functionArguments !== undefined) existing.arguments += delta.functionArguments
		} else {
			accumulator.set(delta.index, {
				id: delta.id ?? "",
				name: delta.functionName ?? "",
				arguments: delta.functionArguments ?? "",
			})
		}
	}
}

export function isContextWindowExceededError(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	return message.includes("context length") || message.includes("context window") || message.includes("maximum context") || message.includes("token limit")
}

interface StreamState {
	buffer: string
	contentChunks: string[]
	toolCallAccumulator: ToolCallAccumulator
	finishReason: string | null
	cachedTokens: number | null
	deltaKeysSeen: Set<string>
	reasoningStarted: boolean
	contentStarted: boolean
}

async function applySseDelta(state: StreamState, delta: DeltaText, onContent?: (content: string) => Promise<void>, onTrace?: (trace: string) => Promise<void>): Promise<void> {
	if (delta.reasoning) {
		if (state.contentStarted) {
			await onTrace?.("\n\n")
			state.contentStarted = false
		}
		if (!state.reasoningStarted) {
			await onTrace?.("# Reasoning\n\n")
			state.reasoningStarted = true
		}
		await onTrace?.(delta.reasoning)
	}
	if (delta.content) {
		if (state.reasoningStarted) {
			await onTrace?.("\n\n")
			state.reasoningStarted = false
		}
		if (onTrace && !state.contentStarted) {
			await onTrace("# Content\n\n")
			state.contentStarted = true
		}
		state.contentChunks.push(delta.content)
		await onContent?.(delta.content)
		await onTrace?.(delta.content)
	}
	if (delta.toolCalls) accumulateToolCallDeltas(state.toolCallAccumulator, delta.toolCalls)
	if (delta.finishReason) state.finishReason = delta.finishReason
}

async function stepSseLine(state: StreamState, line: string, onContent?: (content: string) => Promise<void>, onTrace?: (trace: string) => Promise<void>): Promise<boolean> {
	const parsed = parseSseLine(line)
	if (parsed.type === "done") return false
	if (parsed.type === "ignore") return true
	let json: unknown
	try {
		json = JSON.parse(parsed.payload)
	} catch (error) {
		throw new Error(`Failed to parse SSE data payload as JSON: ${parsed.payload}`, { cause: error })
	}
	const delta = extractDelta(json)
	collectDeltaKeys(json, state.deltaKeysSeen)
	const cachedTokens = extractCachedTokens(json)
	if (cachedTokens !== null) state.cachedTokens = cachedTokens
	await applySseDelta(state, delta, onContent, onTrace)
	return true
}

export interface StreamResult {
	content: string
	toolCallAccumulator: ToolCallAccumulator
	finishReason: string | null
	cachedTokens: number | null
	deltaKeysSeen: Set<string>
}

export async function consumeAiStream(stream: ReadableStream<Uint8Array>, onContent?: (content: string) => Promise<void>, onTrace?: (trace: string) => Promise<void>, onActivity?: () => void): Promise<StreamResult> {
	const state: StreamState = {
		buffer: "",
		contentChunks: [],
		toolCallAccumulator: new Map(),
		finishReason: null,
		cachedTokens: null,
		deltaKeysSeen: new Set(),
		reasoningStarted: false,
		contentStarted: false,
	}

	for await (const chunk of readStreamChunks(stream)) {
		onActivity?.()
		state.buffer += chunk
		const lines = state.buffer.split("\n")
		state.buffer = lines.pop() ?? ""
		for (const line of lines) {
			if (!(await stepSseLine(state, line, onContent, onTrace))) break
		}
	}

	await stepSseLine(state, state.buffer, onContent, onTrace)

	if (state.reasoningStarted) {
		await onTrace?.("\n\n")
	}
	if (state.contentStarted) {
		await onTrace?.("\n\n")
	}

	return { content: state.contentChunks.join(""), toolCallAccumulator: state.toolCallAccumulator, finishReason: state.finishReason, cachedTokens: state.cachedTokens, deltaKeysSeen: state.deltaKeysSeen }
}

export function buildAiToolCalls(accumulator: ToolCallAccumulator): AiToolCall[] {
	const calls: AiToolCall[] = []
	for (const [, entry] of accumulator) {
		calls.push({ id: entry.id, type: "function", function: { name: entry.name, arguments: entry.arguments } })
	}
	return calls
}
