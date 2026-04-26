import { describe, it, expect } from "bun:test"
import { parseUnifiedDiff, mapGitStatus, parseNumstat, createGenerateLocalDiff, createSpawnGitDiff, buildLocalDiff } from "../source/diff.mts"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PROJECT_ROOT = join(import.meta.dir, "..")

async function gitRevParse(ref: string, cwd: string): Promise<string> {
	const process = Bun.spawn(["git", "rev-parse", ref], { cwd, stderr: "pipe", stdout: "pipe" })
	await process.exited
	expect(process.exitCode).toBe(0)
	return await Bun.readableStreamToText(process.stdout)
}

describe("parseUnifiedDiff", () => {
	it("parses a modified file diff", () => {
		const diff = [
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1,2 +1,2 @@",
			"-old line",
			"+new line",
		].join("\n")

		const result = parseUnifiedDiff(diff)

		expect(result.has("src/file.ts")).toBe(true)
		expect(result.get("src/file.ts")).toContain("-old line")
		expect(result.get("src/file.ts")).toContain("+new line")
	})

	it("parses a new file diff with /dev/null source", () => {
		const diff = [
			"--- /dev/null",
			"+++ b/src/new-file.ts",
			"@@ -0,0 +1,3 @@",
			"+line 1",
			"+line 2",
			"+line 3",
		].join("\n")

		const result = parseUnifiedDiff(diff)

		expect(result.has("src/new-file.ts")).toBe(true)
		expect(result.get("src/new-file.ts")).toContain("+line 1")
		expect(result.get("src/new-file.ts")).toContain("+line 3")
	})

	it("parses a deleted file diff with /dev/null target", () => {
		const diff = [
			"--- a/src/old-file.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-line 1",
			"-line 2",
		].join("\n")

		const result = parseUnifiedDiff(diff)

		expect(result.has("src/old-file.ts")).toBe(true)
		expect(result.get("src/old-file.ts")).toContain("-line 1")
	})

	it("parses multiple files in one diff", () => {
		const diff = [
			"--- a/src/file1.ts",
			"+++ b/src/file1.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"--- /dev/null",
			"+++ b/src/file2.ts",
			"@@ -0,0 +1 @@",
			"+added",
		].join("\n")

		const result = parseUnifiedDiff(diff)

		expect(result.size).toBe(2)
		expect(result.has("src/file1.ts")).toBe(true)
		expect(result.has("src/file2.ts")).toBe(true)
	})

	it("uses the +++ b/ name as the key (handles renames)", () => {
		const diff = [
			"--- a/src/old-name.ts",
			"+++ b/src/new-name.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")

		const result = parseUnifiedDiff(diff)

		expect(result.has("src/new-name.ts")).toBe(true)
		expect(result.has("src/old-name.ts")).toBe(false)
	})

	it("returns empty map for empty input", () => {
		const result = parseUnifiedDiff("")

		expect(result.size).toBe(0)
	})

	it("includes the --- and +++ header lines in the patch", () => {
		const diff = [
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")

		const result = parseUnifiedDiff(diff)
		const patch = result.get("src/file.ts")!

		expect(patch).toContain("--- a/src/file.ts")
		expect(patch).toContain("+++ b/src/file.ts")
	})
})

describe("mapGitStatus", () => {
	it("maps A to added", () => {
		expect(mapGitStatus("A")).toBe("added")
	})

	it("maps D to deleted", () => {
		expect(mapGitStatus("D")).toBe("removed")
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

	it("maps R100 (rename with score) to renamed", () => {
		expect(mapGitStatus("R100")).toBe("renamed")
	})

	it("maps C080 (copy with score) to copied", () => {
		expect(mapGitStatus("C080")).toBe("copied")
	})

	it("maps T to modified", () => {
		expect(mapGitStatus("T")).toBe("modified")
	})

	it("throws for unknown status", () => {
		expect(() => mapGitStatus("X")).toThrow('Unknown git status code: "X"')
	})

	it("throws for empty string", () => {
		expect(() => mapGitStatus("")).toThrow('Unknown git status code: ""')
	})
})

describe("parseNumstat", () => {
	it("parses a single file", () => {
		const output = "1\t2\tsrc/file.ts"
		const result = parseNumstat(output)

		expect(result.stats.size).toBe(1)
		expect(result.stats.get("src/file.ts")).toEqual({ additions: 1, deletions: 2 })
		expect(result.binaryFiles).toEqual([])
	})

	it("parses multiple files", () => {
		const output = [
			"1\t2\tsrc/file1.ts",
			"3\t4\tsrc/file2.ts",
		].join("\n")
		const result = parseNumstat(output)

		expect(result.stats.size).toBe(2)
		expect(result.stats.get("src/file1.ts")).toEqual({ additions: 1, deletions: 2 })
		expect(result.stats.get("src/file2.ts")).toEqual({ additions: 3, deletions: 4 })
		expect(result.binaryFiles).toEqual([])
	})

	it("tracks binary files (additions and deletions are '-')", () => {
		const output = "-\t-\tsrc/image.png"
		const result = parseNumstat(output)

		expect(result.stats.size).toBe(0)
		expect(result.binaryFiles).toEqual(["src/image.png"])
	})

	it("skips lines with fewer than 3 tab-separated fields", () => {
		const output = "incomplete"
		const result = parseNumstat(output)

		expect(result.stats.size).toBe(0)
		expect(result.binaryFiles).toEqual([])
	})

	it("returns empty result for empty input", () => {
		const result = parseNumstat("")

		expect(result.stats.size).toBe(0)
		expect(result.binaryFiles).toEqual([])
	})
})

describe("buildLocalDiff", () => {
	it("builds PullRequestFiles from name-status, unified diff, and numstat output", () => {
		const nameStatus = [
			"M\tsrc/file.ts",
		].join("\n")
		const unified = [
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1,2 +1,2 @@",
			"-old line",
			"+new line",
		].join("\n")
		const numstat = { stats: new Map([["src/file.ts", { additions: 1, deletions: 1 }]]), binaryFiles: [] }

		const { files, binaryFiles } = buildLocalDiff(nameStatus, unified, numstat)

		expect(files).toHaveLength(1)
		expect(files[0]!.filename).toBe("src/file.ts")
		expect(files[0]!.status).toBe("modified")
		expect(files[0]!.additions).toBe(1)
		expect(files[0]!.deletions).toBe(1)
		expect(files[0]!.changes).toBe(2)
		expect(files[0]!.patch).toContain("+new line")
		expect(binaryFiles).toEqual([])
	})

	it("handles added files", () => {
		const nameStatus = "A\tsrc/new.ts"
		const unified = [
			"--- /dev/null",
			"+++ b/src/new.ts",
			"@@ -0,0 +1,2 @@",
			"+line1",
			"+line2",
		].join("\n")
		const numstat = { stats: new Map([["src/new.ts", { additions: 2, deletions: 0 }]]), binaryFiles: [] }

		const { files, binaryFiles } = buildLocalDiff(nameStatus, unified, numstat)

		expect(files).toHaveLength(1)
		expect(files[0]!.status).toBe("added")
		expect(files[0]!.additions).toBe(2)
		expect(files[0]!.deletions).toBe(0)
		expect(binaryFiles).toEqual([])
	})

	it("handles deleted files", () => {
		const nameStatus = "D\tsrc/old.ts"
		const unified = [
			"--- a/src/old.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-line1",
			"-line2",
		].join("\n")
		const numstat = { stats: new Map([["src/old.ts", { additions: 0, deletions: 2 }]]), binaryFiles: [] }

		const { files, binaryFiles } = buildLocalDiff(nameStatus, unified, numstat)

		expect(files).toHaveLength(1)
		expect(files[0]!.status).toBe("removed")
		expect(files[0]!.additions).toBe(0)
		expect(files[0]!.deletions).toBe(2)
		expect(binaryFiles).toEqual([])
	})

	it("defaults additions and deletions to 0 when file not in numstat", () => {
		const nameStatus = "M\tsrc/unknown.ts"
		const unified = [
			"--- a/src/unknown.ts",
			"+++ b/src/unknown.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")
		const numstat = { stats: new Map<string, { additions: number; deletions: number }>(), binaryFiles: [] }

		const { files, binaryFiles } = buildLocalDiff(nameStatus, unified, numstat)

		expect(files).toHaveLength(1)
		expect(files[0]!.additions).toBe(0)
		expect(files[0]!.deletions).toBe(0)
		expect(files[0]!.changes).toBe(0)
		expect(binaryFiles).toEqual([])
	})

	it("returns empty result for empty name-status output", () => {
		const { files, binaryFiles } = buildLocalDiff("", "", { stats: new Map(), binaryFiles: [] })
		expect(files).toEqual([])
		expect(binaryFiles).toEqual([])
	})

	it("handles multiple files", () => {
		const nameStatus = [
			"M\tsrc/file1.ts",
			"A\tsrc/file2.ts",
		].join("\n")
		const unified = [
			"--- a/src/file1.ts",
			"+++ b/src/file1.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"--- /dev/null",
			"+++ b/src/file2.ts",
			"@@ -0,0 +1 @@",
			"+added",
		].join("\n")
		const numstat = {
			stats: new Map([
				["src/file1.ts", { additions: 1, deletions: 1 }],
				["src/file2.ts", { additions: 1, deletions: 0 }],
			]),
			binaryFiles: [],
		}

		const { files, binaryFiles } = buildLocalDiff(nameStatus, unified, numstat)

		expect(files).toHaveLength(2)
		expect(files[0]!.filename).toBe("src/file1.ts")
		expect(files[1]!.filename).toBe("src/file2.ts")
		expect(binaryFiles).toEqual([])
	})

	it("passes through binary files from numstat", () => {
		const nameStatus = "M\tsrc/image.png"
		const unified = ""
		const numstat = { stats: new Map(), binaryFiles: ["src/image.png"] }

		const { files, binaryFiles } = buildLocalDiff(nameStatus, unified, numstat)

		expect(files).toHaveLength(1)
		expect(binaryFiles).toEqual(["src/image.png"])
	})
})

describe("createGenerateLocalDiff", () => {
	it("returns well-formed PullRequestFiles from a real git diff", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()
		const head1 = (await gitRevParse("HEAD~1", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGitDiff(PROJECT_ROOT))
		const { files, binaryFiles } = await generateLocalDiff(head1, head)

		expect(files.length).toBeGreaterThan(0)
		for (const file of files) {
			expect(file.filename).toBeTruthy()
			expect(["added", "removed", "modified", "renamed", "copied"]).toContain(file.status)
			expect(typeof file.additions).toBe("number")
			expect(typeof file.deletions).toBe("number")
			expect(file.changes).toBe(file.additions + file.deletions)
		}
		expect(Array.isArray(binaryFiles)).toBe(true)
	})

	it("returns empty result for identical commits", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGitDiff(PROJECT_ROOT))
		const { files, binaryFiles } = await generateLocalDiff(head, head)

		expect(files).toEqual([])
		expect(binaryFiles).toEqual([])
	})

	it("throws when workspace is not a git repository", async () => {
		const notAGitRepo = import.meta.dir

		const generateLocalDiff = createGenerateLocalDiff(notAGitRepo, createSpawnGitDiff(notAGitRepo))
		expect(generateLocalDiff("abc123", "def456")).rejects.toThrow("No git repository found")
	})

	it("throws when base commit does not exist", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGitDiff(PROJECT_ROOT))
		expect(generateLocalDiff("nonexistent000000", head)).rejects.toThrow("Base commit")
	})

	it("throws when head commit does not exist", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const base = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGitDiff(PROJECT_ROOT))
		expect(generateLocalDiff(base, "nonexistent000000")).rejects.toThrow("Head commit")
	})
})
