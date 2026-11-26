import type { BaseCommitContext } from "./base-commit.mts"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { sanitizeForSingleLine } from "./typescript-helpers.mts"

export type AgentNames = readonly string[] | "run all agents"

export interface Agent {
	name: string
	prompt: string
}

export type AgentReader = (directory: string) => Promise<Agent[]>

// A full claim carries only the number of reviewers that ran; a partial claim carries the reviewers that ran and the number the pull request could run, which is the union of those reviewers and the ones a run with no selector labels would use.
export type ReviewerCoverage =
	| { readonly kind: "full"; readonly reviewerCount: number }
	| { readonly kind: "partial"; readonly ranReviewerNames: readonly string[]; readonly possibleReviewerCount: number }

// A run's agents together with the coverage claim about those agents; `loadReviewerRun` is what pairs them, because both fields are plain data and the types cannot stop a caller from assembling another pair.
export interface ReviewerRun {
	readonly agents: readonly Agent[]
	readonly coverage: ReviewerCoverage
}

// Both the aggregator prompt file and the aggregator selector are matched case-insensitively, so an override named `aggregator.md` behaves like the canonical file everywhere.
export const AGGREGATOR_AGENT_NAME = "Aggregator" as const

const AGGREGATOR_AGENT_NAME_KEY = AGGREGATOR_AGENT_NAME.toLowerCase()

// The built-in reviewer a repository without its own prompts reviews with, so every place that names it derives the name from here.
const DEFAULT_AGENT_NAME = "Default" as const

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

export function isAggregatorName(name: string): boolean {
	return name.toLowerCase() === AGGREGATOR_AGENT_NAME_KEY
}

function buildAgentMap(agents: Agent[]): Map<string, Agent> {
	return new Map(agents.map(a => [a.name.toLowerCase(), a]))
}

function filterOutAggregator(agents: readonly Agent[]): Agent[] {
	return agents.filter(a => !isAggregatorName(a.name))
}

function findAggregator(agents: Agent[]): Agent | null {
	return agents.find(a => isAggregatorName(a.name)) ?? null
}

// A prompt file name is matched case-insensitively, so two files whose names differ only by case are one reviewer and only one of them would ever run.
// That is a repository misconfiguration, so it fails where a name list is built rather than being collapsed into a count that reports the prompt it skipped as a reviewer that ran.
function assertDistinctAgentNames(agents: readonly Agent[]): void {
	const firstNameByKey = new Map<string, string>()
	for (const agent of agents) {
		const key = agent.name.toLowerCase()
		const firstName = firstNameByKey.get(key)
		if (firstName !== undefined) throw new Error(`Duplicate agent prompt file names: "${sanitizeForSingleLine(firstName)}" and "${sanitizeForSingleLine(agent.name)}". Two prompt files whose names differ only by case are one reviewer, so only one of them would ever run; rename or delete one of them.`)
		firstNameByKey.set(key, agent.name)
	}
}

// The aggregator prompt file sits in an agent directory too, so without this the available-agent list would advertise a selector that always fails.
// A user prompt can shadow a builtin name, so each name appears once, in the order the directories are passed; a collision inside one directory is a duplicate prompt instead, which the next selector label would otherwise resolve against only one of.
export function selectableAgentNames(userAgents: readonly Agent[], builtinAgents: readonly Agent[]): readonly string[] {
	assertDistinctAgentNames(userAgents)
	assertDistinctAgentNames(builtinAgents)

	const names: string[] = []
	const seenNames = new Set<string>()
	for (const agent of [...userAgents, ...builtinAgents]) {
		if (isAggregatorName(agent.name)) continue
		const key = agent.name.toLowerCase()
		if (seenNames.has(key)) continue
		seenNames.add(key)
		names.push(agent.name)
	}
	return names
}

// The reviewers a run with no selector resolves: every user prompt in the order the directory listed them, or the built-in Default when the repository ships none, with the aggregator excluded because it always runs last.
// The coverage claim compares a run against this same list, so a duplicate prompt name fails here rather than being counted as one reviewer and reported as a full review.
function selectAllReviewerNames(userAgents: readonly Agent[]): readonly string[] {
	assertDistinctAgentNames(userAgents)

	const reviewerNames = filterOutAggregator(userAgents).map(agent => agent.name)
	if (reviewerNames.length > 0) return reviewerNames
	return [DEFAULT_AGENT_NAME]
}

// A run is narrowed only when it leaves out a reviewer a run with no selector labels would have used, so the comparison asks whether the reference set is covered, not whether the two lists match.
// A selection may cover that set and add a reviewer that no bare run uses, such as `Reviewer - Default` beside every `.ci-agents` prompt, and such a run reviews strictly more than a bare run does.
// Names are compared in lowercase because agent selection matches a requested name against the prompt file name case-insensitively, so `security` and `Security` are the same reviewer and comparing them as different would report a full review as narrowed.
// A partial claim states the union of both sets, because its total answers how many reviewers the pull request could run: a swap of a reference reviewer for an outsider leaves that total above the number that ran, where the bare reference size could equal it and read as complete coverage.
// The union outgrows the number that ran exactly when a reference reviewer is missing, so the same comparison decides the full and the partial case.
function deriveReviewerCoverage(agents: readonly Agent[], referenceReviewerNames: readonly string[]): ReviewerCoverage {
	const ranReviewerNameKeys = new Set(agents.map(agent => agent.name.toLowerCase()))
	const referenceReviewerNameKeys = new Set(referenceReviewerNames.map(name => name.toLowerCase()))
	const possibleReviewerCount = new Set([...ranReviewerNameKeys, ...referenceReviewerNameKeys]).size
	if (possibleReviewerCount !== ranReviewerNameKeys.size) return { kind: "partial", ranReviewerNames: agents.map(agent => agent.name), possibleReviewerCount }
	return { kind: "full", reviewerCount: ranReviewerNameKeys.size }
}

// Both selector surfaces refuse a selection that names the aggregator, so the shared reason lives here and each caller supplies only how that selection is removed.
export function formatAggregatorSelectionError(selection: string, removalInstruction: string): string {
	return `"${sanitizeForSingleLine(selection)}" is a configuration error: the ${AGGREGATOR_AGENT_NAME} always runs last automatically and must not be selected. ${removalInstruction}`
}

function resolveAgents(requestedNames: AgentNames, userAgents: Agent[], builtinAgents: Agent[]): Agent[] {
	assertDistinctAgentNames(userAgents)
	assertDistinctAgentNames(builtinAgents)

	const filteredUserAgents = filterOutAggregator(userAgents)
	const filteredBuiltinAgents = filterOutAggregator(builtinAgents)
	const userAgentMap = buildAgentMap(filteredUserAgents)
	const builtinAgentMap = buildAgentMap(filteredBuiltinAgents)

	const resolvedNames = requestedNames === "run all agents" ? selectAllReviewerNames(userAgents) : requestedNames

	const seenNames = new Set<string>()
	const agents: Agent[] = []
	const unresolvedNames: string[] = []
	// Each requested name is a prompt file name or an `AGENTS` value, and both messages below reach a log, so a newline in one would forge an extra line there.
	for (const name of resolvedNames) {
		const key = name.toLowerCase()
		if (seenNames.has(key)) throw new Error(`Duplicate agent name: "${sanitizeForSingleLine(name)}"`)
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

	// The aggregator prompt file ships in an agent directory the user can read, so a request naming it needs to say why it cannot be honored instead of reporting a name that appears to exist.
	const aggregatorSelection = unresolvedNames.find(isAggregatorName)
	if (aggregatorSelection !== undefined) throw new Error(formatAggregatorSelectionError(aggregatorSelection, "Remove it from AGENTS."))

	if (unresolvedNames.length !== 0) throw new Error(`Unresolved agents: ${unresolvedNames.map(name => sanitizeForSingleLine(name)).join(", ")}. Each name must match a markdown file in .ci-agents/ or the built-in agents directory; AGENTS names are matched case-insensitively, without the .md extension.`)

	return agents
}

// Both prompt directories are read once and every value a caller needs is derived from that read, so a selection and the reference set it is measured against cannot describe different directory states.
// The reference reviewer names the coverage claim rests on are derived from that same read of the user directory and returned beside the agents, so this step resolves a selection and supplies its reference set, not a resolved selection alone.
// The caller supplies how a selection is made, so the selector vocabulary and the selection input are read once, beside the read.
async function readAgentsAndResolveSelection(dependencies: { readAgents: AgentReader }, userAgentsDirectory: string, builtinAgentsDirectory: string, selectAgentNames: (availableAgentNames: readonly string[]) => AgentNames): Promise<{ agents: Agent[]; referenceReviewerNames: readonly string[] }> {
	const userAgents = await dependencies.readAgents(userAgentsDirectory)
	const builtinAgents = await dependencies.readAgents(builtinAgentsDirectory)

	const agents = resolveAgents(selectAgentNames(selectableAgentNames(userAgents, builtinAgents)), userAgents, builtinAgents)
	return { agents, referenceReviewerNames: selectAllReviewerNames(userAgents) }
}

// Pairs the agents with the coverage claim about exactly those agents; the pairing is possible because both come from the one read the shared read-and-resolve step performs.
export async function loadReviewerRun(dependencies: { readAgents: AgentReader }, userAgentsDirectory: string, builtinAgentsDirectory: string, selectAgentNames: (availableAgentNames: readonly string[]) => AgentNames): Promise<ReviewerRun> {
	const { agents, referenceReviewerNames } = await readAgentsAndResolveSelection(dependencies, userAgentsDirectory, builtinAgentsDirectory, selectAgentNames)
	return { agents, coverage: deriveReviewerCoverage(agents, referenceReviewerNames) }
}

// Local-diff mode prints the review and carries no coverage claim, so the selection is the whole result.
// It reads each prompt directory exactly once, whichever selection the caller asks for.
export async function loadSelectedAgents(dependencies: { readAgents: AgentReader }, userAgentsDirectory: string, builtinAgentsDirectory: string, selectAgentNames: (availableAgentNames: readonly string[]) => AgentNames): Promise<readonly Agent[]> {
	const { agents } = await readAgentsAndResolveSelection(dependencies, userAgentsDirectory, builtinAgentsDirectory, selectAgentNames)
	return agents
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
