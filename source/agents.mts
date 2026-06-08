import type { BaseCommitContext } from "./base-commit.mts"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type AgentNames = readonly string[] | "run all agents"

export interface Agent {
	name: string
	prompt: string
}

export type AgentReader = (directory: string) => Promise<Agent[]>

export function createReadAgentsFromDisk(): AgentReader {
	return async function readAgentsFromDisk(directory: string): Promise<Agent[]> {
		if (!existsSync(directory)) return []

		const agents: Agent[] = []
		const entries = await readdir(directory)
		for (const entry of entries) {
			if (!entry.toLowerCase().endsWith(".md")) continue
			const filePath = join(directory, entry)
			const name = entry.replace(/\.md$/i, "")
			const content = await Bun.file(filePath).text()
			agents.push({ name, prompt: content })
		}

		return agents
	}
}

function buildAgentMap(agents: Agent[]): Map<string, Agent> {
	return new Map(agents.map(a => [a.name.toLowerCase(), a]))
}

function filterOutAggregator(agents: Agent[]): Agent[] {
	return agents.filter(a => a.name.toLowerCase() !== "aggregator")
}

function findAggregator(agents: Agent[]): Agent | null {
	return agents.find(a => a.name.toLowerCase() === "aggregator") ?? null
}

function resolveAgents(requestedNames: AgentNames, userAgents: Agent[], builtinAgents: Agent[]): Agent[] {
	const filteredUserAgents = filterOutAggregator(userAgents)
	const filteredBuiltinAgents = filterOutAggregator(builtinAgents)
	const userAgentMap = buildAgentMap(filteredUserAgents)
	const builtinAgentMap = buildAgentMap(filteredBuiltinAgents)

	const resolvedNames = requestedNames === "run all agents"
		? filteredUserAgents.length > 0
			? filteredUserAgents.map(a => a.name)
			: ["Default"]
		: requestedNames

	const seenNames = new Set<string>()
	const agents: Agent[] = []
	const unresolvedNames: string[] = []
	for (const name of resolvedNames) {
		const key = name.toLowerCase()
		if (seenNames.has(key)) throw new Error(`Duplicate agent name: "${name}"`)
		seenNames.add(key)

		const userAgent = userAgentMap.get(key)
		if (userAgent) {
			agents.push(userAgent)
			continue
		}

		const builtinAgent = builtinAgentMap.get(key)
		if (builtinAgent) {
			agents.push(builtinAgent)
			continue
		}

		unresolvedNames.push(name)
	}

	if (unresolvedNames.length !== 0) throw new Error(`Unresolved agents: ${unresolvedNames.join(", ")}.  Each name must match a markdown file in .ci-agents/ or the built-in agents directory (case-insensitive, without .md extension).`)

	return agents
}

export async function loadAgents(dependencies: { readAgents: AgentReader }, userAgentsDirectory: string, builtinAgentsDirectory: string, agentNames: AgentNames): Promise<Agent[]> {
	const allUserAgents = await dependencies.readAgents(userAgentsDirectory)
	const allBuiltinAgents = await dependencies.readAgents(builtinAgentsDirectory)

	return resolveAgents(agentNames, allUserAgents, allBuiltinAgents)
}

export async function loadAggregator(dependencies: { readAgents: AgentReader }, userAgentsDirectory: string, builtinAgentsDirectory: string): Promise<Agent> {
	const userAgents = await dependencies.readAgents(userAgentsDirectory)
	const userAggregator = findAggregator(userAgents)
	if (userAggregator) return userAggregator

	const builtinAgents = await dependencies.readAgents(builtinAgentsDirectory)
	const builtinAggregator = findAggregator(builtinAgents)
	if (builtinAggregator) return builtinAggregator

	throw new Error(`No aggregator agent found in ${userAgentsDirectory} or ${builtinAgentsDirectory}`)
}

export type PromptMessage =
	| { readonly role: "system"; readonly content: string }
	| { readonly role: "user"; readonly content: string }

export function buildAgentPrompt(agent: Agent, baseCommitContext: BaseCommitContext, diffText: string, agentInputs?: Map<string, string>): readonly PromptMessage[] {
	const messages: PromptMessage[] = []

	messages.push({ role: "system", content: agent.prompt })

	messages.push({ role: "system", content: "=== Repository Files (Base Commit) ===" })
	const fileListContent = baseCommitContext.fileList.map(f => `- ${f}`).join("\n")
	messages.push({ role: "user", content: fileListContent })

	messages.push({ role: "system", content: "=== Changeset Diffs ===" })
	messages.push({ role: "user", content: diffText })

	if (agentInputs && agentInputs.size > 0) {
		messages.push({ role: "system", content: "=== Agent Feedback ===" })
		for (const [name, output] of agentInputs.entries()) {
			messages.push({ role: "system", content: `=== Agent: ${name} ===` })
			messages.push({ role: "user", content: output })
		}
	}

	return messages
}
