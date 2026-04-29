import { describe, it, expect } from "bun:test"
import { buildAgentPrompt, resolveAgents } from "../source/agents.mts"
import { makeAgent, makeDiffFile, makeDiffResult, makeBaseCommitContext } from "./helpers.mts"
import { existsSync } from "node:fs"
import { join } from "node:path"

const PROJECT_ROOT = join(import.meta.dir, "..")

describe("buildAgentPrompt", () => {
	it("includes repository file list from base commit", () => {
		const agent = makeAgent()
		const result = buildAgentPrompt(agent, makeBaseCommitContext({
			fileList: ["README.md", "src/index.ts"],
		}), makeDiffResult())

		expect(result).toContain("=== Repository Files (Base Commit) ===")
		expect(result).toContain("- README.md")
		expect(result).toContain("- src/index.ts")
	})

	it("includes file contents from base commit", () => {
		const agent = makeAgent()
		const result = buildAgentPrompt(agent, makeBaseCommitContext({
			fileList: ["README.md", "src/index.ts"],
			fileContents: new Map([["README.md", "# Project"], ["src/index.ts", "console.log('hello')"]]),
		}), makeDiffResult())

		expect(result).toContain("=== File Contents (Base Commit) ===")
		expect(result).toContain("=== README.md ===")
		expect(result).toContain("# Project")
		expect(result).toContain("=== src/index.ts ===")
		expect(result).toContain("console.log('hello')")
	})

	it("includes changeset statistics", () => {
		const agent = makeAgent()
		const diffResult = makeDiffResult({ files: [makeDiffFile({ filename: "src/app.ts", status: "added", additions: 10, deletions: 0 })] })

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), diffResult)

		expect(result).toContain("=== Changeset Statistics ===")
		expect(result).toContain("Total files changed: 1")
		expect(result).toContain("Additions: +10, Deletions: -0")
		expect(result).toContain("- src/app.ts (added): +10 -0")
	})

	it("includes changeset diffs for all files", () => {
		const agent = makeAgent()
		const diffResult = makeDiffResult({ files: [makeDiffFile({ patch: "@@ -1 +1 @@\n-old\n+new" })] })

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), diffResult)

		expect(result).toContain("=== Changeset Diffs ===")
		expect(result).toContain("@@ -1 +1 @@\n-old\n+new")
	})

	it("includes binary diff notifications", () => {
		const agent = makeAgent()
		const diffResult = makeDiffResult({ binaryFiles: ["logo.png"] })

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), diffResult)

		expect(result).toContain("=== Binary/Image Diffs ===")
		expect(result).toContain("- logo.png: binary diff present")
	})

	it("omits binary diff section when no binary files", () => {
		const agent = makeAgent()
		const result = buildAgentPrompt(agent, makeBaseCommitContext(), makeDiffResult())

		expect(result).not.toContain("=== Binary/Image Diffs ===")
	})

	it("includes agent feedback when agentInputs provided", () => {
		const agent = makeAgent()
		const inputs = new Map<string, string>()
		inputs.set("SecurityAgent", "Found a vulnerability")
		inputs.set("StyleAgent", "Use camelCase")

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), makeDiffResult(), inputs)

		expect(result).toContain("=== Agent Feedback ===")
		expect(result).toContain("=== Agent: SecurityAgent ===")
		expect(result).toContain("Found a vulnerability")
		expect(result).toContain("=== Agent: StyleAgent ===")
		expect(result).toContain("Use camelCase")
	})

	it("does not include agent feedback section when agentInputs is empty", () => {
		const agent = makeAgent()
		const inputs = new Map<string, string>()

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), makeDiffResult(), inputs)

		expect(result).not.toContain("=== Agent Feedback ===")
	})

	it("does not include agent feedback section when agentInputs is undefined", () => {
		const agent = makeAgent()

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), makeDiffResult())

		expect(result).not.toContain("=== Agent Feedback ===")
	})

	it("places agent instructions at the end", () => {
		const agent = makeAgent({ prompt: "You are a reviewer." })
		const diffResult = makeDiffResult({ files: [makeDiffFile()], binaryFiles: ["img.png"] })

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), diffResult)

		expect(result.endsWith("You are a reviewer.")).toBe(true)
	})

	it("includes agent instructions section", () => {
		const agent = makeAgent({ prompt: "You are a reviewer." })
		const result = buildAgentPrompt(agent, makeBaseCommitContext(), makeDiffResult())

		expect(result).toContain("=== Agent Instructions ===")
		expect(result).toContain("You are a reviewer.")
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
