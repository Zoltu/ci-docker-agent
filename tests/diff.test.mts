import { describe, it, expect } from "bun:test"
import { parseUnifiedDiff, mapGitStatus, generateLocalDiff } from "../source/diff.mts"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PROJECT_ROOT = join(import.meta.dir, "..")

async function gitRevParse(ref: string, cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", ref], { cwd, stderr: "pipe", stdout: "pipe" })
	await proc.exited
	expect(proc.exitCode).toBe(0)
	return await Bun.readableStreamToText(proc.stdout)
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

describe("generateLocalDiff", () => {
	it("returns well-formed PrFiles from a real git diff", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()
		const head1 = (await gitRevParse("HEAD~1", PROJECT_ROOT)).trim()

		const files = await generateLocalDiff(head1, head, PROJECT_ROOT)

		expect(files.length).toBeGreaterThan(0)
		for (const file of files) {
			expect(file.filename).toBeTruthy()
			expect(["added", "removed", "modified", "renamed", "copied"]).toContain(file.status)
			expect(typeof file.additions).toBe("number")
			expect(typeof file.deletions).toBe("number")
			expect(file.changes).toBe(file.additions + file.deletions)
		}
	})

	it("returns empty array for identical commits", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const files = await generateLocalDiff(head, head, PROJECT_ROOT)

		expect(files).toEqual([])
	})

	it("throws when workspace is not a git repo", async () => {
		const notAGitRepo = import.meta.dir

		expect(generateLocalDiff("abc123", "def456", notAGitRepo)).rejects.toThrow("No git repository found")
	})

	it("throws when base commit does not exist", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		expect(generateLocalDiff("nonexistent000000", head, PROJECT_ROOT)).rejects.toThrow("Base commit")
	})

	it("throws when head commit does not exist", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const base = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		expect(generateLocalDiff(base, "nonexistent000000", PROJECT_ROOT)).rejects.toThrow("Head commit")
	})
})
