import type { DiffResult } from "./diff.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type AgentNames = string[] | "run all agents"

export interface Agent {
	name: string
	prompt: string
}

export interface AgentDirectories {
	userAgentsDirectory: string
	builtinAgentsDirectory: string
}

export type AgentReader = (directory: string) => Promise<Agent[]>

export function createReadAgentsFromDisk(): AgentReader {
	return async function readAgentsFromDisk(directory: string): Promise<Agent[]> {
		if (!existsSync(directory)) return []

		const agents: Agent[] = []
		const entries = await readdir(directory)
		for (const entry of entries) {
			if (entry.toLowerCase().endsWith(".md")) {
				const filePath = join(directory, entry)
				const name = entry.replace(/\.md$/i, "")
				const content = await Bun.file(filePath).text()
				agents.push({ name, prompt: content })
			}
		}

		return agents
	}
}

function filterOutAggregator(agents: Agent[]): Agent[] {
	return agents.filter(a => a.name.toLowerCase() !== "aggregator")
}

function findAggregator(agents: Agent[]): Agent | null {
	return agents.find(a => a.name.toLowerCase() === "aggregator") ?? null
}

export interface ResolveResult {
	agents: Agent[]
	unresolvedNames: string[]
}

function resolveAgents(requestedNames: AgentNames, userAgents: Agent[], builtinAgents: Agent[]): ResolveResult {
	const filteredUserAgents = filterOutAggregator(userAgents)
	const filteredBuiltinAgents = filterOutAggregator(builtinAgents)

	const resolvedNames = requestedNames === "run all agents"
		? filteredUserAgents.length > 0
			? filteredUserAgents.map(a => a.name)
			: ["Default"]
		: requestedNames

	const seenNames = new Set<string>()
	for (const name of resolvedNames) {
		const key = name.toLowerCase()
		if (seenNames.has(key)) throw new Error(`Duplicate agent name: "${name}"`)
		seenNames.add(key)
	}

	const agents: Agent[] = []
	const unresolvedNames: string[] = []
	for (const name of resolvedNames) {
		const userAgent = filteredUserAgents.find(a => a.name.toLowerCase() === name.toLowerCase())
		if (userAgent) {
			agents.push(userAgent)
			continue
		}

		const builtinAgent = filteredBuiltinAgents.find(a => a.name.toLowerCase() === name.toLowerCase())
		if (builtinAgent) {
			agents.push(builtinAgent)
			continue
		}

		unresolvedNames.push(name)
	}

	return { agents, unresolvedNames }
}

export function createLoadAgents(directories: AgentDirectories, readAgents: AgentReader): (agentNames: AgentNames) => Promise<ResolveResult> {
	return async function loadAgents(agentNames: AgentNames): Promise<ResolveResult> {
		const allUserAgents = await readAgents(directories.userAgentsDirectory)
		const allBuiltinAgents = await readAgents(directories.builtinAgentsDirectory)

		const result = resolveAgents(agentNames, allUserAgents, allBuiltinAgents)

		if (result.unresolvedNames.length > 0) {
			throw new Error(`Unresolved agents: ${result.unresolvedNames.join(", ")}.  Each name must match a markdown file in .ci-agents/ or the built-in agents directory (case-insensitive, without .md extension).`)
		}

		return result
	}
}

export function createLoadAggregator(directories: AgentDirectories, readAgents: AgentReader): () => Promise<Agent> {
	return async function loadAggregator(): Promise<Agent> {
		const userAgents = await readAgents(directories.userAgentsDirectory)
		const userAggregator = findAggregator(userAgents)
		if (userAggregator) return userAggregator

		const builtinAgents = await readAgents(directories.builtinAgentsDirectory)
		const builtinAggregator = findAggregator(builtinAgents)
		if (builtinAggregator) return builtinAggregator

		throw new Error(`No aggregator agent found in ${directories.userAgentsDirectory} or ${directories.builtinAgentsDirectory}`)
	}
}

export function buildAgentPrompt(agent: Agent, baseCommitContext: BaseCommitContext, diffResult: DiffResult, agentInputs?: Map<string, string>): string {
	const { files, binaryFiles } = diffResult
	const lines: string[] = []

	// Repository Files (Base Commit)
	lines.push("=== Repository Files (Base Commit) ===")
	for (const file of baseCommitContext.fileList) {
		lines.push(`- ${file}`)
	}

	// File Contents (Base Commit)
	lines.push("", "=== File Contents (Base Commit) ===")
	for (const [filename, content] of baseCommitContext.fileContents.entries()) {
		lines.push(`=== ${filename} ===`)
		lines.push(content)
	}

	// Changeset Statistics
	const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
	const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
	lines.push("", "=== Changeset Statistics ===")
	lines.push(`Total files changed: ${files.length}`)
	lines.push(`Additions: +${totalAdditions}, Deletions: -${totalDeletions}`)
	lines.push("")
	for (const file of files) {
		lines.push(`- ${file.filename} (${file.status}): +${file.additions} -${file.deletions}`)
	}

	// Changeset Diffs
	lines.push("", "=== Changeset Diffs ===")
	for (const file of files) {
		lines.push(`=== ${file.filename} ===`)
		lines.push(file.patch)
	}

	if (binaryFiles.length > 0) {
		lines.push("", "=== Binary/Image Diffs ===")
		for (const filename of binaryFiles) {
			lines.push(`- ${filename}: binary diff present`)
		}
	}

	// Agent Feedback (for aggregator)
	if (agentInputs && agentInputs.size > 0) {
		lines.push("", "=== Agent Feedback ===")
		for (const [name, output] of agentInputs.entries()) {
			lines.push(`=== Agent: ${name} ===`)
			lines.push(output)
		}
	}

	// Agent Instructions
	lines.push("", "=== Agent Instructions ===")
	lines.push(agent.prompt)

	return lines.join("\n")
}
