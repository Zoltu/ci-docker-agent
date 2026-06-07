import { appendFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface DebugWriter {
	writePrompt: (agentName: string, prompt: string) => Promise<void>
	writeTrace: (agentName: string, text: string) => Promise<void>
}

// Matches only the two file shapes this writer produces.
const DEBUG_FILE_PATTERN = /^.+-(?:prompt|trace)\.md$/

export async function createDebugWriter(debugDirectory: string): Promise<DebugWriter> {
	// /debug directory is created by docker if a volume isn't provided
	const entries = await readdir(debugDirectory)
	const unexpectedEntries = entries.filter(entry => !DEBUG_FILE_PATTERN.test(entry))
	if (unexpectedEntries.length > 0) {
		throw new Error(`Debug directory "${debugDirectory}" contains files that don't match ${DEBUG_FILE_PATTERN}: ${unexpectedEntries.join(", ")}. This usually means the debug volume is mounted to a directory that also holds unrelated files. Mount an empty (or debug-only) directory.`)
	}
	for (const entry of entries) {
		await rm(join(debugDirectory, entry), { recursive: true, force: true })
	}

	return {
		writePrompt: async (agentName: string, prompt: string) => await writeFile(join(debugDirectory, `${agentName}-prompt.md`), prompt),
		writeTrace: async (agentName: string, text: string) => await appendFile(join(debugDirectory, `${agentName}-trace.md`), text),
	}
}
