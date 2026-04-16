import type { PRFile } from "./github-types.mts"
import { readdir, access, constants } from "node:fs/promises"

const USER_AGENTS_DIR = "/github/workspace/.ci-agents"
const BUILTIN_AGENTS_DIR = "/github/workspace/agents"

async function directoryExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK | constants.R_OK)
		return true
	} catch {
		return false
	}
}

export interface Agent {
	name: string
	prompt: string
}

export interface AgentResult {
	name: string
	output: string
}

export async function loadAggregator(): Promise<Agent | null> {
	// Check user agents for Aggregator (case-insensitive)
	const userAgents = await loadUserAgentsInternal()
	const userAggregator = userAgents.find(a => a.name.toLowerCase() === "aggregator")
	if (userAggregator) {
		return userAggregator
	}

	// Fall back to builtin Aggregator
	const builtinAgents = await loadBuiltinAgentsInternal()
	const builtinAggregator = builtinAgents.find(a => a.name.toLowerCase() === "aggregator")
	if (builtinAggregator) {
		return builtinAggregator
	}

	return null
}

export async function loadAgents(agentNames: string[]): Promise<Agent[]> {
	const agents: Agent[] = []
	const userAgents = await loadUserAgents()
	const builtinAgents = await loadBuiltinAgents()

	// If no agents specified, use all user agents or Default if none exist
	if (agentNames.length === 0) {
		if (userAgents.length > 0) {
			agentNames = userAgents.map(a => a.name)
		} else {
			agentNames = ["Default"]
		}
	}

	// Load each requested agent
	for (const name of agentNames) {
		// Check user agents first (case-sensitive)
		const userAgent = userAgents.find(a => a.name === name)
		if (userAgent) {
			agents.push(userAgent)
			continue
		}

		// Check builtin agents (case-sensitive)
		const builtinAgent = builtinAgents.find(a => a.name === name)
		if (builtinAgent) {
			agents.push(builtinAgent)
			continue
		}

		console.warn(`Warning: Agent "${name}" not found, skipping`)
	}

	return agents
}

async function loadUserAgents(): Promise<Agent[]> {
	const allAgents = await loadUserAgentsInternal()
	// Filter out Aggregator (case-insensitive)
	return allAgents.filter(a => a.name.toLowerCase() !== "aggregator")
}

async function loadUserAgentsInternal(): Promise<Agent[]> {
	const agents: Agent[] = []

	// Check if directory exists before attempting to read
	if (!(await directoryExists(USER_AGENTS_DIR))) {
		return agents
	}

	const entries = await readdir(USER_AGENTS_DIR)
	for (const entry of entries) {
		if (entry.toLowerCase().endsWith(".md")) {
			const filePath = `${USER_AGENTS_DIR}/${entry}`
			const name = entry.replace(/\.md$/i, "")
			const content = await Bun.file(filePath).text()
			agents.push({ name, prompt: content })
		}
	}

	return agents
}

async function loadBuiltinAgents(): Promise<Agent[]> {
	const allAgents = await loadBuiltinAgentsInternal()
	// Filter out Aggregator (case-insensitive)
	return allAgents.filter(a => a.name.toLowerCase() !== "aggregator")
}

async function loadBuiltinAgentsInternal(): Promise<Agent[]> {
	const agents: Agent[] = []

	// Check if directory exists before attempting to read
	if (!(await directoryExists(BUILTIN_AGENTS_DIR))) {
		console.warn(`Warning: Builtin agents directory does not exist: ${BUILTIN_AGENTS_DIR}`)
		return agents
	}

	const entries = await readdir(BUILTIN_AGENTS_DIR)
	for (const entry of entries) {
		if (entry.toLowerCase().endsWith(".md")) {
			const filePath = `${BUILTIN_AGENTS_DIR}/${entry}`
			const name = entry.replace(/\.md$/i, "")
			const content = await Bun.file(filePath).text()
			agents.push({ name, prompt: content })
		}
	}

	return agents
}

export async function runAgent(agent: Agent, files: PRFile[], agentInputs?: Map<string, string>): Promise<AgentResult> {
	// Build the prompt with context
	let prompt = agent.prompt

	// Add agent inputs if provided (for Aggregator)
	if (agentInputs && agentInputs.size > 0) {
		prompt += "\n\n=== Agent Feedback ===\n"
		for (const [name, output] of agentInputs.entries()) {
			prompt += `\n=== Agent: ${name} ===\n${output}\n`
		}
	}

	// Add file context
	prompt += "\n\n=== Files Changed ===\n"
	for (const file of files) {
		prompt += `\nFile: ${file.filename}\nStatus: ${file.status}\n`
		prompt += `Additions: +${file.additions}, Deletions: -${file.deletions}\n`
		if (file.patch) {
			prompt += `\nPatch:\n${file.patch}\n`
		}
	}

	// Placeholder: In the future, this would call an AI API
	// For now, return a placeholder response
	console.log(`Running agent: ${agent.name}`)

	// This is where the AI call would happen
	// For scaffolding, we return a placeholder
	const placeholderOutput = `[${agent.name} placeholder output - AI integration not yet implemented]`

	return {
		name: agent.name,
		output: placeholderOutput,
	}
}

export async function runAgents(agents: Agent[], aggregator: Agent | null, files: PRFile[]): Promise<AgentResult[]> {
	const results: AgentResult[] = []
	const agentInputs = new Map<string, string>()

	// Run all review agents in parallel
	const reviewResults = await Promise.all(
		agents.map(agent => runAgent(agent, files))
	)

	results.push(...reviewResults)

	// Collect outputs for aggregator
	for (const result of reviewResults) {
		agentInputs.set(result.name, result.output)
	}

	// Run aggregator if present
	if (aggregator) {
		const aggregatorResult = await runAgent(aggregator, files, agentInputs)
		results.push(aggregatorResult)
	}

	return results
}
