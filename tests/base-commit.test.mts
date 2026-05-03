import { describe, it, expect } from "bun:test"
import { getBaseCommitContext } from "../source/base-commit.mts"
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
	it("returns file list from a real commit", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const spawnGit: SpawnGit = async (parameters) => {
			const process = Bun.spawn(["git", ...parameters], { cwd: PROJECT_ROOT, stderr: "pipe", stdout: "pipe" })
			await process.exited
			const stdout = await Bun.readableStreamToText(process.stdout)
			const stderr = await Bun.readableStreamToText(process.stderr)
			return { stdout, stderr, exitCode: process.exitCode, signalCode: process.signalCode }
		}
		const head = (await spawnGit(["rev-parse", "HEAD"])).stdout.trim()

		const context = await getBaseCommitContext({ spawnGit }, head)

		expect(context.fileList.length).toBeGreaterThan(0)
		expect(context.fileList).toContain("source/index.mts")
	})

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
			["ls-tree -r --name-only abc123", err("fatal: Not a valid object name")],
		]))

		expect(getBaseCommitContext({ spawnGit }, "abc123")).rejects.toThrow("Failed to list files in base commit")
	})
})
