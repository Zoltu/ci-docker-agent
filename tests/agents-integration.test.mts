import { describe, it, expect } from "bun:test"
import { loadAgents, loadAggregator, readAgentsFromDisk, type AgentDirs, type AgentReader, type Agent } from "../source/agents.mts"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PROJECT_ROOT = join(import.meta.dir, "..")

function mockReader(agentsByDir: Map<string, Agent[]>): AgentReader {
	return (dir) => Promise.resolve(agentsByDir.get(dir) ?? [])
}

describe("loadAgents", () => {
	it("returns Default when 'run all agents' and no user agents exist", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, []],
			[builtinDir, [{ name: "Default", prompt: "Default agent prompt" }, { name: "Aggregator", prompt: "Aggregator prompt" }]],
		]))

		const result = await loadAgents("run all agents", dirs, readAgents)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
		expect(result.unresolvedNames).toEqual([])
	})

	it("returns all user agents when 'run all agents' and user agents exist", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "SecurityAgent", prompt: "Security prompt" }, { name: "StyleAgent", prompt: "Style prompt" }]],
			[builtinDir, [{ name: "Default", prompt: "Default prompt" }]],
		]))

		const result = await loadAgents("run all agents", dirs, readAgents)

		expect(result.agents).toHaveLength(2)
		expect(result.agents.map(a => a.name)).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("resolves named agents from user directory first", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "SecurityAgent", prompt: "User security prompt" }]],
			[builtinDir, [{ name: "SecurityAgent", prompt: "Builtin security prompt" }]],
		]))

		const result = await loadAgents(["SecurityAgent"], dirs, readAgents)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("User security prompt")
	})

	it("resolves named agents from builtin directory when not in user directory", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, []],
			[builtinDir, [{ name: "Default", prompt: "Default prompt" }]],
		]))

		const result = await loadAgents(["Default"], dirs, readAgents)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("Default prompt")
	})

	it("throws for unresolved agent names", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, []],
			[builtinDir, []],
		]))

		expect(loadAgents(["NonExistent"], dirs, readAgents)).rejects.toThrow("Unresolved agents: NonExistent")
	})

	it("throws for unresolved names even when some agents resolve", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDir, []],
		]))

		expect(loadAgents(["SecurityAgent", "NonExistent"], dirs, readAgents)).rejects.toThrow("Unresolved agents: NonExistent")
	})

	it("filters out Aggregator from user agents when 'run all agents'", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "Aggregator", prompt: "User aggregator" }, { name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDir, []],
		]))

		const result = await loadAgents("run all agents", dirs, readAgents)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
	})

	it("filters out Aggregator from builtin agents when 'run all agents'", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, []],
			[builtinDir, [{ name: "Aggregator", prompt: "Builtin aggregator" }, { name: "Default", prompt: "Default prompt" }]],
		]))

		const result = await loadAgents("run all agents", dirs, readAgents)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
	})

	it("resolves agent names case-insensitively", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDir, []],
		]))

		const result = await loadAgents(["securityagent"], dirs, readAgents)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
		expect(result.unresolvedNames).toEqual([])
	})

	it("reads agents from disk using readAgentsFromDisk", async () => {
		const builtinDir = join(PROJECT_ROOT, "agents")
		expect(existsSync(builtinDir)).toBe(true)

		const agents = await readAgentsFromDisk(builtinDir)

		const names = agents.map(a => a.name)
		expect(names).toContain("Default")
		expect(names).toContain("Aggregator")
		for (const agent of agents) {
			expect(agent.prompt.length).toBeGreaterThan(0)
		}
	})
})

describe("loadAggregator", () => {
	it("returns user aggregator when it exists", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "Aggregator", prompt: "User aggregator" }]],
			[builtinDir, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const aggregator = await loadAggregator(dirs, readAgents)

		expect(aggregator.prompt).toBe("User aggregator")
	})

	it("returns builtin aggregator when no user aggregator exists", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, []],
			[builtinDir, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const aggregator = await loadAggregator(dirs, readAgents)

		expect(aggregator.prompt).toBe("Builtin aggregator")
	})

	it("matches aggregator case-insensitively", async () => {
		const userDir = "/user"
		const builtinDir = "/builtins"
		const dirs: AgentDirs = { userAgentsDir: userDir, builtinAgentsDir: builtinDir }
		const readAgents = mockReader(new Map([
			[userDir, [{ name: "aggregator", prompt: "Lowercase aggregator" }]],
			[builtinDir, []],
		]))

		const aggregator = await loadAggregator(dirs, readAgents)

		expect(aggregator.name).toBe("aggregator")
	})
})
