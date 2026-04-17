import { describe, it, expect } from "bun:test"
import { buildAgentPrompt } from "../source/agents.mts"
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
