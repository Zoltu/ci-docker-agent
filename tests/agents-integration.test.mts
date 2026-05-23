import { describe, it, expect } from "bun:test"
import { loadAgents, loadAggregator } from "../source/agents.mts"
import type { AgentDirectories, AgentReader, Agent } from "../source/agents.mts"

function mockReader(agentsByDirectory: Map<string, Agent[]>): AgentReader {
	return (directory) => Promise.resolve(agentsByDirectory.get(directory) ?? [])
}

describe("loadAgents", () => {
	it("returns Default when 'run all agents' and no user agents exist", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, [{ name: "Default", prompt: "Default agent prompt" }, { name: "Aggregator", prompt: "Aggregator prompt" }]],
		]))

		const result = await loadAgents({ readAgents }, directories, "run all agents")

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

		const result = await loadAgents({ readAgents }, directories, "run all agents")

		expect(result.agents).toHaveLength(2)
		expect(result.agents.map((a: Agent) => a.name)).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("resolves named agents from user directory first", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "User security prompt" }]],
			[builtinDirectory, [{ name: "SecurityAgent", prompt: "Builtin security prompt" }]],
		]))

		const result = await loadAgents({ readAgents }, directories, ["SecurityAgent"])

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

		const result = await loadAgents({ readAgents }, directories, ["Default"])

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

		expect(loadAgents({ readAgents }, directories, ["NonExistent"])).rejects.toThrow("Unresolved agents: NonExistent")
	})

	it("throws for unresolved names even when some agents resolve", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		expect(loadAgents({ readAgents }, directories, ["SecurityAgent", "NonExistent"])).rejects.toThrow("Unresolved agents: NonExistent")
	})

	it("filters out Aggregator from user agents when 'run all agents'", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "Aggregator", prompt: "User aggregator" }, { name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		const result = await loadAgents({ readAgents }, directories, "run all agents")

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

		const result = await loadAgents({ readAgents }, directories, "run all agents")

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

		const result = await loadAgents({ readAgents }, directories, ["securityagent"])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
		expect(result.unresolvedNames).toEqual([])
	})

	it("throws for duplicate agent names", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		expect(loadAgents({ readAgents }, directories, ["SecurityAgent", "SecurityAgent"])).rejects.toThrow(
			'Duplicate agent name: "SecurityAgent"'
		)
	})

	it("throws for case-insensitive duplicate agent names", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
			[builtinDirectory, []],
		]))

		expect(loadAgents({ readAgents }, directories, ["SecurityAgent", "securityagent"])).rejects.toThrow(
			'Duplicate agent name: "securityagent"'
		)
	})

})

describe("loadAggregator", () => {
	it("returns user aggregator when it exists", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const directories: AgentDirectories = { userAgentsDirectory: userDirectory, builtinAgentsDirectory: builtinDirectory }
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "Aggregator", prompt: "User aggregator" }]],
			[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const aggregator = await loadAggregator({ readAgents }, directories)

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

		const aggregator = await loadAggregator({ readAgents }, directories)

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

		const aggregator = await loadAggregator({ readAgents }, directories)

		expect(aggregator.name).toBe("aggregator")
	})
})
