import { describe, it, expect } from "bun:test"
import { buildAgentPrompt } from "../source/agents.mts"
import { makeAgent, makeBaseCommitContext } from "./helpers.mts"
import { existsSync } from "node:fs"
import { join } from "node:path"

const PROJECT_ROOT = join(import.meta.dir, "..")

const SAMPLE_DIFF = [
	"diff --git a/src/file.ts b/src/file.ts",
	"--- a/src/file.ts",
	"+++ b/src/file.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
].join("\n")

describe("buildAgentPrompt", () => {
	it("includes repository file list from base commit", () => {
		const agent = makeAgent()
		const result = buildAgentPrompt(agent, makeBaseCommitContext({
			fileList: ["README.md", "src/index.ts"],
		}), "")

		expect(result).toContain("=== Repository Files (Base Commit) ===")
		expect(result).toContain("- README.md")
		expect(result).toContain("- src/index.ts")
	})

	it("includes file contents from base commit", () => {
		const agent = makeAgent()
		const result = buildAgentPrompt(agent, makeBaseCommitContext({
			fileList: ["README.md", "src/index.ts"],
			fileContents: new Map([["README.md", "# Project"], ["src/index.ts", "console.log('hello')"]]),
		}), "")

		expect(result).toContain("=== File Contents (Base Commit) ===")
		expect(result).toContain("=== README.md ===")
		expect(result).toContain("# Project")
		expect(result).toContain("=== src/index.ts ===")
		expect(result).toContain("console.log('hello')")
	})

	it("includes changeset diffs", () => {
		const agent = makeAgent()
		const result = buildAgentPrompt(agent, makeBaseCommitContext(), SAMPLE_DIFF)

		expect(result).toContain("=== Changeset Diffs ===")
		expect(result).toContain("@@ -1 +1 @@")
		expect(result).toContain("-old")
		expect(result).toContain("+new")
	})

	it("includes agent feedback when agentInputs provided", () => {
		const agent = makeAgent()
		const inputs = new Map<string, string>()
		inputs.set("SecurityAgent", "Found a vulnerability")
		inputs.set("StyleAgent", "Use camelCase")

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), "", inputs)

		expect(result).toContain("=== Agent Feedback ===")
		expect(result).toContain("=== Agent: SecurityAgent ===")
		expect(result).toContain("Found a vulnerability")
		expect(result).toContain("=== Agent: StyleAgent ===")
		expect(result).toContain("Use camelCase")
	})

	it("does not include agent feedback section when agentInputs is empty", () => {
		const agent = makeAgent()
		const inputs = new Map<string, string>()

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), "", inputs)

		expect(result).not.toContain("=== Agent Feedback ===")
	})

	it("does not include agent feedback section when agentInputs is undefined", () => {
		const agent = makeAgent()

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), "")

		expect(result).not.toContain("=== Agent Feedback ===")
	})

	it("places agent instructions at the end", () => {
		const agent = makeAgent({ prompt: "You are a reviewer." })

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), SAMPLE_DIFF)

		expect(result.endsWith("You are a reviewer.")).toBe(true)
	})

	it("includes agent instructions section", () => {
		const agent = makeAgent({ prompt: "You are a reviewer." })

		const result = buildAgentPrompt(agent, makeBaseCommitContext(), "")

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
