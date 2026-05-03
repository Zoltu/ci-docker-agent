import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"

export interface DebugWriter {
	writePrompt: (agentName: string, prompt: string) => void
	writeTrace: (agentName: string, text: string) => void
	writeContent: (agentName: string, content: string) => void
}

export function createDebugWriter(debugDirectory: string): DebugWriter {
	if (existsSync(debugDirectory)) {
		const entries = readdirSync(debugDirectory)
		const nonMarkdownEntries = entries.filter(entry => !entry.toLowerCase().endsWith(".md"))
		if (nonMarkdownEntries.length > 0) {
			throw new Error(
				`Debug directory "${debugDirectory}" contains non-markdown files, which suggests a misconfiguration. ` +
				`Remove or relocate these files: ${nonMarkdownEntries.join(", ")}`
			)
		}
		for (const entry of entries) {
			rmSync(join(debugDirectory, entry), { recursive: true, force: true })
		}
	}
	mkdirSync(debugDirectory, { recursive: true })

	return {
		writePrompt(agentName: string, prompt: string): void {
			writeFileSync(join(debugDirectory, `${agentName}-prompt.md`), prompt)
		},
		writeTrace(agentName: string, text: string): void {
			appendFileSync(join(debugDirectory, `${agentName}-trace.md`), text)
		},
		writeContent(agentName: string, content: string): void {
			appendFileSync(join(debugDirectory, `${agentName}-output.md`), content)
		},
	}
}
