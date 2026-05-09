import type { ToolDefinition } from "./tool-executor.mts"

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

export interface AiToolCall {
	id: string
	type: "function"
	function: { name: string; arguments: string }
}

export interface AiMessage {
	role: "user" | "assistant" | "tool"
	content: string | null
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
			stream_options: { include_usage: true },
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
