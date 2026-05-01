import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"

export interface DebugWriter {
	writePrompt: (agentName: string, prompt: string) => void
	writeContent: (agentName: string, content: string) => void
	writeReasoning: (agentName: string, reasoning: string) => void
}

export function createDebugWriter(debugDirectory: string): DebugWriter {
	mkdirSync(debugDirectory, { recursive: true })

	return {
		writePrompt(agentName: string, prompt: string): void {
			writeFileSync(join(debugDirectory, `${agentName}-prompt.md`), prompt)
		},
		writeContent(agentName: string, content: string): void {
			appendFileSync(join(debugDirectory, `${agentName}-output.md`), content)
		},
		writeReasoning(agentName: string, reasoning: string): void {
			appendFileSync(join(debugDirectory, `${agentName}-reasoning.md`), reasoning)
		},
	}
}
