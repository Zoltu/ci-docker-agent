import { buildAgentPrompt, type Agent } from "./agents.mts"
import { createAiFetch, parseAiConfiguration, type AiFetch, type AiMessage, type AiToolCall, type AiConfiguration } from "./ai-fetch.mts"
export { createAiFetch, parseAiConfiguration, type AiFetch, type AiMessage, type AiToolCall, type AiConfiguration }
import { consumeAiStream, isContextWindowExceededError, buildAiToolCalls } from "./ai-stream.mts"
import type { DebugWriter } from "./debug.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
import type { ToolCallRequest, ToolCallResult, ToolDefinition, ToolExecutor } from "./tool-executor.mts"
import { includes } from "./typescript-helpers.mts"

const IDLE_TIMEOUT_MILLISECONDS = 300_000

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

export async function callAiApi(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor }, prompt: string, onTrace?: (trace: string) => Promise<void>): Promise<string> {
	const messages: AiMessage[] = [{ role: "user", content: prompt }]

	while (true) {
		const controller = new AbortController()
		const idleTimer = createIdleTimer(controller)
		idleTimer.reset()

		const stream = await fetchAiStreamResponse(dependencies.aiFetch, messages, dependencies.toolExecutor.definitions, controller.signal)
		idleTimer.reset()

		const result = await consumeAiStream(stream, onTrace, idleTimer.reset)
		idleTimer.cleanup()

		if (result.finishReason !== null) onTrace?.(`<!-- finish_reason: ${result.finishReason} -->\n`)

		if (result.finishReason === null) {
			throw new Error("AI stream ended without a finish reason. The response may have been interrupted before completion.")
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
			onTrace?.(`# Tool Call: ${toolCall.function.name}\n\n${toolCall.function.arguments}\n\n`)

			const toolResult: ToolCallResult = await dependencies.toolExecutor.execute(request)
			onTrace?.(`# Tool Result: ${toolCall.function.name}\n\n${toolResult.content}\n\n`)

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
	await dependencies.debugWriter.writePrompt(agent.name, prompt)
	dependencies.logger.log(`Running agent ${agent.name}`)
	const onTrace = (trace: string) => dependencies.debugWriter.writeTrace(agent.name, trace)
	return await callAiApi({ aiFetch: dependencies.aiFetch, toolExecutor: dependencies.toolExecutor }, prompt, onTrace)
}

async function runAgents(dependencies: { aiFetch: AiFetch; toolExecutor: ToolExecutor; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[]): Promise<Map<string, string>> {
	const promises = agents.map(async agent => [agent.name, await runAgent(dependencies, agent, baseCommitContext, diffText)] as const)
	const reviewResults = await Promise.all(promises)
	return new Map(reviewResults)
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
	const finalOutput = await runAgent(dependencies, aggregator, baseCommitContext, diffText, agentOutputs)

	dependencies.logger.log("Agent analysis complete")

	return parseAggregatorOutput(finalOutput)
}
