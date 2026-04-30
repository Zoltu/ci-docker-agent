import { describe, it, expect } from "bun:test"
import { getBaseCommitContext, TEXT_FILE_EXTENSIONS, BINARY_FILE_EXTENSIONS, AMBIGUOUS_FILE_EXTENSIONS } from "../source/base-commit.mts"
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

describe("getBaseCommitContext", () => {
	it("returns file list and contents from a real commit", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const { createSpawnGit } = await import("../source/diff.mts")
		const spawnGit = createSpawnGit(PROJECT_ROOT)
		const head = (await spawnGit(["rev-parse", "HEAD"])).stdout.trim()

		const context = await getBaseCommitContext({ spawnGit }, head)

		expect(context.fileList.length).toBeGreaterThan(0)
		expect(context.fileList).toContain("source/index.mts")
		expect(context.fileContents.has("source/index.mts")).toBe(true)
		expect(context.fileContents.has("package.json")).toBe(true)
	})

	it("includes text files in fileContents", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("README.md\npackage.json\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["show abc123:README.md", ok("# Project")],
			["show abc123:package.json", ok('{"name": "test"}')],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual(["README.md", "package.json"])
		expect(context.fileContents.get("README.md")).toBe("# Project")
		expect(context.fileContents.get("package.json")).toBe('{"name": "test"}')
	})

	it("excludes binary files from fileContents", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("logo.png\nREADME.md\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["show abc123:README.md", ok("# Project")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual(["logo.png", "README.md"])
		expect(context.fileContents.has("logo.png")).toBe(false)
		expect(context.fileContents.get("README.md")).toBe("# Project")
	})

	it("includes dotfiles as text", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok(".gitignore\n.eslintrc\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["show abc123:.gitignore", ok("node_modules/\n")],
			["show abc123:.eslintrc", ok('{"root": true}\n')],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual([".gitignore", ".eslintrc"])
		expect(context.fileContents.get(".gitignore")).toBe("node_modules/\n")
		expect(context.fileContents.get(".eslintrc")).toBe('{"root": true}\n')
	})

	it("throws when file read fails", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("src/index.ts\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["show abc123:src/index.ts", err("fatal: Path 'src/index.ts' does not exist")],
		]))

		expect(getBaseCommitContext({ spawnGit }, "abc123")).rejects.toThrow("Failed to read file src/index.ts at commit abc123")
	})

	it("includes ambiguous file with text content in fileContents", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("module.mts\nREADME.md\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["show abc123:module.mts", ok("export function hello() { return 42 }\n")],
			["show abc123:README.md", ok("# Project")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual(["module.mts", "README.md"])
		expect(context.fileContents.has("module.mts")).toBe(true)
		expect(context.fileContents.get("module.mts")).toBe("export function hello() { return 42 }\n")
		expect(context.fileContents.get("README.md")).toBe("# Project")
	})

	it("excludes ambiguous file with binary content from fileContents", async () => {
		const binaryContent = "\x00\x00\x00\x00ftypisom"
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("video.mts\nREADME.md\n")],
			["ls-tree abc123 -- .gitignore", ok("")],
			["show abc123:video.mts", ok(binaryContent)],
			["show abc123:README.md", ok("# Project")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual(["video.mts", "README.md"])
		expect(context.fileContents.has("video.mts")).toBe(false)
		expect(context.fileContents.get("README.md")).toBe("# Project")
	})

	it("respects .gitignore patterns", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["ls-tree -r --name-only abc123", ok("src/index.ts\nnode_modules/foo/index.js\nREADME.md\n")],
			["ls-tree abc123 -- .gitignore", ok("100644 blob abcdef .gitignore\n")],
			["show abc123:.gitignore", ok("node_modules/\n")],
			["show abc123:src/index.ts", ok("export const x = 1\n")],
			["show abc123:README.md", ok("# Project")],
		]))
		const context = await getBaseCommitContext({ spawnGit }, "abc123")

		expect(context.fileList).toEqual(["src/index.ts", "README.md"])
		expect(context.fileContents.get("src/index.ts")).toBe("export const x = 1\n")
		expect(context.fileContents.get("README.md")).toBe("# Project")
	})
})

describe("file extension sets", () => {
	it("has no duplicates across text, binary, and ambiguous extension sets", () => {
		const allExtensions = [
			...[...TEXT_FILE_EXTENSIONS].map(ext => [ext, "text"] as const),
			...[...BINARY_FILE_EXTENSIONS].map(ext => [ext, "binary"] as const),
			...[...AMBIGUOUS_FILE_EXTENSIONS].map(ext => [ext, "ambiguous"] as const),
		]
		const seen = new Map<string, string>()
		for (const [ext, setName] of allExtensions) {
			const existing = seen.get(ext)
			if (existing) {
				throw new Error(`Extension "${ext}" appears in both "${existing}" and "${setName}" sets`)
			}
			seen.set(ext, setName)
		}
	})
})
