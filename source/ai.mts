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
import { includes, isReadonlyArray, normalizeFetchError, sleepWithSignal } from "./typescript-helpers.mts"

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

const INITIAL_BACKOFF_MILLISECONDS = 1_000
const MAX_BACKOFF_MILLISECONDS = 30_000

// Stays under the agent-loop idle timeout (300s) so a long reset window can't trip the composite abort mid-sleep.
const MAX_SINGLE_WAIT_MILLISECONDS = 240_000

const RETRY_DEADLINE_MILLISECONDS = 300_000

// Below this, X-RateLimit-Reset is seconds-until-reset; at/above, it's a Unix epoch timestamp.
const EPOCH_THRESHOLD = 1_000_000_000

const MAX_RETRIES = 10

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>
export type Random = () => number
export type Now = () => number

export interface FetchDependencies {
	readonly httpFetch: Fetch
	readonly sleep: Sleep
	readonly random: Random
	readonly now: Now
}

export function createHttpFetch(configuration: AiConfiguration): Fetch {
	return async (signal, body, headers) => {
		const url = `${configuration.apiUrl.replace(/\/$/, "")}/chat/completions`
		const requestHeaders: Record<string, string> = { ...headers }
		if (configuration.apiKey) requestHeaders["Authorization"] = `Bearer ${configuration.apiKey}`
		return normalizeFetchError(fetch(url, { method: "POST", headers: requestHeaders, body, signal }))
	}
}

export function createSleep(): Sleep {
	return sleepWithSignal
}

export function createRandom(): Random {
	return () => Math.random()
}

export function createNow(): Now {
	return () => Date.now()
}

interface RetryDelayInput {
	readonly retryAfter: string | null
	readonly rateLimitReset: string | null
	readonly attempt: number
	readonly deadlineRemainingMilliseconds: number
	readonly now: number
	readonly random: number
}

// Precedence: Retry-After > X-RateLimit-Reset (epoch or duration, heuristic) > exponential backoff.
function computeRetryDelay(input: RetryDelayInput): number | null {
	if (input.deadlineRemainingMilliseconds <= 0) return null

	let computed: number | undefined

	if (input.retryAfter !== null) {
		const seconds = Number.parseInt(input.retryAfter, 10)
		if (Number.isFinite(seconds) && seconds >= 0) computed = seconds * 1000
	}

	if (computed === undefined && input.rateLimitReset !== null) {
		const value = Number.parseFloat(input.rateLimitReset)
		if (Number.isFinite(value) && value >= 0) {
			const milliseconds = value < EPOCH_THRESHOLD
				? value * 1000
				: Math.max(0, value - input.now / 1000) * 1000
			computed = milliseconds
		}
	}

	if (computed === undefined) {
		const backoff = INITIAL_BACKOFF_MILLISECONDS * Math.pow(2, input.attempt)
		computed = Math.min(backoff, MAX_BACKOFF_MILLISECONDS)
	}

	const capped = Math.min(computed, MAX_SINGLE_WAIT_MILLISECONDS, input.deadlineRemainingMilliseconds)
	return capped * (0.5 + input.random * 0.5)
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599)
}

async function fetchWithRetries(dependencies: FetchDependencies, signal: AbortSignal, body: string, headers?: Record<string, string>): Promise<Response> {
	const deadline = dependencies.now() + RETRY_DEADLINE_MILLISECONDS
	let lastResponse: Response | undefined
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			const now = dependencies.now()
			const delay = computeRetryDelay({
				retryAfter: lastResponse?.headers.get("Retry-After") ?? null,
				rateLimitReset: lastResponse?.headers.get("X-RateLimit-Reset") ?? null,
				attempt: attempt - 1,
				deadlineRemainingMilliseconds: deadline - now,
				now,
				random: dependencies.random(),
			})
			if (delay === null) {
				if (lastResponse === undefined) throw new Error("Retry deadline exhausted before any response was received")
				return lastResponse
			}
			await dependencies.sleep(delay, signal)
		}

		lastResponse = await dependencies.httpFetch(signal, body, headers)

		if (isRetryableStatus(lastResponse.status)) {
			if (attempt === MAX_RETRIES) return lastResponse
			if (dependencies.now() >= deadline) return lastResponse
			continue
		}

		return lastResponse
	}

	throw new Error("createFetch retry loop exited without returning a response")
}

export function createFetch(dependencies: FetchDependencies): Fetch {
	return (signal, body, headers) => fetchWithRetries(dependencies, signal, body, headers)
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
