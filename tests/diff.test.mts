import { describe, it, expect } from "bun:test"
import { ensureCommitAvailable, validateGitEnvironment } from "../source/diff.mts"
import { makeSpawnGit, ok, error, timeout } from "./helpers.mts"

describe("ensureCommitAvailable", () => {
	it("returns immediately when commit is already available", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", ok("commit")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).resolves.toBeUndefined()
	})

	it("returns immediately when tag is already available", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t v1.0", ok("tag")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "v1.0")).resolves.toBeUndefined()
	})

	it("throws when object exists but is a tree", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t treeSha", ok("tree")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "treeSha")).rejects.toThrow("is a tree, not a commit")
	})

	it("throws when object exists but is a blob", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t blobSha", ok("blob")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "blobSha")).rejects.toThrow("is a blob, not a commit")
	})

	it("fetches commit when not locally available", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", error("fatal: Not a valid object name abc123")],
			["fetch --depth=1 origin abc123", ok("")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).resolves.toBeUndefined()
	})

	it("throws when fetch fails", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", error("fatal: Not a valid object name abc123")],
			["fetch --depth=1 origin abc123", error("fatal: Couldn't find remote ref abc123")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).rejects.toThrow("Failed to fetch commit abc123")
	})

	it("throws when fetch times out", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", error("fatal: Not a valid object name abc123")],
			["fetch --depth=1 origin abc123", timeout()],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).rejects.toThrow("timed out")
	})
})

describe("validateGitEnvironment", () => {
	it("throws when base commit is a tree", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["rev-parse --git-dir", ok(".git")],
			["cat-file -t treeSha", ok("tree")],
		]))

		expect(validateGitEnvironment({ spawnGit }, "treeSha", "def456", "/test/workspace")).rejects.toThrow("is a tree, not a commit")
	})

	it("throws when head commit is a blob", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["rev-parse --git-dir", ok(".git")],
			["cat-file -t abc123", ok("commit")],
			["cat-file -t blobSha", ok("blob")],
		]))

		expect(validateGitEnvironment({ spawnGit }, "abc123", "blobSha", "/test/workspace")).rejects.toThrow("is a blob, not a commit")
	})
})
