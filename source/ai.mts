import { agentLoop, type AgentLoopResult, type Fetch, type OutputValidator } from "./agent-loop.mts"
import { buildAgentPrompt, type Agent } from "./agents.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { CompletionsMessage } from "./completions.mts"
import type { TryResult } from "./typescript-helpers.mts"
import type { DebugWriter } from "./debug.mts"
import type { SpawnGit } from "./diff.mts"
import type { LineComment } from "./github-types.mts"
import { SIDES } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import { readReasoningFromDelta } from "./reasoning.mts"
import type { AiReviewResult } from "./review.mts"
import { createTools } from "./tool-executor.mts"
import { createTraceWriter } from "./trace-writer.mts"
import { includes, isReadonlyArray, sleepWithSignal } from "./typescript-helpers.mts"

export type AggregatorSubmitResult = { kind: "ok" } | { kind: "retry"; feedback: string } | { kind: "fatal"; message: string }

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

async function runAgent(dependencies: { fetch: Fetch; spawnGit: SpawnGit; logger: Logger; debugWriter: DebugWriter }, agent: Agent, baseCommit: string, baseCommitContext: BaseCommitContext, diffText: string, model: string, profile: ProviderProfile, agentInputs?: Map<string, string>, outputValidator?: OutputValidator): Promise<string> {
	dependencies.logger.log(`Building prompt for ${agent.name}`)
	const promptMessages = buildAgentPrompt(agent, baseCommitContext, diffText, agentInputs)
	const debugText = promptMessages.map(m => `--- ${m.role} ---\n${m.content}`).join("\n\n")
	await dependencies.debugWriter.writePrompt(agent.name, debugText)
	dependencies.logger.log(`Running agent ${agent.name}`)

	const tools = createTools(dependencies, baseCommit)
	const messages: CompletionsMessage[] = [...promptMessages]
	const traceWriter = createTraceWriter(dependencies.debugWriter, agent.name)

	const generator = agentLoop(dependencies, model, messages, tools, profile, undefined, outputValidator)

	let result: AgentLoopResult
	while (true) {
		const iteratorResult = await generator.next()
		if (iteratorResult.done) {
			result = iteratorResult.value
			break
		}

		const event = iteratorResult.value
		switch (event.type) {
			case "delta":
				await traceWriter.delta(readReasoningFromDelta(event.delta, profile), event.delta.content ?? undefined)
				break
			case "tool_call":
				await traceWriter.toolCall(event.toolCall.function.name, event.toolCall.function.arguments)
				break
			case "tool_result":
				await traceWriter.toolResult(event.name, event.result)
				break
			case "completion":
				await traceWriter.completion(event.finishReason)
				break
		}
	}

	const lastMessage = result.messages.at(-1)
	if (lastMessage === undefined) throw new Error("Agent loop returned no messages")
	if (lastMessage.role !== "assistant") throw new Error(`Expected last message role to be "assistant", got "${lastMessage.role}"`)
	if (!lastMessage.content) throw new Error("Agent loop returned empty or missing content for the last assistant message")

	return lastMessage.content
}

async function runAgents(dependencies: { fetch: Fetch; spawnGit: SpawnGit; logger: Logger; debugWriter: DebugWriter }, baseCommit: string, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], model: string, profile: ProviderProfile): Promise<Map<string, string>> {
	const promises = agents.map(async agent => [agent.name, await runAgent(dependencies, agent, baseCommit, baseCommitContext, diffText, model, profile)] as const)
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

function tryParseAggregatorOutput(output: string): TryResult<AiReviewResult> {
	const stripped = output.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "")
	let parsed
	try {
		parsed = JSON.parse(stripped)
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) }
	}
	if (!isValidAiReviewResult(parsed)) return { ok: false, reason: `Parsed output does not match expected shape:\n${output}` }
	return { ok: true, value: parsed }
}

async function aggregatorOutputValidator(submit: ((result: AiReviewResult) => Promise<AggregatorSubmitResult>) | undefined, content: string): Promise<string | null> {
	const parseResult = tryParseAggregatorOutput(content)
	if (!parseResult.ok) {
		return `Your previous output failed JSON parsing and validation:\n${parseResult.reason}`
	}
	if (submit === undefined) return null
	const outcome = await submit(parseResult.value)
	if (outcome.kind === "ok") return null
	if (outcome.kind === "retry") return outcome.feedback
	throw new Error(outcome.message)
}

export async function analyze(dependencies: { fetch: Fetch; spawnGit: SpawnGit; logger: Logger; debugWriter: DebugWriter }, baseCommitContext: BaseCommitContext, diffText: string, agents: Agent[], aggregator: Agent, baseCommit: string, model: string, profile: ProviderProfile, submit?: (result: AiReviewResult) => Promise<AggregatorSubmitResult>): Promise<AiReviewResult> {
	dependencies.logger.log(`Using agents: ${agents.length > 0 ? agents.map(a => a.name).join(", ") : "Default"}`)

	const agentOutputs = await runAgents(dependencies, baseCommit, baseCommitContext, diffText, agents, model, profile)
	const finalOutput = await runAgent(dependencies, aggregator, baseCommit, baseCommitContext, diffText, model, profile, agentOutputs, content => aggregatorOutputValidator(submit, content))

	dependencies.logger.log("Agent analysis complete")

	const result = tryParseAggregatorOutput(finalOutput)
	if (!result.ok) throw new Error(result.reason)
	return result.value
}
