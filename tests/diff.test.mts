import { describe, it, expect } from "bun:test"
import { ensureCommitAvailable } from "../source/diff.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"

function ok(stdout: string): GitDiffResult {
	return { stdout, stderr: "", exitCode: 0, signalCode: null }
}

function err(stderr: string): GitDiffResult {
	return { stdout: "", stderr, exitCode: 1, signalCode: null }
}

function timeout(): GitDiffResult {
	return { stdout: "", stderr: "", exitCode: null, signalCode: "SIGTERM" }
}

function makeSpawnGit(responses: Map<string, GitDiffResult>): SpawnGit {
	return async (parameters: string[]) => {
		const key = parameters.join(" ")
		const result = responses.get(key)
		if (result) return result
		throw new Error(`Unexpected spawnGit call: ${key}`)
	}
}

describe("ensureCommitAvailable", () => {
	it("returns immediately when commit is already available", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", ok("commit")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).resolves.toBeUndefined()
	})

	it("fetches commit when not locally available", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", err("fatal: Not a valid object name abc123")],
			["fetch --depth=1 origin abc123", ok("")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).resolves.toBeUndefined()
	})

	it("throws when fetch fails", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", err("fatal: Not a valid object name abc123")],
			["fetch --depth=1 origin abc123", err("fatal: Couldn't find remote ref abc123")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).rejects.toThrow("Failed to fetch commit abc123")
	})

	it("throws when fetch times out", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", err("fatal: Not a valid object name abc123")],
			["fetch --depth=1 origin abc123", timeout()],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).rejects.toThrow("timed out")
	})
})
