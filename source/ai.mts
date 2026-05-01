import { buildAgentPrompt, type Agent } from "./agents.mts"
import type { DebugWriter } from "./debug.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
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

export type AiFetch = (prompt: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>

export function createAiFetch(configuration: AiConfiguration): AiFetch {
	return async function aiFetch(prompt: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
		const url = `${configuration.apiUrl}/chat/completions`
		const headers: Record<string, string> = { "Content-Type": "application/json" }
		if (configuration.apiKey) headers["Authorization"] = `Bearer ${configuration.apiKey}`
		const body = JSON.stringify({
			model: configuration.model,
			messages: [{ role: "user", content: prompt }],
			stream: true,
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

export function parseSseLine(line: string): { type: "content"; payload: string } | { type: "done" } | { type: "ignore" } {
	const trimmed = line.trim()
	if (trimmed === "") return { type: "ignore" }
	if (!trimmed.startsWith("data: ")) return { type: "ignore" }

	const payload = trimmed.slice(6)
	if (payload === "[DONE]") return { type: "done" }

	return { type: "content", payload }
}

export interface DeltaText {
	content?: string
	reasoning?: string
}

function isReasoningDetail(value: unknown): value is { text: string } {
	if (typeof value !== "object" || value === null) return false
	if (!("text" in value) || typeof value.text !== "string") return false
	return true
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
	} else if ("reasoning_details" in firstChoice.delta && Array.isArray(firstChoice.delta.reasoning_details)) {
		const details: unknown[] = firstChoice.delta.reasoning_details
		const reasoningText = details
			.filter(isReasoningDetail)
			.map((d: { text: string }) => d.text)
			.join("")
		if (reasoningText !== "") result.reasoning = reasoningText
	}

	return result
}

const IDLE_TIMEOUT_MILLISECONDS = 300_000

export async function callAiApi(dependencies: { aiFetch: AiFetch }, prompt: string, onContent?: (content: string) => void, onReasoning?: (reasoning: string) => void): Promise<string> {
	const controller = new AbortController()
	let idleTimer: ReturnType<typeof setTimeout> | undefined = undefined

	function resetIdleTimer(): void {
		if (idleTimer !== undefined) clearTimeout(idleTimer)
		idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MILLISECONDS)
	}

	resetIdleTimer()

	const stream = await dependencies.aiFetch(prompt, controller.signal)
	resetIdleTimer()

	const chunks: string[] = []
	let buffer = ""

	const iterator = readStreamChunks(stream)[Symbol.asyncIterator]()

	while (true) {
		const result = await iterator.next()
		if (result.done) break

		resetIdleTimer()

		buffer += result.value
		const lines = buffer.split("\n")
		buffer = lines.pop() ?? ""

		for (const line of lines) {
			const parsed = parseSseLine(line)
			if (parsed.type === "done") {
				clearTimeout(idleTimer)
				return chunks.join("")
			}
			if (parsed.type === "ignore") continue

			const json: unknown = JSON.parse(parsed.payload)
			const delta = extractDelta(json)
			if (delta.reasoning) onReasoning?.(delta.reasoning)
			if (delta.content) {
				chunks.push(delta.content)
				onContent?.(delta.content)
			}
		}
	}

	if (buffer.trim() !== "") {
		const parsed = parseSseLine(buffer)
		if (parsed.type === "content") {
			const json: unknown = JSON.parse(parsed.payload)
			const delta = extractDelta(json)
			if (delta.reasoning) onReasoning?.(delta.reasoning)
			if (delta.content) {
				chunks.push(delta.content)
				onContent?.(delta.content)
			}
		}
	}

	clearTimeout(idleTimer)
	return chunks.join("")
}

async function runAgent(dependencies: { aiFetch: AiFetch; logger: Logger; debugWriter: DebugWriter }, agent: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs?: Map<string, string>): Promise<string> {
	dependencies.logger.log(`Building prompt for ${agent.name}`)
	const prompt = buildAgentPrompt(agent, baseCommitContext, diffText, agentInputs)
	dependencies.debugWriter.writePrompt(agent.name, prompt)
	dependencies.logger.log(`Running agent ${agent.name}`)
	const onContent = (content: string) => dependencies.debugWriter.writeContent(agent.name, content)
	const onReasoning = (reasoning: string) => dependencies.debugWriter.writeReasoning(agent.name, reasoning)
	const output = await callAiApi({ aiFetch: dependencies.aiFetch }, prompt, onContent, onReasoning)
	return output
}

async function runAgents(dependencies: { aiFetch: AiFetch; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[]): Promise<Map<string, string>> {
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

async function runAggregator(dependencies: { aiFetch: AiFetch; logger: Logger; debugWriter: DebugWriter }, aggregator: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs: Map<string, string>): Promise<string> {
	const prompt = buildAgentPrompt(aggregator, baseCommitContext, diffText, agentInputs)
	dependencies.logger.log(`Running agent: ${aggregator.name}`)
	dependencies.debugWriter.writePrompt(aggregator.name, prompt)
	const onContent = (content: string) => dependencies.debugWriter.writeContent(aggregator.name, content)
	const onReasoning = (reasoning: string) => dependencies.debugWriter.writeReasoning(aggregator.name, reasoning)
	const output = await callAiApi({ aiFetch: dependencies.aiFetch }, prompt, onContent, onReasoning)
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

export async function analyze(dependencies: { aiFetch: AiFetch; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], aggregator: Agent): Promise<AiReviewResult> {
	dependencies.logger.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)

	const agentOutputs = await runAgents(dependencies, baseCommitContext, diffText, agents)
	const finalOutput = await runAggregator(dependencies, aggregator, baseCommitContext, diffText, agentOutputs)

	dependencies.logger.log("Agent analysis complete")

	return parseAggregatorOutput(finalOutput)
}
