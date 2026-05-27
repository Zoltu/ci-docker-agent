import { appendFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface DebugWriter {
	writePrompt: (agentName: string, prompt: string) => Promise<void>
	writeTrace: (agentName: string, text: string) => Promise<void>
}

export async function createDebugWriter(debugDirectory: string): Promise<DebugWriter> {
	// /debug directory is created by docker if a volume isn't provided
	const entries = await readdir(debugDirectory)
	const nonMarkdownEntries = entries.filter(entry => !entry.toLowerCase().endsWith(".md"))
	if (nonMarkdownEntries.length > 0) {
		throw new Error(`Debug directory "${debugDirectory}" contains non-markdown files, which suggests a misconfiguration. Remove or relocate these files: ${nonMarkdownEntries.join(", ")}`)
	}
	for (const entry of entries) {
		await rm(join(debugDirectory, entry), { recursive: true, force: true })
	}

	return {
		writePrompt: async (agentName: string, prompt: string) => await writeFile(join(debugDirectory, `${agentName}-prompt.md`), prompt),
		writeTrace: async (agentName: string, text: string) => await appendFile(join(debugDirectory, `${agentName}-trace.md`), text),
	}
}
