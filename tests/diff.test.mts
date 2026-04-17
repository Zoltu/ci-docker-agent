import { describe, it, expect } from "bun:test"
import { mapGitStatus } from "../source/diff.mts"

describe("mapGitStatus", () => {
	it("maps A to added", () => {
		expect(mapGitStatus("A")).toBe("added")
	})

	it("maps D to deleted", () => {
		expect(mapGitStatus("D")).toBe("deleted")
	})

	it("maps M to modified", () => {
		expect(mapGitStatus("M")).toBe("modified")
	})

	it("maps R to renamed", () => {
		expect(mapGitStatus("R")).toBe("renamed")
	})

	it("maps C to copied", () => {
		expect(mapGitStatus("C")).toBe("copied")
	})

	it("maps unknown status to modified", () => {
		expect(mapGitStatus("X")).toBe("modified")
	})

	it("maps empty string to modified", () => {
		expect(mapGitStatus("")).toBe("modified")
	})
})
