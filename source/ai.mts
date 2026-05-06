import { buildAgentPrompt, type Agent } from "./agents.mts"
import type { DebugWriter } from "./debug.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
import type { ToolCallRequest, ToolCallResult, ToolDefinition, ToolExecutor } from "./tool-executor.mts"
import { includes } from "./typescript-helpers.mts"

export interface AiConfiguration {
	apiUrl: string
	model: string
	apiKey?: string
}

export function parseAiConfiguration(environment: Record<string, string | undefined>): AiConfiguration {
	const apiUrl = environment.AI_API_URL
	if (!apiUrl) throw new Error("AI_API_URL is required")

	const model = environment.AI_MODEL
	if (!model) throw new Error("AI_MODEL is required")

	const apiKey = environment.AI_API_KEY
	return { apiUrl, model, apiKey }
}

export interface AiToolCall {
	id: string
	type: "function"
	function: { name: string; arguments: string }
}

export interface AiMessage {
	role: "user" | "assistant" | "tool"
	content?: string | null
	tool_calls?: AiToolCall[]
	tool_call_id?: string
}

export type AiFetch = (messages: AiMessage[], tools: ToolDefinition[], signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>

export function createAiFetch(configuration: AiConfiguration): AiFetch {
	return async function aiFetch(messages: AiMessage[], tools: ToolDefinition[], signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
		const url = `${configuration.apiUrl}/chat/completions`
		const headers: Record<string, string> = { "Content-Type": "application/json" }
		if (configuration.apiKey) headers["Authorization"] = `Bearer ${configuration.apiKey}`
		const body = JSON.stringify({
			model: configuration.model,
			messages,
			tools: tools.length > 0 ? tools : undefined,
			stream: true,
			// TODO: This should be a percentage of the context_length of the selected model
			max_tokens: 100_000,
			reasoning: { enabled: true, effort: "high" },
			reasoning_effort: "high",
			venice_parameters: {
				disable_thinking: false,
				strip_thinking_response: false,
			},
		})

		const response = await fetch(url, { method: "POST", headers, body, signal })

		if (!response.ok) {
			const responseBody = await response.text().catch(() => "")
			throw new Error(`AI API request failed: ${response.status} ${response.statusText}${responseBody ? `\n${responseBody}` : ""}`)
		}

		if (!response.body) throw new Error("AI API response has no body")

		return response.body
	}
}

export async function* readStreamChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
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

export function parseSseLine(line: string): { type: "data"; payload: string } | { type: "done" } | { type: "ignore" } {
	const trimmed = line.trim()
	if (trimmed === "") return { type: "ignore" }
	if (!trimmed.startsWith("data: ")) return { type: "ignore" }

	const payload = trimmed.slice(6)
	if (payload === "[DONE]") return { type: "done" }

	return { type: "data", payload }
}

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

export function extractDelta(data: unknown): DeltaText {
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

const RECOGNIZED_DELTA_KEYS = new Set(["content", "reasoning", "reasoning_content", "reasoning_details", "tool_calls", "role"])

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

const IDLE_TIMEOUT_MILLISECONDS = 300_000

interface ToolCallAccumulatorEntry {
	id: string
	name: string
	arguments: string
}

type ToolCallAccumulator = Map<number, ToolCallAccumulatorEntry>

function accumulateToolCallDeltas(accumulator: ToolCallAccumulator, deltas: ToolCallDelta[]): void {
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

function isContextWindowExceededError(error: unknown): boolean {
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
}

function applySseDelta(state: StreamState, delta: DeltaText, onContent?: (content: string) => void, onTrace?: (trace: string) => void): void {
	if (delta.reasoning) {
		if (!state.reasoningStarted) {
			onTrace?.("[Reasoning]\n")
			state.reasoningStarted = true
		}
		onTrace?.(delta.reasoning)
	}
	if (delta.content) {
		if (state.reasoningStarted) {
			onTrace?.("\n\n")
			state.reasoningStarted = false
		}
		state.contentChunks.push(delta.content)
		onContent?.(delta.content)
	}
	if (delta.toolCalls) accumulateToolCallDeltas(state.toolCallAccumulator, delta.toolCalls)
	if (delta.finishReason) state.finishReason = delta.finishReason
}

function stepSseLine(state: StreamState, line: string, onContent?: (content: string) => void, onTrace?: (trace: string) => void): boolean {
	const parsed = parseSseLine(line)
	if (parsed.type === "done") {
		onTrace?.("[Diagnostic] SSE stream sent [DONE]\n")
		return false
	}
	if (parsed.type === "ignore") return true
	const json: unknown = JSON.parse(parsed.payload)
	const delta = extractDelta(json)
	collectDeltaKeys(json, state.deltaKeysSeen)
	const cachedTokens = extractCachedTokens(json)
	if (cachedTokens !== null) state.cachedTokens = cachedTokens
	applySseDelta(state, delta, onContent, onTrace)
	return true
}

interface StreamResult {
	content: string
	toolCallAccumulator: ToolCallAccumulator
	finishReason: string | null
	cachedTokens: number | null
	deltaKeysSeen: Set<string>
}

async function consumeAiStream(stream: ReadableStream<Uint8Array>, onContent?: (content: string) => void, onTrace?: (trace: string) => void, onActivity?: () => void): Promise<StreamResult> {
	const state: StreamState = {
		buffer: "",
		contentChunks: [],
		toolCallAccumulator: new Map(),
		finishReason: null,
		cachedTokens: null,
		deltaKeysSeen: new Set(),
		reasoningStarted: false,
	}

	for await (const chunk of readStreamChunks(stream)) {
		onActivity?.()
		state.buffer += chunk
		const lines = state.buffer.split("\n")
		state.buffer = lines.pop() ?? ""
		for (const line of lines) {
			if (!stepSseLine(state, line, onContent, onTrace)) break
		}
	}

	stepSseLine(state, state.buffer, onContent, onTrace)

	if (state.reasoningStarted) {
		onTrace?.("\n\n")
	}

	return { content: state.contentChunks.join(""), toolCallAccumulator: state.toolCallAccumulator, finishReason: state.finishReason, cachedTokens: state.cachedTokens, deltaKeysSeen: state.deltaKeysSeen }
}

interface IdleTimer {
	reset: () => void
	cleanup: () => void
}

function createIdleTimer(controller: AbortController): IdleTimer {
	let timer: ReturnType<typeof setTimeout> | undefined = undefined
	return {
		reset(): void {
			if (timer !== undefined) clearTimeout(timer)
			timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MILLISECONDS)
		},
		cleanup(): void {
			clearTimeout(timer)
		},
	}
}

function buildAiToolCalls(accumulator: ToolCallAccumulator): AiToolCall[] {
	const calls: AiToolCall[] = []
	for (const [, entry] of accumulator) {
		calls.push({ id: entry.id, type: "function", function: { name: entry.name, arguments: entry.arguments } })
	}
	return calls
}

async function fetchAiStreamResponse(aiFetch: AiFetch, messages: AiMessage[], tools: ToolDefinition[], signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	try {
		return await aiFetch(messages, tools, signal)
	} catch (error) {
		if (isContextWindowExceededError(error)) {
			throw new Error(`Context window exceeded. Original error: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
		}
		throw error
	}
}

export async function callAiApi(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor }, prompt: string, onContent?: (content: string) => void, onTrace?: (trace: string) => void): Promise<string> {
	const messages: AiMessage[] = [{ role: "user", content: prompt }]

	while (true) {
		const controller = new AbortController()
		const idleTimer = createIdleTimer(controller)
		idleTimer.reset()

		const stream = await fetchAiStreamResponse(dependencies.aiFetch, messages, dependencies.toolExecutor.definitions, controller.signal)
		idleTimer.reset()

		const result = await consumeAiStream(stream, onContent, onTrace, idleTimer.reset)
		idleTimer.cleanup()

		onTrace?.(`[Diagnostic] finishReason: ${result.finishReason ?? "none"}\n`)
		onTrace?.(`[Diagnostic] cached_tokens: ${result.cachedTokens ?? "not reported by provider"}\n`)
		const unrecognizedKeys = [...result.deltaKeysSeen].filter(k => !RECOGNIZED_DELTA_KEYS.has(k))
		if (unrecognizedKeys.length > 0) {
			onTrace?.(`[Diagnostic] Unrecognized delta keys: ${unrecognizedKeys.join(", ")}\n`)
		}

		if (result.finishReason === "length") {
			throw new Error("AI response truncated: model reached maximum output token limit (finishReason: length). Consider increasing max_tokens or reducing prompt size.")
		}

		if (result.toolCallAccumulator.size === 0) return result.content

		const assistantToolCalls = buildAiToolCalls(result.toolCallAccumulator)

		messages.push({
			role: "assistant",
			content: result.content || null,
			tool_calls: assistantToolCalls,
		})

		for (const toolCall of assistantToolCalls) {
			const request: ToolCallRequest = { id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments }
			onTrace?.(`[Tool Call: ${toolCall.function.name}]\n${toolCall.function.arguments}\n\n`)

			const toolResult: ToolCallResult = await dependencies.toolExecutor.execute(request)
			onTrace?.(`[Tool Result: ${toolCall.function.name}]\n${toolResult.content}\n\n`)

			messages.push({
				role: "tool",
				tool_call_id: toolResult.toolCallId,
				content: toolResult.content,
			})
		}
	}
}

async function runAgent(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor; logger: Logger; debugWriter: DebugWriter }, agent: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs?: Map<string, string>): Promise<string> {
	dependencies.logger.log(`Building prompt for ${agent.name}`)
	const prompt = buildAgentPrompt(agent, baseCommitContext, diffText, agentInputs)
	dependencies.debugWriter.writePrompt(agent.name, prompt)
	dependencies.logger.log(`Running agent ${agent.name}`)
	const onContent = (content: string) => dependencies.debugWriter.writeContent(agent.name, content)
	const onTrace = (trace: string) => dependencies.debugWriter.writeTrace(agent.name, trace)
	const output = await callAiApi({ aiFetch: dependencies.aiFetch, toolExecutor: dependencies.toolExecutor }, prompt, onContent, onTrace)
	return output
}

async function runAgents(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[]): Promise<Map<string, string>> {
	const reviewResults = await Promise.all(
		agents.map(async agent => {
			try {
				const output = await runAgent(dependencies, agent, baseCommitContext, diffText)
				return [agent.name, output] as const
			} catch (error) {
				const originalMessage = error instanceof Error ? error.message : String(error)
				const wrapped = new Error(`Agent "${agent.name}" failed: ${originalMessage}`, { cause: error })
				throw wrapped
			}
		})
	)

	return new Map(reviewResults)
}

async function runAggregator(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor; logger: Logger; debugWriter: DebugWriter }, aggregator: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs: Map<string, string>): Promise<string> {
	const prompt = buildAgentPrompt(aggregator, baseCommitContext, diffText, agentInputs)
	dependencies.logger.log(`Running agent: ${aggregator.name}`)
	dependencies.debugWriter.writePrompt(aggregator.name, prompt)
	const onContent = (content: string) => dependencies.debugWriter.writeContent(aggregator.name, content)
	const onTrace = (trace: string) => dependencies.debugWriter.writeTrace(aggregator.name, trace)
	const output = await callAiApi({ aiFetch: dependencies.aiFetch, toolExecutor: dependencies.toolExecutor }, prompt, onContent, onTrace)
	return output
}

function isValidLineComment(value: unknown): value is LineComment {
	if (typeof value !== "object") return false
	if (value === null) return false
	if (!("path" in value) || typeof value.path !== "string") return false
	if (!("line" in value) || typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 1) return false
	if (!("side" in value) || typeof value.side !== "string" || !includes(SIDES, value.side)) return false
	if (!("body" in value) || typeof value.body !== "string" || value.body === "") return false
	return true
}

function isValidAiReviewResult(data: unknown): data is AiReviewResult {
	if (typeof data !== "object") return false
	if (data === null) return false
	if (!("body" in data) || typeof data.body !== "string" || data.body === "") return false
	if (!("comments" in data) || !Array.isArray(data.comments)) return false
	if (!data.comments.every(isValidLineComment)) return false
	return true
}

function parseAggregatorOutput(output: string): AiReviewResult {
	const stripped = output.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "")
	let parsed: unknown
	try {
		parsed = JSON.parse(stripped)
	} catch (error) {
		const originalMessage = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to parse aggregator output as JSON: ${originalMessage}\nAggregator output:\n${output}`, { cause: error })
	}
	if (!isValidAiReviewResult(parsed)) throw new Error(`Parsed output does not match expected AiReviewResult shape: ${output}`)
	return parsed
}

export async function analyze(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], aggregator: Agent): Promise<AiReviewResult> {
	dependencies.logger.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)

	const agentOutputs = await runAgents(dependencies, baseCommitContext, diffText, agents)
	const finalOutput = await runAggregator(dependencies, aggregator, baseCommitContext, diffText, agentOutputs)

	dependencies.logger.log("Agent analysis complete")

	return parseAggregatorOutput(finalOutput)
}
