import { describe, it, expect } from "bun:test"
import { getBaseCommitContext } from "../source/base-commit.mts"
import { makeSpawnGit, ok, error } from "./helpers.mts"

describe("getBaseCommitContext", () => {
	it("returns file list from mocked git output", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("README.md\npackage.json\n")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual(["README.md", "package.json"])
	})

	it("returns empty file list when no files", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual([])
	})

	it("includes dotfiles in file list", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok(".gitignore\n.eslintrc\n")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual([".gitignore", ".eslintrc"])
	})

	it("throws when ls-tree fails", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", error("fatal: Not a valid object name")],
		]))

		expect(getBaseCommitContext({ spawnGit }, "abc123")).rejects.toThrow("Failed to list files in base commit")
	})
})
