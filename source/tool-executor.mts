import type { SpawnGit } from "./diff.mts"
import type { Tool } from "./agent-loop.mts"
import { isBinaryExtension, isContentText } from "./text-detection.mts"

interface ReadFileArguments {
	path: string
	start_line?: number
	end_line?: number
}

function isValidReadFileArguments(args: unknown): args is ReadFileArguments {
	if (typeof args !== "object" || args === null) return false
	if (!("path" in args) || typeof args.path !== "string" || args.path === "") return false
	if ("start_line" in args && args.start_line !== undefined) {
		if (typeof args.start_line !== "number" || !Number.isInteger(args.start_line) || args.start_line < 1) return false
	}
	if ("end_line" in args && args.end_line !== undefined) {
		if (typeof args.end_line !== "number" || !Number.isInteger(args.end_line) || args.end_line < 1) return false
	}
	if ("start_line" in args && "end_line" in args && typeof args.start_line === "number" && typeof args.end_line === "number" && args.end_line < args.start_line) return false
	return true
}

function isValidSearchFilesArguments(args: unknown): args is { pattern: string; path?: string } {
	if (typeof args !== "object" || args === null) return false
	if (!("pattern" in args) || typeof args.pattern !== "string" || args.pattern === "") return false
	if ("path" in args && args.path !== undefined && typeof args.path !== "string") return false
	return true
}

interface SearchMatch {
	path: string
	line: number
	content: string
}

const MAX_SEARCH_RESULTS = 50

function parseGitGrepOutput(output: string): SearchMatch[] {
	if (output === "") return []
	const matches: SearchMatch[] = []
	const lines = output.split("\n")
	for (const line of lines) {
		if (line === "") continue
		const firstColon = line.indexOf(":")
		if (firstColon === -1) continue
		const afterFirstColon = firstColon + 1
		const secondColon = line.indexOf(":", afterFirstColon)
		if (secondColon === -1) continue
		const filePath = line.slice(0, firstColon)
		const lineStr = line.slice(afterFirstColon, secondColon)
		const content = line.slice(secondColon + 1)
		const lineNum = Number.parseInt(lineStr, 10)
		if (!Number.isInteger(lineNum) || lineNum < 1) continue
		matches.push({ path: filePath, line: lineNum, content })
	}
	return matches
}

function formatSearchResults(matches: SearchMatch[]): string {
	if (matches.length === 0) return "No matches found."

	const truncated = matches.length > MAX_SEARCH_RESULTS
	const displayed = truncated ? matches.slice(0, MAX_SEARCH_RESULTS) : matches

	const lines: string[] = []
	for (const match of displayed) {
		lines.push(`${match.path}:${match.line}:${match.content}`)
	}

	if (truncated) {
		lines.push(`\nShowing ${MAX_SEARCH_RESULTS} of ${matches.length} matches. Use a more specific pattern or path to narrow results.`)
	}

	return lines.join("\n")
}

export function createTools(dependencies: { spawnGit: SpawnGit }, baseCommit: string): Tool[] {
	const { spawnGit } = dependencies

	return [
		{
			name: "read_file",
			description: "Read the contents of a file from the base commit (before the changes in the diff). The path must be one of the files listed in the repository files section. To understand the current state of a changed file, apply the diff to the base version. Optionally specify a line range to read a subset of the file.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "The path of the file to read, relative to the repository root",
					},
					start_line: {
						type: "number",
						description: "The 1-indexed line number to start reading from. If omitted, starts from line 1.",
					},
					end_line: {
						type: "number",
						description: "The 1-indexed line number to read up to (inclusive). If omitted, reads to the end of the file. If greater than the file length, reads to the end of the file.",
					},
				},
				required: ["path"],
			},
			execute: async (args: string): Promise<string> => {
				// Intentional deviation from fail-fast rule: returning an error string lets the AI self-correct its tool call arguments
				let parsed: unknown
				try {
					parsed = JSON.parse(args)
				} catch {
					return `Invalid JSON in tool call arguments: ${args}`
				}

				if (!isValidReadFileArguments(parsed)) {
					return `Invalid arguments for read_file. Expected { "path": string, "start_line"?: number, "end_line"?: number }. Got: ${args}`
				}

				if (isBinaryExtension(parsed.path)) {
					return `File is binary and cannot be displayed: ${parsed.path}`
				}

				const result = await spawnGit(["show", `${baseCommit}:${parsed.path}`])
				if (result.exitCode !== 0) {
					return `File not found: ${parsed.path}`
				}

				if (!isContentText(result.stdout)) {
					return `File is binary and cannot be displayed: ${parsed.path}`
				}

				if (parsed.start_line === undefined && parsed.end_line === undefined) {
					return result.stdout
				}

				const allLines = result.stdout.split("\n")
				if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop()

				const effectiveStart = parsed.start_line ?? 1
				if (effectiveStart > allLines.length) {
					return `File ${parsed.path} has ${allLines.length} lines, start_line ${effectiveStart} is past the end`
				}

				const effectiveEnd = parsed.end_line !== undefined ? Math.min(parsed.end_line, allLines.length) : allLines.length
				const sliced = allLines.slice(effectiveStart - 1, effectiveEnd)
				const header = `Lines ${effectiveStart}-${effectiveEnd} of ${parsed.path}:`
				return `${header}\n${sliced.join("\n")}`
			},
		},
		{
			name: "search_files",
			description: "Search the codebase at the base commit using a regular expression pattern. Returns matching file paths, line numbers, and matching line content. Uses extended regex syntax (ERE). Searches all text files in the repository.",
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "Extended regular expression (ERE) pattern to search for",
					},
					path: {
						type: "string",
						description: "Optional path prefix to limit search scope (e.g., 'src/' or 'config.json')",
					},
				},
				required: ["pattern"],
			},
			execute: async (args: string): Promise<string> => {
				// Intentional deviation from fail-fast rule: returning an error string lets the AI self-correct its tool call arguments
				let parsed: unknown
				try {
					parsed = JSON.parse(args)
				} catch {
					return `Invalid JSON in tool call arguments: ${args}`
				}

				if (!isValidSearchFilesArguments(parsed)) {
					return `Invalid arguments for search_files. Expected { "pattern": string, "path"?: string }. Got: ${args}`
				}

				const gitGrepArgs = ["grep", "-n", "-E", "-I", "-e", parsed.pattern, baseCommit]
				if (parsed.path) gitGrepArgs.push("--", parsed.path)

				const result = await spawnGit(gitGrepArgs)

				if (result.exitCode === 1) {
					return "No matches found."
				}

				if (result.exitCode !== 0) {
					return `Search failed: ${result.stderr.trim() || result.stdout.trim()}`
				}

				const matches = parseGitGrepOutput(result.stdout)
				return formatSearchResults(matches)
			},
		},
	]
}
