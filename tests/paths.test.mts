import { describe, it, expect } from "bun:test"
import { getWorkspaceDirectory } from "../source/paths.mts"

describe("getWorkspaceDirectory", () => {
	it("returns GITHUB_WORKSPACE when set", () => {
		expect(getWorkspaceDirectory({ GITHUB_WORKSPACE: "/custom/workspace" })).toBe("/custom/workspace")
	})

	it("returns /workspace fallback when GITHUB_WORKSPACE is not set", () => {
		expect(getWorkspaceDirectory({})).toBe("/workspace")
	})

	it("returns /workspace fallback when GITHUB_WORKSPACE is undefined", () => {
		expect(getWorkspaceDirectory({ GITHUB_WORKSPACE: undefined })).toBe("/workspace")
	})
})
