import { describe, it, expect } from "bun:test"
import { buildAgentPrompt, loadReviewerRun, loadSelectedAgents, type Agent, type AgentReader, type PromptMessage } from "../source/agents.mts"
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

const referenceUserDirectory = "/user"
const referenceBuiltinDirectory = "/builtins"

// The reference set is internal to `agents.mts`, so these cases exercise it through a run with no selector label, which resolves exactly that set.
async function resolvedReviewerNames(userAgents: readonly Agent[]): Promise<readonly string[]> {
	const readAgents: AgentReader = async (directory) => {
		if (directory === referenceUserDirectory) return [...userAgents]
		return [{ name: "Default", prompt: "Builtin default prompt." }, { name: "Aggregator", prompt: "Aggregate." }]
	}
	const reviewerRun = await loadReviewerRun({ readAgents }, referenceUserDirectory, referenceBuiltinDirectory, () => "run all agents")
	return reviewerRun.agents.map(agent => agent.name)
}

// The offered list is reachable only through the exported entry point, and it is the production contract because the label selector receives exactly it and selects from it.
async function offeredAgentNames(userAgents: readonly Agent[], builtinAgents: readonly Agent[]): Promise<readonly string[]> {
	let offered: readonly string[] | undefined
	const readAgents: AgentReader = async directory => directory === referenceUserDirectory ? [...userAgents] : [...builtinAgents]
	await loadSelectedAgents({ readAgents }, referenceUserDirectory, referenceBuiltinDirectory, names => {
		offered = names
		// An empty offer must select nothing, because the sentinel would resolve the built-in `Default` agent and these fixtures provide no prompt for it.
		if (names.length === 0) return []
		return "run all agents"
	})
	return offered!
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

describe("loadSelectedAgents offered agent names", () => {
	it("excludes the aggregator so no available-agent message advertises it", async () => {
		const offered = await offeredAgentNames(
			[makeAgent({ name: "Security" })],
			[makeAgent({ name: "Default" }), makeAgent({ name: "Aggregator" })],
		)

		expect(offered).toEqual(["Security", "Default"])
	})

	it("excludes the aggregator in any capitalization", async () => {
		const offered = await offeredAgentNames([], [makeAgent({ name: "aggregator" }), makeAgent({ name: "Default" })])

		expect(offered).toEqual(["Default"])
	})

	it("names a user agent that shadows a builtin name once", async () => {
		const offered = await offeredAgentNames(
			[makeAgent({ name: "Default", prompt: "User default prompt." })],
			[makeAgent({ name: "Default", prompt: "Builtin default prompt." })],
		)

		expect(offered).toEqual(["Default"])
	})

	it("names a user agent that shadows a builtin name in different capitalization once", async () => {
		const offered = await offeredAgentNames([makeAgent({ name: "default" })], [makeAgent({ name: "Default" })])

		expect(offered).toEqual(["default"])
	})

	it("lists user agents before builtin agents", async () => {
		const offered = await offeredAgentNames([makeAgent({ name: "Security" })], [makeAgent({ name: "Architect" })])

		expect(offered).toEqual(["Security", "Architect"])
	})

	it("returns nothing when every agent is the aggregator", async () => {
		expect(await offeredAgentNames([makeAgent({ name: "Aggregator" })], [makeAgent({ name: "aggregator" })])).toEqual([])
	})

	it("rejects two prompt files whose names differ only by case", async () => {
		// A selector label matches a name case-sensitively against this list, so a list built from both files would accept the label and run only the one the map kept.
		await expect(offeredAgentNames([makeAgent({ name: "Security" }), makeAgent({ name: "security", prompt: "Lowercase prompt." })], [])).rejects.toThrow(
			'Duplicate agent prompt file names: "Security" and "security". Two prompt files whose names differ only by case are one reviewer, so only one of them would ever run; rename or delete one of them.'
		)
	})

	it("rejects two builtin prompt files whose names differ only by case", async () => {
		await expect(offeredAgentNames([], [makeAgent({ name: "Security" }), makeAgent({ name: "SECURITY" })])).rejects.toThrow(
			'Duplicate agent prompt file names: "Security" and "SECURITY"'
		)
	})
})

describe("loadReviewerRun with no selector labels", () => {
	it("names every user agent in the order the directory listed them", async () => {
		expect(await resolvedReviewerNames([makeAgent({ name: "Bug Hunter" }), makeAgent({ name: "Security" })])).toEqual(["Bug Hunter", "Security"])
	})

	it("excludes the aggregator, which always runs last", async () => {
		expect(await resolvedReviewerNames([makeAgent({ name: "Security" }), makeAgent({ name: "Aggregator" })])).toEqual(["Security"])
	})

	it("excludes the aggregator in any capitalization", async () => {
		expect(await resolvedReviewerNames([makeAgent({ name: "aggregator" }), makeAgent({ name: "Security" })])).toEqual(["Security"])
	})

	it("rejects two prompt files that differ only by case, because one of them could never run", async () => {
		// Resolution matches a requested name case-insensitively, so a run that accepted both names would review with one prompt where a maintainer wrote two and never learn about it.
		await expect(resolvedReviewerNames([makeAgent({ name: "Security" }), makeAgent({ name: "security", prompt: "Lowercase prompt." })])).rejects.toThrow(
			'Duplicate agent prompt file names: "Security" and "security"'
		)
	})

	it("escapes a prompt file name that would forge a line in the duplicate message", async () => {
		await expect(resolvedReviewerNames([makeAgent({ name: "Evil\u000aFORGED LOG LINE" }), makeAgent({ name: "EVIL\u000aFORGED LOG LINE" })])).rejects.toThrow(
			'Duplicate agent prompt file names: "Evil\\u000aFORGED LOG LINE" and "EVIL\\u000aFORGED LOG LINE"'
		)
	})

	it("falls back to the built-in Default reviewer when the repository ships no agent prompt", async () => {
		expect(await resolvedReviewerNames([])).toEqual(["Default"])
	})

	it("falls back to the built-in Default reviewer when every prompt is the aggregator", async () => {
		expect(await resolvedReviewerNames([makeAgent({ name: "Aggregator" })])).toEqual(["Default"])
	})

	it("adds no builtin reviewer to a set of user agents", async () => {
		// A builtin reviewer is never part of a run without selectors unless the repository ships no prompt of its own, so counting it would make every full review look partial.
		expect(await resolvedReviewerNames([makeAgent({ name: "Security" })])).toEqual(["Security"])
	})
})
