import { describe, it, expect } from "bun:test"
import { findIgnoredSelectorLabels, formatIgnoredSelectorNotice, REVIEW_START_LABEL, REVIEWER_LABEL_PREFIX, selectAgentNamesFromLabels } from "../source/labels.mts"

const availableAgentNames = ["Architect", "Bug Hunter", "Defender", "Security", "Default"]

// A well-formed selector label is spelled from the constants, so the input names and the expected messages cannot drift apart.
function selectorLabel(agentName: string): string {
	return `${REVIEWER_LABEL_PREFIX}${agentName}`
}

describe("selectAgentNamesFromLabels", () => {
	describe("no selector", () => {
		it("returns 'run all agents' when no label is present", () => {
			expect(selectAgentNamesFromLabels([], availableAgentNames)).toBe("run all agents")
		})

		it("ignores the trigger label", () => {
			expect(selectAgentNamesFromLabels([REVIEW_START_LABEL], availableAgentNames)).toBe("run all agents")
		})
	})

	describe("near-miss prefixes", () => {
		it("ignores a prefix that differs only in capitalization", () => {
			expect(selectAgentNamesFromLabels(["reviewer - Security"], availableAgentNames)).toBe("run all agents")
		})

		it("ignores a pluralized prefix", () => {
			expect(selectAgentNamesFromLabels(["Reviewers - Security"], availableAgentNames)).toBe("run all agents")
		})

		it("ignores a prefix without the space before the dash", () => {
			expect(selectAgentNamesFromLabels(["Reviewer- Security"], availableAgentNames)).toBe("run all agents")
		})
	})

	describe("specific selectors", () => {
		it("selects a single named agent", () => {
			expect(selectAgentNamesFromLabels([selectorLabel("Security")], availableAgentNames)).toEqual(["Security"])
		})

		it("preserves spaces inside the selected agent name", () => {
			expect(selectAgentNamesFromLabels([selectorLabel("Bug Hunter")], availableAgentNames)).toEqual(["Bug Hunter"])
		})

		it("selects every agent named by a selector label", () => {
			const selection = selectAgentNamesFromLabels([selectorLabel("Security"), REVIEW_START_LABEL, selectorLabel("Architect")], availableAgentNames)
			// Agents run concurrently, so only the selected set is contract; the order the labels happen to be in is not.
			if (selection === "run all agents") throw new Error("Expected the selector labels to name agents instead of falling back to every reviewer")

			expect([...selection].sort()).toEqual(["Architect", "Security"])
		})

		it("selects a builtin agent by name", () => {
			expect(selectAgentNamesFromLabels([selectorLabel("Default")], availableAgentNames)).toEqual(["Default"])
		})
	})

	describe("validation errors", () => {
		it("throws when the label name differs from the agent name only in case", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Bug Hunter")], ["bug hunter"])).toThrow("names no available agent")
		})

		it("lists the available agents when the label names an unknown agent", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Nope")], availableAgentNames)).toThrow(`Invalid selector label "${selectorLabel("Nope")}": it names no available agent, and a label's agent name is matched case-sensitively. Available agents: Architect, Bug Hunter, Defender, Security, Default.`)
		})

		it("escapes control characters in a rejected unknown selector label name", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Nope\nFORGED\u2028NEXT")], availableAgentNames)).toThrow(`Invalid selector label "${REVIEWER_LABEL_PREFIX}Nope\\u000aFORGED\\u2028NEXT": it names no available agent`)
		})

		it("rejects the Aggregator selector without reporting it as an unknown agent", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Aggregator")], availableAgentNames)).toThrow(`"${selectorLabel("Aggregator")}" is a configuration error`)
		})

		it("rejects the Aggregator selector before checking whether the name is available", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Aggregator")], ["Architect"])).toThrow("the Aggregator always runs last automatically")
		})

		it("reports a label whose agent name only starts with the aggregator name as an unknown selector", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Aggregator\nFORGED")], availableAgentNames)).toThrow(`Invalid selector label "${REVIEWER_LABEL_PREFIX}Aggregator\\u000aFORGED": it names no available agent`)
		})

		it("rejects a lowercased aggregator selector with the aggregator failure rather than the unknown-selector failure", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("aggregator")], availableAgentNames)).toThrow(`"${selectorLabel("aggregator")}" is a configuration error: the Aggregator always runs last automatically and must not be selected. Remove the label.`)
		})

		it("throws when the selector has extra whitespace after the prefix", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel(" Bug Hunter")], availableAgentNames)).toThrow("names no available agent")
		})
	})
})

describe("findIgnoredSelectorLabels", () => {
	it("returns nothing when every label is the trigger label or a valid selector", () => {
		expect(findIgnoredSelectorLabels([REVIEW_START_LABEL, selectorLabel("Security")])).toEqual([])
	})

	it("returns the selector-like labels that selected nothing", () => {
		expect(findIgnoredSelectorLabels([REVIEW_START_LABEL, "Reviewers - Security", "reviewer - Architect"])).toEqual(["Reviewers - Security", "reviewer - Architect"])
	})

	it("returns an unrelated label that merely starts with the selector-like word", () => {
		// The matcher stays deliberately loose: a false positive on an unrelated label costs one advisory log line, while a missed selector-like label hides why the run ignored it.
		expect(findIgnoredSelectorLabels(["reviewer-needed"])).toEqual(["reviewer-needed"])
	})

	it("returns nothing when no label looks like a selector", () => {
		expect(findIgnoredSelectorLabels([REVIEW_START_LABEL, "bug", "documentation"])).toEqual([])
	})
})

describe("formatIgnoredSelectorNotice", () => {
	it("returns nothing when no selector-like label was ignored", () => {
		expect(formatIgnoredSelectorNotice([], "run all agents")).toBeUndefined()
	})

	it("returns nothing when the only selector label is a valid one", () => {
		const labelNames = [REVIEW_START_LABEL, selectorLabel("Security")]
		const selection = selectAgentNamesFromLabels(labelNames, availableAgentNames)

		expect(formatIgnoredSelectorNotice(findIgnoredSelectorLabels(labelNames), selection)).toBeUndefined()
	})

	it("states that every reviewer runs when no valid selector selected an agent", () => {
		expect(formatIgnoredSelectorNotice(["Reviewers - Security"], "run all agents")).toBe(`Ignoring "Reviewers - Security": a selector label must start with "${REVIEWER_LABEL_PREFIX}", so it selects nothing, and every reviewer runs.`)
	})

	it("does not state that every reviewer runs when a valid selector is present", () => {
		const notice = formatIgnoredSelectorNotice(["Reviewers - Style"], ["Security"])
		if (notice === undefined) throw new Error("Expected an ignored-selector notice for the ignored label")

		expect(notice).toBe(`Ignoring "Reviewers - Style": a selector label must start with "${REVIEWER_LABEL_PREFIX}", so it selects nothing, and the run uses only the agents named by valid selector labels.`)
		expect(notice).not.toContain("every reviewer runs")
	})

	it("pluralizes the selection sentence for several ignored labels", () => {
		expect(formatIgnoredSelectorNotice(["Reviewers - Security", "reviewer - Architect"], "run all agents")).toBe(`Ignoring "Reviewers - Security", "reviewer - Architect": a selector label must start with "${REVIEWER_LABEL_PREFIX}", so they select nothing, and every reviewer runs.`)
	})

	it("escapes control characters and line separators in an ignored label name", () => {
		const notice = formatIgnoredSelectorNotice(["Reviewers - Evil\nFORGED\u2028NEXT"], "run all agents")
		if (notice === undefined) throw new Error("Expected an ignored-selector notice for the ignored label")

		expect(notice).toContain(`Ignoring "Reviewers - Evil\\u000aFORGED\\u2028NEXT"`)
		expect(notice).not.toContain("\n")
		expect(notice).not.toContain("\u2028")
	})
})
