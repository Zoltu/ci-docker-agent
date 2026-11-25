import { describe, expect, it } from "bun:test"
import { loadAggregator, loadReviewerRun } from "../source/agents.mts"
import type { AgentNames, AgentReader, Agent } from "../source/agents.mts"

function mockReader(agentsByDirectory: Map<string, Agent[]>): AgentReader {
	return (directory) => Promise.resolve(agentsByDirectory.get(directory) ?? [])
}

// The resolution rules are the same whichever selection a run makes, so a selection passed as a fixed value reads as the request the loader makes of the caller.
async function loadResolvedAgents(readAgents: AgentReader, userDirectory: string, builtinDirectory: string, agentNames: AgentNames): Promise<readonly Agent[]> {
	return (await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => agentNames)).agents
}

describe("loadReviewerRun", () => {
	describe("agent resolution", () => {
		it("returns Default when 'run all agents' and no user agents exist", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, [{ name: "Default", prompt: "Default agent prompt" }, { name: "Aggregator", prompt: "Aggregator prompt" }]],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, "run all agents")

			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe("Default")
		})

		it("returns all user agents when 'run all agents' and user agents exist", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }, { name: "StyleAgent", prompt: "Style prompt" }]],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, "run all agents")

			expect(result).toHaveLength(2)
			expect(result.map((a: Agent) => a.name)).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("resolves named agents from user directory first", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "SecurityAgent", prompt: "User security prompt" }]],
				[builtinDirectory, [{ name: "SecurityAgent", prompt: "Builtin security prompt" }]],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["SecurityAgent"])

			expect(result).toHaveLength(1)
			expect(result[0]!.prompt).toBe("User security prompt")
		})

		it("resolves named agents from builtin directory when not in user directory", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["Default"])

			expect(result).toHaveLength(1)
			expect(result[0]!.prompt).toBe("Default prompt")
		})

		it("throws for unresolved agent names", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["NonExistent"])).rejects.toThrow("Unresolved agents: NonExistent")
		})

		it("throws for unresolved names even when some agents resolve", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["SecurityAgent", "NonExistent"])).rejects.toThrow("Unresolved agents: NonExistent")
		})

		it("reports the aggregator as a selection error rather than an unresolved name", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, [{ name: "Aggregator", prompt: "Aggregator prompt" }]],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["Aggregator"])).rejects.toThrow('"Aggregator" is a configuration error: the Aggregator always runs last automatically and must not be selected. Remove it from AGENTS.')
		})

		it("reports the aggregator selection error in any capitalization", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, [{ name: "Aggregator", prompt: "Aggregator prompt" }]],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["aggregator"])).rejects.toThrow('"aggregator" is a configuration error: the Aggregator always runs last automatically')
		})

		it("filters out Aggregator from user agents when 'run all agents'", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Aggregator", prompt: "User aggregator" }, { name: "SecurityAgent", prompt: "Security prompt" }]],
				[builtinDirectory, []],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, "run all agents")

			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe("SecurityAgent")
		})

		it("filters out Aggregator from builtin agents when 'run all agents'", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }, { name: "Default", prompt: "Default prompt" }]],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, "run all agents")

			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe("Default")
		})

		it("resolves agent names case-insensitively", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
				[builtinDirectory, []],
			]))

			const result = await loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["securityagent"])

			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe("SecurityAgent")
		})

		it("throws for duplicate agent names", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["SecurityAgent", "SecurityAgent"])).rejects.toThrow(
				'Duplicate agent name: "SecurityAgent"'
			)
		})

		it("throws for case-insensitive duplicate agent names", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "SecurityAgent", prompt: "Security prompt" }]],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["SecurityAgent", "securityagent"])).rejects.toThrow(
				'Duplicate agent name: "securityagent"'
			)
		})

		it("escapes a prompt file name that would forge a line in the duplicate message", async () => {
			// A prompt file name on the base branch can carry a newline, and this message reaches the Actions log.
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const hostileName = "Security\u000aFORGED LOG LINE"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: hostileName, prompt: "Hostile prompt" }]],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, [hostileName, hostileName])).rejects.toThrow(
				"Duplicate agent name: \"Security\\u000aFORGED LOG LINE\""
			)
		})

		it("escapes an AGENTS name that would forge a line in the unresolved message", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["Evil\u000aFORGED LOG LINE"])).rejects.toThrow(
				"Unresolved agents: Evil\\u000aFORGED LOG LINE. Each name must match a markdown file in .ci-agents/ or the built-in agents directory"
			)
		})

		it("throws when 'run all agents' meets two prompt files that differ only by case", async () => {
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Security", prompt: "Security prompt" }, { name: "security", prompt: "Lowercase prompt" }]],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, "run all agents")).rejects.toThrow(
				'Duplicate agent prompt file names: "Security" and "security"'
			)
		})

		it("throws for a named selection when the prompt directory holds two files that differ only by case", async () => {
			// A named selection resolves against one of the two files, so without this the run reviews with a prompt the maintainer wrote the other one of and reports a full review.
			const userDirectory = "/user"
			const builtinDirectory = "/builtins"
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Security", prompt: "Security prompt" }, { name: "security", prompt: "Lowercase prompt" }]],
				[builtinDirectory, []],
			]))

			await expect(loadResolvedAgents(readAgents, userDirectory, builtinDirectory, ["Security"])).rejects.toThrow(
				'Duplicate agent prompt file names: "Security" and "security"'
			)
		})
	})

	describe("reviewer coverage", () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"

		it("claims a full run when 'run all agents' resolves every repository prompt", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Bug Hunter", prompt: "Bug hunter prompt" }, { name: "Security", prompt: "Security prompt" }]],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => "run all agents")

			expect(reviewerRun.agents.map((agent: Agent) => agent.name)).toEqual(["Bug Hunter", "Security"])
			expect(reviewerRun.coverage).toEqual({ kind: "full", reviewerCount: 2 })
		})

		it("claims a full run of the built-in Default when the repository ships no prompt", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, []],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }, { name: "Aggregator", prompt: "Aggregator prompt" }]],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => "run all agents")

			expect(reviewerRun.agents.map((agent: Agent) => agent.name)).toEqual(["Default"])
			expect(reviewerRun.coverage).toEqual({ kind: "full", reviewerCount: 1 })
		})

		it("claims a full run when an explicit selection names every repository prompt", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Bug Hunter", prompt: "Bug hunter prompt" }, { name: "Security", prompt: "Security prompt" }]],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => ["Bug Hunter", "Security"])

			expect(reviewerRun.coverage).toEqual({ kind: "full", reviewerCount: 2 })
		})

		it("claims a full run of every reviewer that ran when a selection also adds the built-in Default", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Bug Hunter", prompt: "Bug hunter prompt" }, { name: "Security", prompt: "Security prompt" }]],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => ["Bug Hunter", "Security", "Default"])

			// The reference set is the two repository prompts, and the run covered both and added one, so the count is three rather than two.
			expect(reviewerRun.coverage).toEqual({ kind: "full", reviewerCount: 3 })
		})

		it("claims a partial run with its reference numerator and every reviewer that ran in run order", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Bug Hunter", prompt: "Bug hunter prompt" }, { name: "Security", prompt: "Security prompt" }, { name: "Architect", prompt: "Architect prompt" }]],
				[builtinDirectory, []],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => ["Security", "Architect"])

			// The listed names follow the selection, not the directory, because they are the reviewers that ran in the order they ran.
			expect(reviewerRun.coverage).toEqual({ kind: "partial", ranReviewerNames: ["Security", "Architect"], ranReferenceReviewerCount: 2, referenceReviewerCount: 3 })
		})

		it("claims a partial run whose numerator is zero when a selection names only a built-in reviewer", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Bug Hunter", prompt: "Bug hunter prompt" }, { name: "Security", prompt: "Security prompt" }]],
				[builtinDirectory, [{ name: "Default", prompt: "Default prompt" }]],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => ["Default"])

			// The denominator counts reference reviewers only, so a run of one reviewer no bare run uses is 0 of 2 rather than 1 of 3.
			expect(reviewerRun.coverage).toEqual({ kind: "partial", ranReviewerNames: ["Default"], ranReferenceReviewerCount: 0, referenceReviewerCount: 2 })
		})

		it("claims a full run for a selection spelled in a different case", async () => {
			const readAgents = mockReader(new Map([
				[userDirectory, [{ name: "Security", prompt: "Security prompt" }]],
				[builtinDirectory, []],
			]))

			const reviewerRun = await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => ["security"])

			expect(reviewerRun.agents.map((agent: Agent) => agent.name)).toEqual(["Security"])
			expect(reviewerRun.coverage).toEqual({ kind: "full", reviewerCount: 1 })
		})

		it("reads each prompt directory exactly once", async () => {
			// The coverage claim is derived from the same read that resolves the agents, so no second read can describe a different directory state than the run used.
			const readDirectories: string[] = []
			const readAgents: AgentReader = async (directory) => {
				readDirectories.push(directory)
				if (directory === userDirectory) return [{ name: "Security", prompt: "Security prompt" }]
				return [{ name: "Default", prompt: "Default prompt" }]
			}

			await loadReviewerRun({ readAgents }, userDirectory, builtinDirectory, () => "run all agents")

			expect(readDirectories).toEqual([userDirectory, builtinDirectory])
		})
	})
})

describe("loadAggregator", () => {
	it("returns user aggregator when it exists", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "Aggregator", prompt: "User aggregator" }]],
			[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const aggregator = await loadAggregator({ readAgents }, userDirectory, builtinDirectory)

		expect(aggregator.prompt).toBe("User aggregator")
	})

	it("returns builtin aggregator when no user aggregator exists", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const readAgents = mockReader(new Map([
			[userDirectory, []],
			[builtinDirectory, [{ name: "Aggregator", prompt: "Builtin aggregator" }]],
		]))

		const aggregator = await loadAggregator({ readAgents }, userDirectory, builtinDirectory)

		expect(aggregator.prompt).toBe("Builtin aggregator")
	})

	it("matches aggregator case-insensitively", async () => {
		const userDirectory = "/user"
		const builtinDirectory = "/builtins"
		const readAgents = mockReader(new Map([
			[userDirectory, [{ name: "aggregator", prompt: "Lowercase aggregator" }]],
			[builtinDirectory, []],
		]))

		const aggregator = await loadAggregator({ readAgents }, userDirectory, builtinDirectory)

		expect(aggregator.name).toBe("aggregator")
	})
})