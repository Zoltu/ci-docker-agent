import type { PrFile } from "./github-types.mts"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"

const DEFAULT_USER_AGENTS_DIR = "/github/workspace/.ci-agents"
const DEFAULT_BUILTIN_AGENTS_DIR = "/github/workspace/agents"

export interface Agent {
	name: string
	prompt: string
}

export interface AgentResult {
	name: string
	output: string
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

export async function loadAggregator(dirs: AgentDirs = { userAgentsDir: DEFAULT_USER_AGENTS_DIR, builtinAgentsDir: DEFAULT_BUILTIN_AGENTS_DIR }): Promise<Agent | null> {
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

export async function loadAgents(agentNames: string[], dirs: AgentDirs = { userAgentsDir: DEFAULT_USER_AGENTS_DIR, builtinAgentsDir: DEFAULT_BUILTIN_AGENTS_DIR }): Promise<Agent[]> {
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
	}

	return agents
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

export async function runAgent(agent: Agent, files: PrFile[], agentInputs?: Map<string, string>): Promise<AgentResult> {
	buildAgentPrompt(agent, files, agentInputs)

	// Placeholder: In the future, the prompt from buildAgentPrompt would be sent to an AI API
	// For now, return a placeholder response
	console.log(`Running agent: ${agent.name}`)

	const placeholderOutput = JSON.stringify({ summary: `${agent.name} placeholder output - AI integration not yet implemented`, lineComments: [] })

	return {
		name: agent.name,
		output: placeholderOutput,
	}
}

export async function runAgents(agents: Agent[], aggregator: Agent | null, files: PrFile[]): Promise<AgentResult[]> {
	const results: AgentResult[] = []
	const agentInputs = new Map<string, string>()

	const reviewResults = await Promise.all(
		agents.map(agent => runAgent(agent, files))
	)

	results.push(...reviewResults)

	for (const result of reviewResults) {
		agentInputs.set(result.name, result.output)
	}

	if (aggregator) {
		const aggregatorResult = await runAgent(aggregator, files, agentInputs)
		results.push(aggregatorResult)
	}

	return results
}
