import { describe, it, expect } from "bun:test"
import { createGetBaseCommitContext } from "../source/base-commit.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PROJECT_ROOT = join(import.meta.dir, "..")

function makeSpawnGit(responses: Map<string, GitDiffResult>): SpawnGit {
	return async (parameters: string[]) => {
		const key = parameters.join(" ")
		const result = responses.get(key)
		if (result) return result
		throw new Error(`Unexpected spawnGit call: ${key}`)
	}
}

function ok(stdout: string): GitDiffResult {
	return { stdout, stderr: "", exitCode: 0, signalCode: null }
}

function err(stderr: string): GitDiffResult {
	return { stdout: "", stderr, exitCode: 1, signalCode: null }
}

describe("createGetBaseCommitContext", () => {
	it("returns file list and contents from a real commit", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const { createSpawnGit } = await import("../source/diff.mts")
		const spawnGit = createSpawnGit(PROJECT_ROOT)
		const getBaseCommitContext = createGetBaseCommitContext(spawnGit)
		const head = (await spawnGit(["rev-parse", "HEAD"])).stdout.trim()

		const context = await getBaseCommitContext(head)

		expect(context.fileList.length).toBeGreaterThan(0)
		expect(context.fileList).toContain("source/index.mts")
		expect(context.fileContents.has("source/index.mts")).toBe(true)
		expect(context.fileContents.get("source/index.mts")!.length).toBeGreaterThan(0)
	})

	it("includes text files in fileContents", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("README.md\npackage.json\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["ls-tree abc123 -- .dockerignore", ok("")],
			["show abc123:README.md", ok("# Project")],
			["show abc123:package.json", ok('{"name": "test"}')],
		]))
		const getBaseCommitContext = createGetBaseCommitContext(spawnGit)
		const context = await getBaseCommitContext("abc123")

		expect(context.fileList).toEqual(["README.md", "package.json"])
		expect(context.fileContents.get("README.md")).toBe("# Project")
		expect(context.fileContents.get("package.json")).toBe('{"name": "test"}')
	})

	it("excludes binary files from fileContents", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("logo.png\nREADME.md\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["ls-tree abc123 -- .dockerignore", ok("")],
			["show abc123:README.md", ok("# Project")],
		]))
		const getBaseCommitContext = createGetBaseCommitContext(spawnGit)
		const context = await getBaseCommitContext("abc123")

		expect(context.fileList).toEqual(["logo.png", "README.md"])
		expect(context.fileContents.has("logo.png")).toBe(false)
		expect(context.fileContents.get("README.md")).toBe("# Project")
	})

	it("includes dotfiles as text", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok(".gitignore\n.eslintrc\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["ls-tree abc123 -- .dockerignore", ok("")],
			["show abc123:.gitignore", ok("node_modules/\n")],
			["show abc123:.eslintrc", ok('{"root": true}\n')],
		]))
		const getBaseCommitContext = createGetBaseCommitContext(spawnGit)
		const context = await getBaseCommitContext("abc123")

		expect(context.fileList).toEqual([".gitignore", ".eslintrc"])
		expect(context.fileContents.get(".gitignore")).toBe("node_modules/\n")
		expect(context.fileContents.get(".eslintrc")).toBe('{"root": true}\n')
	})

	it("throws when file read fails", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("src/index.ts\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["ls-tree abc123 -- .dockerignore", ok("")],
			["show abc123:src/index.ts", err("fatal: Path 'src/index.ts' does not exist")],
		]))
		const getBaseCommitContext = createGetBaseCommitContext(spawnGit)

		await expect(getBaseCommitContext("abc123")).rejects.toThrow("Failed to read file src/index.ts at commit abc123")
	})
})
