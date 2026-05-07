import { describe, it, expect } from "bun:test"
import { ensureCommitAvailable } from "../source/diff.mts"
import { makeSpawnGit, ok, error, timeout } from "./helpers.mts"

describe("ensureCommitAvailable", () => {
	it("returns immediately when commit is already available", async () => {
		const spawnGit = makeSpawnGit(new Map([
			["cat-file -t abc123", ok("commit")],
		]))

		expect(ensureCommitAvailable({ spawnGit }, "abc123")).resolves.toBeUndefined()
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
