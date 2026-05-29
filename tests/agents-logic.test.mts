import { describe, it, expect } from "bun:test"
import { buildAgentPrompt, type PromptMessage } from "../source/agents.mts"
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

function filterByRole(messages: readonly PromptMessage[], role: "system" | "user"): string[] {
	return messages.filter(m => m.role === role).map(m => m.content)
}

describe("buildAgentPrompt", () => {
	describe("message structure", () => {
		it("places agent instructions in a system message", () => {
			const agent = makeAgent({ prompt: "You are a reviewer." })
			const result = buildAgentPrompt(agent, makeBaseCommitContext(), "")

			expect(result[0]).toEqual({ role: "system", content: "You are a reviewer." })
		})

		it("places file list header in a system message", () => {
			const agent = makeAgent()
			const result = buildAgentPrompt(agent, makeBaseCommitContext({
				fileList: ["README.md", "src/index.ts"],
			}), "")

			expect(result).toContainEqual({ role: "system", content: "=== Repository Files (Base Commit) ===" })
		})

		it("places file list content in a user message", () => {
			const agent = makeAgent()
			const result = buildAgentPrompt(agent, makeBaseCommitContext({
				fileList: ["README.md", "src/index.ts"],
			}), "")

			expect(result).toContainEqual({ role: "user", content: "- README.md\n- src/index.ts" })
		})

		it("places diff header in a system message", () => {
			const agent = makeAgent()
			const result = buildAgentPrompt(agent, makeBaseCommitContext(), SAMPLE_DIFF)

			expect(result).toContainEqual({ role: "system", content: "=== Changeset Diffs ===" })
		})

		it("places diff content in a user message", () => {
			const agent = makeAgent()
			const result = buildAgentPrompt(agent, makeBaseCommitContext(), SAMPLE_DIFF)

			expect(result).toContainEqual({ role: "user", content: SAMPLE_DIFF })
		})

		it("places agent feedback header in a system message", () => {
			const agent = makeAgent()
			const inputs = new Map<string, string>()
			inputs.set("SecurityAgent", "Found a vulnerability")

			const result = buildAgentPrompt(agent, makeBaseCommitContext(), "", inputs)

			expect(result).toContainEqual({ role: "system", content: "=== Agent Feedback ===" })
		})

		it("places each agent name in a system message and output in a user message", () => {
			const agent = makeAgent()
			const inputs = new Map<string, string>()
			inputs.set("SecurityAgent", "Found a vulnerability")
			inputs.set("StyleAgent", "Use camelCase")

			const result = buildAgentPrompt(agent, makeBaseCommitContext(), "", inputs)

			expect(result).toContainEqual({ role: "system", content: "=== Agent: SecurityAgent ===" })
			expect(result).toContainEqual({ role: "user", content: "Found a vulnerability" })
			expect(result).toContainEqual({ role: "system", content: "=== Agent: StyleAgent ===" })
			expect(result).toContainEqual({ role: "user", content: "Use camelCase" })
		})

		it("does not include agent feedback when agentInputs is empty", () => {
			const agent = makeAgent()
			const inputs = new Map<string, string>()

			const result = buildAgentPrompt(agent, makeBaseCommitContext(), "", inputs)

			const systemContents = filterByRole(result, "system")
			expect(systemContents).not.toContain("=== Agent Feedback ===")
		})

		it("does not include agent feedback when agentInputs is undefined", () => {
			const agent = makeAgent()

			const result = buildAgentPrompt(agent, makeBaseCommitContext(), "")

			const systemContents = filterByRole(result, "system")
			expect(systemContents).not.toContain("=== Agent Feedback ===")
		})
	})

	describe("message ordering", () => {
		it("places agent instructions before all other messages", () => {
			const agent = makeAgent({ prompt: "You are a reviewer." })
			const result = buildAgentPrompt(agent, makeBaseCommitContext(), SAMPLE_DIFF)

			expect(result[0]!.role).toBe("system")
			expect(result[0]!.content).toBe("You are a reviewer.")
		})

		it("places file list before diff", () => {
			const agent = makeAgent()
			const result = buildAgentPrompt(agent, makeBaseCommitContext({
				fileList: ["README.md"],
			}), SAMPLE_DIFF)

			const fileHeaderIndex = result.findIndex(m => m.content === "=== Repository Files (Base Commit) ===")
			const diffHeaderIndex = result.findIndex(m => m.content === "=== Changeset Diffs ===")
			expect(fileHeaderIndex).toBeLessThan(diffHeaderIndex)
		})

		it("places diff before agent feedback", () => {
			const agent = makeAgent()
			const inputs = new Map<string, string>()
			inputs.set("SecurityAgent", "Found a vulnerability")

			const result = buildAgentPrompt(agent, makeBaseCommitContext(), SAMPLE_DIFF, inputs)

			const diffHeaderIndex = result.findIndex(m => m.content === "=== Changeset Diffs ===")
			const feedbackHeaderIndex = result.findIndex(m => m.content === "=== Agent Feedback ===")
			expect(diffHeaderIndex).toBeLessThan(feedbackHeaderIndex)
		})

		it("alternates system headers with user content", () => {
			const agent = makeAgent()
			const inputs = new Map<string, string>()
			inputs.set("SecurityAgent", "Found a vulnerability")

			const result = buildAgentPrompt(agent, makeBaseCommitContext({
				fileList: ["README.md"],
			}), SAMPLE_DIFF, inputs)

			for (let i = 1; i < result.length; i++) {
				const prev = result[i - 1]!.role
				const curr = result[i]!.role
				if (!((prev === "system" && (curr === "system" || curr === "user")) || (prev === "user" && curr === "system"))) {
					throw new Error(`Unexpected role transition at index ${i}: ${prev} -> ${curr}`)
				}
			}
		})
	})

	describe("trust boundary", () => {
		it("never puts untrusted content in system messages", () => {
			const agent = makeAgent({ prompt: "You are a reviewer." })
			const inputs = new Map<string, string>()
			inputs.set("SecurityAgent", "Found a vulnerability")

			const result = buildAgentPrompt(agent, makeBaseCommitContext({
				fileList: ["README.md"],
			}), SAMPLE_DIFF, inputs)

			const systemContents = filterByRole(result, "system")
			for (const content of systemContents) {
				expect(content).not.toContain("-old")
				expect(content).not.toContain("+new")
				expect(content).not.toContain("- README.md")
				expect(content).not.toContain("Found a vulnerability")
			}
		})

		it("never puts system-controlled headers in user messages", () => {
			const agent = makeAgent({ prompt: "You are a reviewer." })
			const inputs = new Map<string, string>()
			inputs.set("SecurityAgent", "Found a vulnerability")

			const result = buildAgentPrompt(agent, makeBaseCommitContext({
				fileList: ["README.md"],
			}), SAMPLE_DIFF, inputs)

			const userContents = filterByRole(result, "user")
			for (const content of userContents) {
				expect(content).not.toContain("=== Repository Files")
				expect(content).not.toContain("=== Changeset Diffs")
				expect(content).not.toContain("=== Agent Feedback")
				expect(content).not.toContain("=== Agent:")
				expect(content).not.toContain("You are a reviewer.")
			}
		})
	})
})

// Exception to AGENTS.md rule against testing leaf functions: these tests verify that the required builtin agents exist on disk, since the entire system breaks if the agents/ folder or Default.md/Aggregator.md are missing.
describe("required builtin agents", () => {
	it("has a Default.md agent in the agents directory", () => {
		expect(existsSync(join(PROJECT_ROOT, "agents", "Default.md"))).toBe(true)
	})

	it("has an Aggregator.md agent in the agents directory", () => {
		expect(existsSync(join(PROJECT_ROOT, "agents", "Aggregator.md"))).toBe(true)
	})
})
