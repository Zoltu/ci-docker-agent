import { describe, it, expect } from "bun:test"
import { buildAgentPrompt, selectAllReviewerNames, selectableAgentNames, type PromptMessage } from "../source/agents.mts"
import { makeAgent, makeBaseCommitContext } from "./helpers.mts"

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

describe("selectableAgentNames", () => {
	it("excludes the aggregator so no available-agent message advertises it", () => {
		const result = selectableAgentNames(
			[makeAgent({ name: "Security" })],
			[makeAgent({ name: "Default" }), makeAgent({ name: "Aggregator" })],
		)

		expect(result).toEqual(["Security", "Default"])
	})

	it("excludes the aggregator in any capitalization", () => {
		const result = selectableAgentNames([], [makeAgent({ name: "aggregator" }), makeAgent({ name: "Default" })])

		expect(result).toEqual(["Default"])
	})

	it("names a user agent that shadows a builtin name once", () => {
		const result = selectableAgentNames(
			[makeAgent({ name: "Default", prompt: "User default prompt." })],
			[makeAgent({ name: "Default", prompt: "Builtin default prompt." })],
		)

		expect(result).toEqual(["Default"])
	})

	it("names a user agent that shadows a builtin name in different capitalization once", () => {
		const result = selectableAgentNames([makeAgent({ name: "default" })], [makeAgent({ name: "Default" })])

		expect(result).toEqual(["default"])
	})

	it("lists user agents before builtin agents", () => {
		const result = selectableAgentNames([makeAgent({ name: "Security" })], [makeAgent({ name: "Architect" })])

		expect(result).toEqual(["Security", "Architect"])
	})

	it("returns nothing when every agent is the aggregator", () => {
		expect(selectableAgentNames([makeAgent({ name: "Aggregator" })], [makeAgent({ name: "aggregator" })])).toEqual([])
	})
})

describe("selectAllReviewerNames", () => {
	it("names every user agent in the order the directory listed them", () => {
		expect(selectAllReviewerNames([makeAgent({ name: "Bug Hunter" }), makeAgent({ name: "Security" })])).toEqual(["Bug Hunter", "Security"])
	})

	it("excludes the aggregator, which always runs last", () => {
		expect(selectAllReviewerNames([makeAgent({ name: "Security" }), makeAgent({ name: "Aggregator" })])).toEqual(["Security"])
	})

	it("excludes the aggregator in any capitalization", () => {
		expect(selectAllReviewerNames([makeAgent({ name: "aggregator" }), makeAgent({ name: "Security" })])).toEqual(["Security"])
	})

	it("falls back to the built-in Default reviewer when the repository ships no agent prompt", () => {
		expect(selectAllReviewerNames([])).toEqual(["Default"])
	})

	it("falls back to the built-in Default reviewer when every prompt is the aggregator", () => {
		expect(selectAllReviewerNames([makeAgent({ name: "Aggregator" })])).toEqual(["Default"])
	})

	it("adds no builtin reviewer to a set of user agents", () => {
		// A builtin reviewer is never part of a run without selectors unless the repository ships no prompt of its own, so counting it would make every full review look partial.
		expect(selectAllReviewerNames([makeAgent({ name: "Security" })])).toEqual(["Security"])
	})
})
