import { describe, it, expect } from "bun:test"
import { createLoadAgents, createLoadAggregator, createReadAgentsFromDisk } from "../source/agents.mts"
import type { AgentDirectories, AgentReader, Agent } from "../source/agents.mts"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PROJECT_ROOT = join(import.meta.dir, "..")

function mockReader(agentsByDirectory: Map<string, Agent[]>): AgentReader {
	return (directory) => Promise.resolve(agentsByDirectory.get(directory) ?? [])
}

describe("createLoadAgents", () => {
	it("returns Default when 'run all agents' and no user agents exist", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, [{ name: "Default", prompt: "Default agent prompt" }, { name: "Aggregator", prompt: "Aggregator prompt" }]],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents("run all agents")

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
		expect(result.unresolvedNames).toEqual([])
	})

	it("returns all user agents when 'run all agents' and user agents exist", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }, { name: "StyleAgent", prompt: "Style prompt" }]],
			[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents("run all agents")

		expect(result.agents).toHaveLength(2)
		expect(result.agents.map(a => a.name)).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("resolves named agents from user directory first", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "User security prompt" }]],
			[builtinDirectory, [{ name: "SecurityAgent", prompt: "Builtin security prompt" }]],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents(["SecurityAgent"])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("User security prompt")
	})

	it("resolves named agents from builtin directory when not in user directory", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents(["Default"])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("Default prompt")
	})

	it("throws for unresolved agent names", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, []],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		expect(loadAgents(["NonExistent"])).rejects.toThrow("Unresolved agents: NonExistent")
	})

	it("throws for unresolved names even when some agents resolve", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		expect(loadAgents(["SecurityAgent", "NonExistent"])).rejects.toThrow("Unresolved agents: NonExistent")
	})

	it("filters out Aggregator from user agents when 'run all agents'", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "Aggregator", prompt: "User aggregator" }, { name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents("run all agents")

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
	})

	it("filters out Aggregator from builtin agents when 'run all agents'", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }, { name: "Default", prompt: "Default prompt" }]],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents("run all agents")

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
	})

	it("resolves agent names case-insensitively", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		const loadAgents = createLoadAgents(directories, readAgents)
		const result = await loadAgents(["securityagent"])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
		expect(result.unresolvedNames).toEqual([])
	})

	it("reads agents from disk using createLoadAgents", async () => {
		const builtinDirectory = join(PROJECT_ROOT, "agents")
		expect(existsSync(builtinDirectory)).toBe(true)

		const loadAgents = createLoadAgents({ userAgentsDirectory: "/nonexistent", builtinAgentsDirectory: builtinDirectory }, createReadAgentsFromDisk())
		const result = await loadAgents("run all agents")

		const names = result.agents.map(a => a.name)
		expect(names).toContain("Default")
		expect(names).not.toContain("Aggregator")
		for (const agent of result.agents) {
			expect(agent.prompt.length).toBeGreaterThan(0)
		}
	})
})

describe("createLoadAggregator", () => {
	it("returns user aggregator when it exists", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "Aggregator", prompt: "User aggregator" }]],
			[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const loadAggregator = createLoadAggregator(directories, readAgents)
		const aggregator = await loadAggregator()

		expect(aggregator.prompt).toBe("User aggregator")
	})

	it("returns builtin aggregator when no user aggregator exists", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const loadAggregator = createLoadAggregator(directories, readAgents)
		const aggregator = await loadAggregator()

		expect(aggregator.prompt).toBe("Builtin aggregator")
	})

	it("matches aggregator case-insensitively", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "aggregator", prompt: "Lowercase aggregator" }]],
			[builtinDirectory, []],
		]))

		const loadAggregator = createLoadAggregator(directories, readAgents)
		const aggregator = await loadAggregator()

		expect(aggregator.name).toBe("aggregator")
	})
})
