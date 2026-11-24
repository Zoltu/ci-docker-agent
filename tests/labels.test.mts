import { describe, it, expect } from "bun:test"
import { selectAgentNamesFromLabels } from "../source/labels.mts"

const availableAgentNames = ["Architect", "Bug Hunter", "Defender", "Security", "Default", "Aggregator"]

describe("selectAgentNamesFromLabels", () => {
	describe("no selector", () => {
		it("returns 'run all agents' when no label is present", () => {
			expect(selectAgentNamesFromLabels([], availableAgentNames)).toBe("run all agents")
		})

		it("ignores the trigger label", () => {
			expect(selectAgentNamesFromLabels(["Review Start"], availableAgentNames)).toBe("run all agents")
		})
	})

	describe("specific selectors", () => {
		it("selects a single named agent", () => {
			expect(selectAgentNamesFromLabels(["Reviewer - Security"], availableAgentNames)).toEqual(["Security"])
		})

		it("preserves spaces inside the selected agent name", () => {
			expect(selectAgentNamesFromLabels(["Reviewer - Bug Hunter"], availableAgentNames)).toEqual(["Bug Hunter"])
		})

		it("selects several agents in label order", () => {
			expect(selectAgentNamesFromLabels(["Reviewer - Security", "Review Start", "Reviewer - Architect"], availableAgentNames)).toEqual(["Security", "Architect"])
		})

		it("selects a builtin agent by name", () => {
			expect(selectAgentNamesFromLabels(["Reviewer - Default"], availableAgentNames)).toEqual(["Default"])
		})
	})

	describe("validation errors", () => {
		it("throws when the label name differs from the agent name only in case", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer - Bug Hunter"], ["bug hunter"])).toThrow("names no available agent")
		})

		it("lists the available agents when the label names an unknown agent", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer - Nope"], availableAgentNames)).toThrow("Label \"Reviewer - Nope\" names no available agent. Available agents: Architect, Bug Hunter, Defender, Security, Default, Aggregator.")
		})

		it("rejects the Aggregator selector even though an Aggregator agent is available", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer - Aggregator"], availableAgentNames)).toThrow("\"Reviewer - Aggregator\" is a configuration error")
		})

		it("rejects the Aggregator selector before checking whether the name is available", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer - Aggregator"], ["Architect"])).toThrow("the Aggregator always runs last automatically")
		})

		it("treats a mis-cased Aggregator selector as an unknown agent", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer - aggregator"], availableAgentNames)).toThrow("names no available agent")
		})

		it("throws when the selector has extra whitespace after the prefix", () => {
			expect(() => selectAgentNamesFromLabels(["Reviewer -  Bug Hunter"], availableAgentNames)).toThrow("names no available agent")
		})
	})
})
