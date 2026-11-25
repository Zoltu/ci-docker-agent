import { describe, it, expect } from "bun:test"
import { REVIEW_START_LABEL, REVIEWER_LABEL_PREFIX, isTriggerLabel, selectAgentNamesFromLabels, selectLabelNamesToRemove } from "../source/labels.mts"

const availableAgentNames = ["Architect", "Bug Hunter", "Defender", "Security", "Default"]

// A well-formed selector label is spelled from the constants, so the input names and the expected messages cannot drift apart.
function selectorLabel(agentName: string): string {
	return `${REVIEWER_LABEL_PREFIX}${agentName}`
}

// The near-miss failure is asserted in full, so a message that dropped the required spelling or the offending label fails the test.
function nearMissSelectorMessage(labelName: string): string {
	return `Invalid selector label "${labelName}": a selector label must be spelled "${REVIEWER_LABEL_PREFIX}<Name>", with a capital "R", a spaced hyphen, and <Name> matching an agent prompt file name exactly and case-sensitively. Remove the label or correct its spelling.`
}

describe("isTriggerLabel", () => {
	describe("accepted spellings", () => {
		it("accepts the review start label itself", () => {
			expect(isTriggerLabel(REVIEW_START_LABEL)).toBe(true)
		})

		it("accepts a lowercased spelling", () => {
			expect(isTriggerLabel(REVIEW_START_LABEL.toLowerCase())).toBe(true)
		})

		it("accepts an uppercased spelling", () => {
			expect(isTriggerLabel(REVIEW_START_LABEL.toUpperCase())).toBe(true)
		})

		it("accepts a spelling whose capitalization varies per letter", () => {
			expect(isTriggerLabel("rEvIeW sTaRt")).toBe(true)
		})
	})

	describe("other values", () => {
		it("rejects a label whose words are swapped", () => {
			expect(isTriggerLabel("Start Review")).toBe(false)
		})

		it("rejects a pluralized label", () => {
			expect(isTriggerLabel("Review Starts")).toBe(false)
		})

		it("rejects the review start label with trailing whitespace", () => {
			// Ignoring case is the only tolerance, so a value that differs by anything else stays a mismatch.
			expect(isTriggerLabel(`${REVIEW_START_LABEL} `)).toBe(false)
		})

		it("rejects an empty value", () => {
			expect(isTriggerLabel("")).toBe(false)
		})
	})
})

describe("selectAgentNamesFromLabels", () => {
	describe("no selector", () => {
		it("returns 'run all agents' when no label is present", () => {
			expect(selectAgentNamesFromLabels([], availableAgentNames)).toBe("run all agents")
		})

		it("ignores the trigger label", () => {
			expect(selectAgentNamesFromLabels([REVIEW_START_LABEL], availableAgentNames)).toBe("run all agents")
		})

		it("ignores a label that does not look like a selector", () => {
			expect(selectAgentNamesFromLabels([REVIEW_START_LABEL, "bug", "documentation"], availableAgentNames)).toBe("run all agents")
		})

		it("ignores a label whose shortened selector word is not followed by a hyphen", () => {
			expect(selectAgentNamesFromLabels([REVIEW_START_LABEL, "review pending", "needs-review"], availableAgentNames)).toBe("run all agents")
		})
	})

	describe("near-miss spellings", () => {
		it("fails when the prefix differs only in capitalization", () => {
			expect(() => selectAgentNamesFromLabels(["reviewer - Security"], availableAgentNames)).toThrow(nearMissSelectorMessage("reviewer - Security"))
		})

		it("fails on a pluralized prefix", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewers - Security"], availableAgentNames)).toThrow(nearMissSelectorMessage("Reviewers - Security"))
		})

		it("fails when the space before the hyphen is missing", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer- Security"], availableAgentNames)).toThrow(nearMissSelectorMessage("Reviewer- Security"))
		})

		it("fails when the space after the hyphen is missing", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer -Security"], availableAgentNames)).toThrow(nearMissSelectorMessage("Reviewer -Security"))
		})

		it("fails on a shortened selector word", () => {
			expect(() => selectAgentNamesFromLabels(["Review - Security"], availableAgentNames)).toThrow(nearMissSelectorMessage("Review - Security"))
		})

		it("fails on a label that only begins with the selector word", () => {
			expect(() => selectAgentNamesFromLabels(["reviewer-pending"], availableAgentNames)).toThrow(nearMissSelectorMessage("reviewer-pending"))
		})

		it("fails on a label that begins with the shortened selector word and a hyphen", () => {
			expect(() => selectAgentNamesFromLabels(["review-needed"], availableAgentNames)).toThrow(nearMissSelectorMessage("review-needed"))
		})

		it("fails instead of selecting every agent", () => {
			// The failure mode this guards against is a run that reviews with every agent because the near-miss label selected nothing.
			expect(() => selectAgentNamesFromLabels([REVIEW_START_LABEL, "reviewer - Security"], availableAgentNames)).toThrow()
		})

		it("fails even when a valid selector is also present", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Security"), "Reviewers - Style"], availableAgentNames)).toThrow(nearMissSelectorMessage("Reviewers - Style"))
		})

		it("fails on a selector label with no agent name at all", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer -"], availableAgentNames)).toThrow(nearMissSelectorMessage("Reviewer -"))
		})

		it("escapes control characters in a rejected near-miss label name", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewers - Evil\nFORGED\u2028NEXT"], availableAgentNames)).toThrow(`Invalid selector label "Reviewers - Evil\\u000aFORGED\\u2028NEXT": a selector label must be spelled "${REVIEWER_LABEL_PREFIX}<Name>"`)
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

		it("escapes control characters in the available agent names it lists", () => {
			expect(() => selectAgentNamesFromLabels([selectorLabel("Nope")], ["Architect\nFORGED"])).toThrow("Available agents: Architect\\u000aFORGED.")
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

describe("selectLabelNamesToRemove", () => {
	describe("trigger label", () => {
		it("removes the trigger label when it is the only label", () => {
			expect(selectLabelNamesToRemove([REVIEW_START_LABEL], REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL])
		})

		it("removes nothing when the pull request carries no labels", () => {
			expect(selectLabelNamesToRemove([], REVIEW_START_LABEL)).toEqual([])
		})

		it("removes the trigger label first even when it is listed last", () => {
			expect(selectLabelNamesToRemove([selectorLabel("Security"), REVIEW_START_LABEL], REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL, selectorLabel("Security")])
		})
	})

	describe("selector labels", () => {
		it("removes every selector label after the trigger label, in the order the pull request lists them", () => {
			const labelNames = [REVIEW_START_LABEL, selectorLabel("Security"), selectorLabel("Architect")]

			expect(selectLabelNamesToRemove(labelNames, REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL, selectorLabel("Security"), selectorLabel("Architect")])
		})

		it("removes a selector label that no run could honour, because removal runs before validation", () => {
			const labelNames = [REVIEW_START_LABEL, selectorLabel("Bogus"), selectorLabel("All"), selectorLabel("Aggregator")]

			expect(selectLabelNamesToRemove(labelNames, REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL, selectorLabel("Bogus"), selectorLabel("All"), selectorLabel("Aggregator")])
		})

		it("removes a selector label whose agent name keeps the prefix spacing", () => {
			expect(selectLabelNamesToRemove([selectorLabel(" Bug Hunter")], REVIEW_START_LABEL)).toEqual([selectorLabel(" Bug Hunter")])
		})
	})

	describe("labels that are not selectors", () => {
		it("keeps unrelated labels in place", () => {
			expect(selectLabelNamesToRemove([REVIEW_START_LABEL, "bug", "documentation", "review pending", "needs-review"], REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL])
		})

		it("removes the trigger label and no other label when no selector is present", () => {
			expect(selectLabelNamesToRemove(["bug", REVIEW_START_LABEL, "documentation"], REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL])
		})
	})

	describe("near-miss spellings", () => {
		it("keeps every near-miss spelling, because removal keys on the exact prefix", () => {
			const nearMissLabelNames = ["reviewer - Security", "Reviewers - Security", "Reviewer- Security", "Reviewer -Security", "Review - Security", "reviewer-pending", "review-needed"]

			expect(selectLabelNamesToRemove([REVIEW_START_LABEL, ...nearMissLabelNames], REVIEW_START_LABEL)).toEqual([REVIEW_START_LABEL])
		})

		it("keeps a near miss while removing the selector labels around it", () => {
			const labelNames = [selectorLabel("Security"), "Reviewer- Architect", selectorLabel("Defender")]

			expect(selectLabelNamesToRemove(labelNames, REVIEW_START_LABEL)).toEqual([selectorLabel("Security"), selectorLabel("Defender")])
		})
	})
})
