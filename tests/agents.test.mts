import { describe, it, expect } from "bun:test"
import { buildAgentPrompt } from "../source/agents.mts"
import type { Agent, AgentDirs } from "../source/agents.mts"
import type { PrFile } from "../source/github-types.mts"

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
		blob_url: "",
		raw_url: "",
		contents_url: "",
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

describe("AgentDirs", () => {
	it("has expected shape", () => {
		const dirs: AgentDirs = {
			userAgentsDir: "/tmp/user-agents",
			builtinAgentsDir: "/tmp/builtin-agents",
		}

		expect(dirs.userAgentsDir).toBe("/tmp/user-agents")
		expect(dirs.builtinAgentsDir).toBe("/tmp/builtin-agents")
	})
})
