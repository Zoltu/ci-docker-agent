import type { PrFile } from "./github-types.mts"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { USER_AGENTS_DIR, BUILTIN_AGENTS_DIR } from "./paths.mts"

export interface Agent {
	name: string
	prompt: string
}

export interface AgentDirs {
	userAgentsDir: string
	builtinAgentsDir: string
}

async function loadAgentsFromDir(dir: string, warnOnMissing = false): Promise<Agent[]> {
	const agents: Agent[] = []

	if (!existsSync(dir)) {
		if (warnOnMissing) {
			console.warn(`Warning: Builtin agents directory does not exist: ${dir}`)
		}
		return agents
	}

	const entries = await readdir(dir)
	for (const entry of entries) {
		if (entry.toLowerCase().endsWith(".md")) {
			const filePath = `${dir}/${entry}`
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

export async function loadAggregator(dirs: AgentDirs = { userAgentsDir: USER_AGENTS_DIR, builtinAgentsDir: BUILTIN_AGENTS_DIR }): Promise<Agent | null> {
	const userAgents = await loadAgentsFromDir(dirs.userAgentsDir)
	const userAggregator = findAggregator(userAgents)
	if (userAggregator) {
		return userAggregator
	}

	const builtinAgents = await loadAgentsFromDir(dirs.builtinAgentsDir, true)
	const builtinAggregator = findAggregator(builtinAgents)
	if (builtinAggregator) {
		return builtinAggregator
	}

	return null
}

export async function loadAgents(agentNames: string[], dirs: AgentDirs = { userAgentsDir: USER_AGENTS_DIR, builtinAgentsDir: BUILTIN_AGENTS_DIR }): Promise<{ agents: Agent[], unresolvedNames: string[] }> {
	const allUserAgents = await loadAgentsFromDir(dirs.userAgentsDir)
	const allBuiltinAgents = await loadAgentsFromDir(dirs.builtinAgentsDir, true)

	const userAgents = filterOutAggregator(allUserAgents)
	const builtinAgents = filterOutAggregator(allBuiltinAgents)

	let resolvedNames = agentNames
	if (resolvedNames.length === 0) {
		if (userAgents.length > 0) {
			resolvedNames = userAgents.map(a => a.name)
		} else {
			resolvedNames = ["Default"]
		}
	}

	const agents: Agent[] = []
	const unresolvedNames: string[] = []
	for (const name of resolvedNames) {
		const userAgent = userAgents.find(a => a.name === name)
		if (userAgent) {
			agents.push(userAgent)
			continue
		}

		const builtinAgent = builtinAgents.find(a => a.name === name)
		if (builtinAgent) {
			agents.push(builtinAgent)
			continue
		}

		console.warn(`Warning: Agent "${name}" not found, skipping`)
		unresolvedNames.push(name)
	}

	return { agents, unresolvedNames }
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
