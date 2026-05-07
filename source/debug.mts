import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface DebugWriter {
	writePrompt: (agentName: string, prompt: string) => Promise<void>
	writeTrace: (agentName: string, text: string) => Promise<void>
	writeContent: (agentName: string, content: string) => Promise<void>
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
		writePrompt: async (agentName: string, prompt: string) => await writeFile(join(debugDirectory, `${agentName}-prompt.md`), prompt),
		writeTrace: async (agentName: string, text: string) => await appendFile(join(debugDirectory, `${agentName}-trace.md`), text),
		writeContent: async(agentName: string, content: string) => await appendFile(join(debugDirectory, `${agentName}-output.md`), content),
	}
}
