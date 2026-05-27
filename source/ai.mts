import { buildAgentPrompt, type Agent } from "./agents.mts"
import { agentLoop, type Fetch, type AgentLoopResult } from "./agent-loop.mts"
import type { CompletionsMessage } from "./completions.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { SpawnGit } from "./diff.mts"
import type { DebugWriter } from "./debug.mts"
import type { LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
import { createTools } from "./tool-executor.mts"
import { includes, isReadonlyArray, sleepWithSignal } from "./typescript-helpers.mts"

export interface AiConfiguration {
	apiUrl: string
	model: string
	apiKey?: string
}

export function parseAiConfiguration(environment: Record<string, string | undefined>): AiConfiguration {
	const apiUrl = environment.AI_API_URL
	if (!apiUrl) throw new Error("AI_API_URL is required")

	if (!URL.canParse(apiUrl)) throw new Error(`AI_API_URL is not a valid URL: ${apiUrl}`)
	const url = new URL(apiUrl)
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`AI_API_URL must use http: or https: protocol, got: ${url.protocol}`)

	const model = environment.AI_MODEL
	if (!model) throw new Error("AI_MODEL is required")

	const apiKey = environment.AI_API_KEY
	return { apiUrl, model, apiKey }
}

export function createFetch(configuration: AiConfiguration): Fetch {
	const MAX_RETRIES = 5
	const INITIAL_BACKOFF_MILLISECONDS = 1_000
	const MAX_BACKOFF_MILLISECONDS = 30_000

	return async (signal, body, headers) => {
		const url = `${configuration.apiUrl.replace(/\/$/, "")}/chat/completions`
		const requestHeaders: Record<string, string> = { ...headers }
		if (configuration.apiKey) requestHeaders["Authorization"] = `Bearer ${configuration.apiKey}`

		let lastResponse: Response | undefined
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				const backoff = Math.min(INITIAL_BACKOFF_MILLISECONDS * Math.pow(2, attempt - 1), MAX_BACKOFF_MILLISECONDS)
				const jitter = backoff * (0.5 + Math.random() * 0.5)
				await sleepWithSignal(jitter, signal)
			}

			lastResponse = await fetch(url, { method: "POST", headers: requestHeaders, body, signal })

			if (lastResponse.status === 429 || (lastResponse.status >= 500 && lastResponse.status <= 599)) {
				if (attempt === MAX_RETRIES) return lastResponse
				if (lastResponse.status === 429) {
					const retryAfter = lastResponse.headers.get("Retry-After")
					const delay = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : Math.min(INITIAL_BACKOFF_MILLISECONDS * Math.pow(2, attempt), MAX_BACKOFF_MILLISECONDS)
					await sleepWithSignal(delay, signal)
				}
				continue
			}

			return lastResponse
		}

		return lastResponse!
	}
}

function isContextWindowExceededError(error: unknown): error is Error {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	return message.includes("context length") || message.includes("context window") || message.includes("maximum context") || message.includes("token limit")
}

async function runAgent(dependencies: { fetch: Fetch; spawnGit: SpawnGit; logger: Logger; debugWriter: DebugWriter }, agent: Agent, baseCommit: string, baseCommitContext: BaseCommitContext, diffText: string, model: string, agentInputs?: Map<string, string>): Promise<string> {
	dependencies.logger.log(`Building prompt for ${agent.name}`)
	const promptMessages = buildAgentPrompt(agent, baseCommitContext, diffText, agentInputs)
	const debugText = promptMessages.map(m => `--- ${m.role} ---\n${m.content}`).join("\n\n")
	await dependencies.debugWriter.writePrompt(agent.name, debugText)
	dependencies.logger.log(`Running agent ${agent.name}`)

	const tools = createTools(dependencies, baseCommit)
	const messages: CompletionsMessage[] = [...promptMessages]
	const onTrace = (trace: string) => dependencies.debugWriter.writeTrace(agent.name, trace)

	let result: AgentLoopResult
	try {
		const generator = agentLoop(dependencies, { model, messages, tools, maxTokens: 100_000 })

		let reasoningStarted = false
		let contentStarted = false

		while (true) {
			const iteratorResult = await generator.next()
			if (iteratorResult.done) {
				result = iteratorResult.value
				break
			}

			const event = iteratorResult.value
			if (event.type === "delta") {
				const reasoning = event.delta.reasoning ?? event.delta.reasoning_content
				if (reasoning) {
					if (contentStarted) {
						await onTrace("\n\n")
						contentStarted = false
					}
					if (!reasoningStarted) {
						await onTrace("# Reasoning\n\n")
						reasoningStarted = true
					}
					await onTrace(reasoning)
				}
				if (event.delta.content) {
					if (reasoningStarted) {
						await onTrace("\n\n")
						reasoningStarted = false
					}
					if (!contentStarted) {
						await onTrace("# Content\n\n")
						contentStarted = true
					}
					await onTrace(event.delta.content)
				}
			} else if (event.type === "tool_call") {
				await onTrace(`# Tool Call: ${event.toolCall.function.name}\n\n${event.toolCall.function.arguments}\n\n`)
			} else if (event.type === "tool_result") {
				await onTrace(`# Tool Result: ${event.name}\n\n${event.result}\n\n`)
			} else if (event.type === "completion") {
				if (reasoningStarted || contentStarted) {
					await onTrace("\n\n")
					reasoningStarted = false
					contentStarted = false
				}
				if (event.finishReason) {
					await onTrace(`<!-- finish_reason: ${event.finishReason} -->\n`)
				}
			}
		}
	} catch (error) {
		if (isContextWindowExceededError(error)) {
			throw new Error(`Context window exceeded. Original error: ${error.message}`, { cause: error })
		}
		throw error
	}

	const lastMessage = result.messages.at(-1)
	if (lastMessage === undefined) throw new Error("Agent loop returned no messages")
	if (lastMessage.role !== "assistant") throw new Error(`Expected last message role to be "assistant", got "${lastMessage.role}"`)
	if (lastMessage.content === null) throw new Error("Agent loop returned null content for the last assistant message")

	return lastMessage.content
}

async function runAgents(dependencies: { fetch: Fetch; spawnGit: SpawnGit; logger: Logger; debugWriter: DebugWriter }, baseCommit: string, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], model: string): Promise<Map<string, string>> {
	const promises = agents.map(async agent => [agent.name, await runAgent(dependencies, agent, baseCommit, baseCommitContext, diffText, model)] as const)
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
	if (!("comments" in data) || !isReadonlyArray(data.comments)) return false
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

export async function analyze(dependencies: { fetch: Fetch; spawnGit: SpawnGit; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], aggregator: Agent, baseCommit: string, model: string,): Promise<AiReviewResult> {
	dependencies.logger.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)

	const agentOutputs = await runAgents(dependencies, baseCommit, baseCommitContext, diffText, agents, model)
	const finalOutput = await runAgent(dependencies, aggregator, baseCommit, baseCommitContext, diffText, model, agentOutputs)

	dependencies.logger.log("Agent analysis complete")

	return parseAggregatorOutput(finalOutput)
}
