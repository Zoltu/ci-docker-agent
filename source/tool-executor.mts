import type { SpawnGit } from "./diff.mts"
import { isBinaryExtension, isContentText } from "./text-detection.mts"

export interface ToolDefinition {
	type: "function"
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

export interface ToolCallRequest {
	id: string
	name: string
	arguments: string
}

export interface ToolCallResult {
	toolCallId: string
	content: string
}

export interface ToolExecutor {
	definitions: ToolDefinition[]
	execute(toolCall: ToolCallRequest): Promise<ToolCallResult>
}

const READ_FILE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "read_file",
		description: "Read the contents of a file from the base commit (before the changes in the diff). The path must be one of the files listed in the repository files section. To understand the current state of a changed file, apply the diff to the base version.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to read, relative to the repository root",
				},
			},
			required: ["path"],
		},
	},
}

function isValidReadFileArguments(args: unknown): args is { path: string } {
	if (typeof args !== "object" || args === null) return false
	if (!("path" in args) || typeof args.path !== "string" || args.path === "") return false
	return true
}

export function createToolExecutor(spawnGit: SpawnGit, baseCommit: string): ToolExecutor {
	return {
		definitions: [READ_FILE_TOOL],
		async execute(toolCall: ToolCallRequest): Promise<ToolCallResult> {
			if (toolCall.name === "read_file") {
				let parsed: unknown
				try {
					parsed = JSON.parse(toolCall.arguments)
				} catch {
					return { toolCallId: toolCall.id, content: `Invalid JSON in tool call arguments: ${toolCall.arguments}` }
				}

				if (!isValidReadFileArguments(parsed)) {
					return { toolCallId: toolCall.id, content: `Invalid arguments for read_file. Expected { "path": string }. Got: ${toolCall.arguments}` }
				}

				if (isBinaryExtension(parsed.path)) {
					return { toolCallId: toolCall.id, content: `File is binary and cannot be displayed: ${parsed.path}` }
				}

				const result = await spawnGit(["show", `${baseCommit}:${parsed.path}`])
				if (result.exitCode !== 0) {
					return { toolCallId: toolCall.id, content: `File not found: ${parsed.path}` }
				}

				if (!isContentText(result.stdout)) {
					return { toolCallId: toolCall.id, content: `File is binary and cannot be displayed: ${parsed.path}` }
				}

				return { toolCallId: toolCall.id, content: result.stdout }
			}

			return { toolCallId: toolCall.id, content: `Unknown tool: ${toolCall.name}` }
		},
	}
}
