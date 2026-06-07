import type { DebugWriter } from "./debug.mts"

export interface TraceWriter {
	readonly delta: (reasoning: string | undefined, content: string | undefined) => Promise<void>
	readonly toolCall: (name: string, args: string) => Promise<void>
	readonly toolResult: (name: string, result: string) => Promise<void>
	readonly completion: (finishReason: string | undefined) => Promise<void>
}

export function createTraceWriter(debugWriter: DebugWriter, agentName: string): TraceWriter {
	const onTrace = (text: string) => debugWriter.writeTrace(agentName, text)
	let reasoningStarted = false
	let contentStarted = false

	return {
		async delta(reasoning, content) {
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
			if (content) {
				if (reasoningStarted) {
					await onTrace("\n\n")
					reasoningStarted = false
				}
				if (!contentStarted) {
					await onTrace("# Content\n\n")
					contentStarted = true
				}
				await onTrace(content)
			}
		},
		async toolCall(name, args) {
			await onTrace(`# Tool Call: ${name}\n\n${args}\n\n`)
		},
		async toolResult(name, result) {
			await onTrace(`# Tool Result: ${name}\n\n${result}\n\n`)
		},
		async completion(finishReason) {
			if (reasoningStarted || contentStarted) {
				await onTrace("\n\n")
				reasoningStarted = false
				contentStarted = false
			}
			if (finishReason !== undefined) {
				await onTrace(`<!-- finish_reason: ${finishReason} -->\n`)
			}
		},
	}
}
