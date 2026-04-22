import type { PrFile } from "./github-types.mts"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { USER_AGENTS_DIR, BUILTIN_AGENTS_DIR } from "./paths.mts"

export type AgentNames = string[] | "run all agents"

export interface Agent {
	name: string
	prompt: string
}

export interface AgentDirs {
	userAgentsDir: string
	builtinAgentsDir: string
}

export type AgentReader = (dir: string) => Promise<Agent[]>

export async function readAgentsFromDisk(dir: string): Promise<Agent[]> {
	if (!existsSync(dir)) return []

	const agents: Agent[] = []
	const entries = await readdir(dir)
	for (const entry of entries) {
		if (entry.toLowerCase().endsWith(".md")) {
			const filePath = join(dir, entry)
			const name = entry.replace(/\.md$/i, "")
			const content = await Bun.file(filePath).text()
			agents.push({ name, prompt: content })
		}
	}

	return agents
}

function filterOutAggregator(agents: Agent[]): Agent[] {
	return agents.filter(a => a.name.toLowerCase() !== "aggregator")
}

function findAggregator(agents: Agent[]): Agent | null {
	return agents.find(a => a.name.toLowerCase() === "aggregator") ?? null
}

export async function loadAggregator(dirs: AgentDirs = { userAgentsDir: USER_AGENTS_DIR, builtinAgentsDir: BUILTIN_AGENTS_DIR }, readAgents: AgentReader = readAgentsFromDisk): Promise<Agent> {
	const userAgents = await readAgents(dirs.userAgentsDir)
	const userAggregator = findAggregator(userAgents)
	if (userAggregator) return userAggregator

	const builtinAgents = await readAgents(dirs.builtinAgentsDir)
	const builtinAggregator = findAggregator(builtinAgents)
	if (builtinAggregator) return builtinAggregator

	throw new Error(`No aggregator agent found in ${dirs.userAgentsDir} or ${dirs.builtinAgentsDir}`)
}

export interface ResolveResult {
	agents: Agent[]
	unresolvedNames: string[]
}

export function resolveAgents(requestedNames: AgentNames, userAgents: Agent[], builtinAgents: Agent[]): ResolveResult {
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

export async function loadAgents(agentNames: AgentNames, dirs: AgentDirs = { userAgentsDir: USER_AGENTS_DIR, builtinAgentsDir: BUILTIN_AGENTS_DIR }, readAgents: AgentReader = readAgentsFromDisk): Promise<ResolveResult> {
	const allUserAgents = await readAgents(dirs.userAgentsDir)
	const allBuiltinAgents = await readAgents(dirs.builtinAgentsDir)

	const result = resolveAgents(agentNames, allUserAgents, allBuiltinAgents)

	if (result.unresolvedNames.length > 0) {
		throw new Error(
			`Unresolved agents: ${result.unresolvedNames.join(", ")}. ` +
			`Each name must match a markdown file in .ci-agents/ or the built-in agents directory (case-insensitive, without .md extension).`
		)
	}

	return result
}

export function buildAgentPrompt(agent: Agent, files: PrFile[], agentInputs?: Map<string, string>): string {
	let prompt = agent.prompt

	if (agentInputs && agentInputs.size > 0) {
		prompt += "\n\n=== Agent Feedback ===\n"
		for (const [name, output] of agentInputs.entries()) {
			prompt += `\n=== Agent: ${name} ===\n${output}\n`
		}
	}

	prompt += "\n\n=== Files Changed ===\n"
	for (const file of files) {
		prompt += `\nFile: ${file.filename}\nStatus: ${file.status}\n`
		prompt += `Additions: +${file.additions}, Deletions: -${file.deletions}\n`
		if (file.patch) {
			prompt += `\nPatch:\n${file.patch}\n`
		}
	}

	return prompt
}
