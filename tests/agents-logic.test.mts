import { describe, it, expect } from "bun:test"
import { buildAgentPrompt, resolveAgents } from "../source/agents.mts"
import type { Agent } from "../source/agents.mts"
import type { PrFile } from "../source/github-types.mts"
import { existsSync } from "node:fs"
import { join } from "node:path"

const PROJECT_ROOT = join(import.meta.dir, "..")

function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return { name: "TestAgent", prompt: "Review the code.", ...overrides }
}

function makePrFile(overrides: Partial<PrFile> = {}): PrFile {
	return {
		filename: "src/file.ts",
		status: "modified",
		additions: 5,
		deletions: 2,
		changes: 7,
		patch: "@@ -1,2 +1,5 @@\n-old line\n+new line",
		...overrides,
	}
}

describe("buildAgentPrompt", () => {
	it("starts with the agent prompt", () => {
		const agent = makeAgent({ prompt: "You are a reviewer." })
		const result = buildAgentPrompt(agent, [])

		expect(result.startsWith("You are a reviewer.")).toBe(true)
	})

	it("includes file context", () => {
		const agent = makeAgent()
		const files = [makePrFile({ filename: "src/app.ts", status: "added", additions: 10, deletions: 0 })]

		const result = buildAgentPrompt(agent, files)

		expect(result).toContain("src/app.ts")
		expect(result).toContain("added")
		expect(result).toContain("+10")
		expect(result).toContain("-0")
	})

	it("includes patch when present", () => {
		const agent = makeAgent()
		const files = [makePrFile({ patch: "@@ -1 +1 @@\n-old\n+new" })]

		const result = buildAgentPrompt(agent, files)

		expect(result).toContain("Patch:")
		expect(result).toContain("@@ -1 +1 @@\n-old\n+new")
	})

	it("omits patch section when patch is undefined", () => {
		const agent = makeAgent()
		const files = [makePrFile({ patch: undefined })]

		const result = buildAgentPrompt(agent, files)

		expect(result).not.toContain("Patch:")
	})

	it("includes agent feedback when agentInputs provided", () => {
		const agent = makeAgent()
		const inputs = new Map<string, string>()
		inputs.set("SecurityAgent", "Found a vulnerability")
		inputs.set("StyleAgent", "Use camelCase")

		const result = buildAgentPrompt(agent, [], inputs)

		expect(result).toContain("=== Agent Feedback ===")
		expect(result).toContain("=== Agent: SecurityAgent ===")
		expect(result).toContain("Found a vulnerability")
		expect(result).toContain("=== Agent: StyleAgent ===")
		expect(result).toContain("Use camelCase")
	})

	it("does not include agent feedback section when agentInputs is empty", () => {
		const agent = makeAgent()
		const inputs = new Map<string, string>()

		const result = buildAgentPrompt(agent, [], inputs)

		expect(result).not.toContain("=== Agent Feedback ===")
	})

	it("does not include agent feedback section when agentInputs is undefined", () => {
		const agent = makeAgent()

		const result = buildAgentPrompt(agent, [])

		expect(result).not.toContain("=== Agent Feedback ===")
	})

	it("includes multiple files", () => {
		const agent = makeAgent()
		const files = [
			makePrFile({ filename: "a.ts" }),
			makePrFile({ filename: "b.ts" }),
		]

		const result = buildAgentPrompt(agent, files)

		expect(result).toContain("a.ts")
		expect(result).toContain("b.ts")
	})
})

describe("required builtin agents", () => {
	it("has a Default.md agent in the agents directory", () => {
		expect(existsSync(join(PROJECT_ROOT, "agents", "Default.md"))).toBe(true)
	})

	it("has an Aggregator.md agent in the agents directory", () => {
		expect(existsSync(join(PROJECT_ROOT, "agents", "Aggregator.md"))).toBe(true)
	})
})

describe("resolveAgents", () => {
	it("defaults to Default when 'run all agents' and no user agents", () => {
		const defaultAgent = makeAgent({ name: "Default" })
		const result = resolveAgents("run all agents", [], [defaultAgent])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
		expect(result.unresolvedNames).toEqual([])
	})

	it("defaults to all user agents when 'run all agents' and user agents exist", () => {
		const security = makeAgent({ name: "SecurityAgent" })
		const style = makeAgent({ name: "StyleAgent" })
		const result = resolveAgents("run all agents", [security, style], [])

		expect(result.agents).toHaveLength(2)
		expect(result.agents.map(a => a.name)).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("resolves named agents from user agents first", () => {
		const userAgent = makeAgent({ name: "SecurityAgent", prompt: "user" })
		const builtinAgent = makeAgent({ name: "SecurityAgent", prompt: "builtin" })
		const result = resolveAgents(["SecurityAgent"], [userAgent], [builtinAgent])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("user")
	})

	it("resolves named agents from builtins when not in user agents", () => {
		const builtinAgent = makeAgent({ name: "Default", prompt: "builtin" })
		const result = resolveAgents(["Default"], [], [builtinAgent])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("builtin")
	})

	it("reports unresolved names while returning resolved agents", () => {
		const security = makeAgent({ name: "SecurityAgent" })
		const result = resolveAgents(["SecurityAgent", "NonExistent"], [security], [])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
		expect(result.unresolvedNames).toEqual(["NonExistent"])
	})

	it("resolves names case-insensitively", () => {
		const security = makeAgent({ name: "SecurityAgent" })
		const result = resolveAgents(["securityagent"], [security], [])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
	})

	it("filters out Aggregator from user agents when 'run all agents'", () => {
		const aggregator = makeAgent({ name: "Aggregator" })
		const security = makeAgent({ name: "SecurityAgent" })
		const result = resolveAgents("run all agents", [aggregator, security], [])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
	})

	it("filters out Aggregator from builtin agents when 'run all agents'", () => {
		const aggregator = makeAgent({ name: "Aggregator" })
		const defaultAgent = makeAgent({ name: "Default" })
		const result = resolveAgents("run all agents", [], [aggregator, defaultAgent])

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
	})

	it("throws for duplicate agent names", () => {
		const security = makeAgent({ name: "SecurityAgent" })
		expect(() => resolveAgents(["SecurityAgent", "SecurityAgent"], [security], [])).toThrow(
			'Duplicate agent name: "SecurityAgent"'
		)
	})

	it("throws for case-insensitive duplicate agent names", () => {
		const security = makeAgent({ name: "SecurityAgent" })
		expect(() => resolveAgents(["SecurityAgent", "securityagent"], [security], [])).toThrow(
			'Duplicate agent name: "securityagent"'
		)
	})
})
