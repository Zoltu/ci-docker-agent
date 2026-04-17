import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { parseUnifiedDiff, mapGitStatus, generateLocalDiff } from "../source/diff.mts"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const TMP_ROOT = join(import.meta.dir, "__tmp_diff_repo__")

function tmpPath(...segments: string[]): string {
	return join(TMP_ROOT, ...segments)
}

async function createTmpDir(): Promise<void> {
	if (!existsSync(TMP_ROOT)) {
		await mkdir(TMP_ROOT, { recursive: true })
	}
}

async function cleanupTmp(): Promise<void> {
	if (existsSync(TMP_ROOT)) {
		await rm(TMP_ROOT, { recursive: true, force: true })
	}
}

async function gitInit(dir: string): Promise<void> {
	const proc = Bun.spawn(["git", "init"], { cwd: dir, stderr: "pipe", stdout: "pipe" })
	await proc.exited
	expect(proc.exitCode).toBe(0)
}

async function gitCommit(dir: string, message: string): Promise<string> {
	const addProc = Bun.spawn(["git", "add", "-A"], { cwd: dir, stderr: "pipe", stdout: "pipe" })
	await addProc.exited
	expect(addProc.exitCode).toBe(0)
	const commitProc = Bun.spawn(["git", "commit", "-m", message, "--author=test <test@test.com>"], {
		cwd: dir,
		stderr: "pipe",
		stdout: "pipe",
		env: { ...process.env, GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" },
	})
	await commitProc.exited
	expect(commitProc.exitCode).toBe(0)
	const revProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stderr: "pipe", stdout: "pipe" })
	await revProc.exited
	return (await Bun.readableStreamToText(revProc.stdout)).trim()
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
		expect(mapGitStatus("D")).toBe("deleted")
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

	it("maps unknown status to modified", () => {
		expect(mapGitStatus("X")).toBe("modified")
	})

	it("maps empty string to modified", () => {
		expect(mapGitStatus("")).toBe("modified")
	})
})

describe("generateLocalDiff", () => {
	beforeEach(cleanupTmp)
	afterEach(cleanupTmp)

	it("returns empty array for identical commits", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("file.txt"), "initial content\n")
		const commit = await gitCommit(TMP_ROOT, "initial commit")

		const files = await generateLocalDiff(commit, commit, TMP_ROOT)

		expect(files).toEqual([])
	})

	it("returns correct info for a modified file", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("file.txt"), "initial content\n")
		const baseCommit = await gitCommit(TMP_ROOT, "initial commit")
		await writeFile(tmpPath("file.txt"), "modified content\n")
		const headCommit = await gitCommit(TMP_ROOT, "modify file")

		const files = await generateLocalDiff(baseCommit, headCommit, TMP_ROOT)

		expect(files).toHaveLength(1)
		expect(files[0]!.filename).toBe("file.txt")
		expect(files[0]!.status).toBe("modified")
		expect(files[0]!.additions).toBe(1)
		expect(files[0]!.deletions).toBe(1)
		expect(files[0]!.patch).toBeDefined()
	})

	it("returns correct info for an added file with patch content", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("existing.txt"), "existing\n")
		const baseCommit = await gitCommit(TMP_ROOT, "initial commit")
		await writeFile(tmpPath("new-file.txt"), "new content\n")
		const headCommit = await gitCommit(TMP_ROOT, "add new file")

		const files = await generateLocalDiff(baseCommit, headCommit, TMP_ROOT)

		expect(files).toHaveLength(1)
		const newFile = files.find(f => f.filename === "new-file.txt")
		expect(newFile).toBeDefined()
		expect(newFile!.status).toBe("added")
		expect(newFile!.additions).toBe(1)
		expect(newFile!.deletions).toBe(0)
		expect(newFile!.patch).toBeDefined()
		expect(newFile!.patch).toContain("+new content")
	})

	it("returns correct info for a deleted file", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("to-delete.txt"), "will be deleted\n")
		const baseCommit = await gitCommit(TMP_ROOT, "initial commit")
		await rm(tmpPath("to-delete.txt"))
		const headCommit = await gitCommit(TMP_ROOT, "delete file")

		const files = await generateLocalDiff(baseCommit, headCommit, TMP_ROOT)

		expect(files).toHaveLength(1)
		expect(files[0]!.filename).toBe("to-delete.txt")
		expect(files[0]!.status).toBe("deleted")
		expect(files[0]!.deletions).toBe(1)
		expect(files[0]!.additions).toBe(0)
	})

	it("handles multiple files in one diff", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("file1.txt"), "original 1\n")
		await writeFile(tmpPath("file2.txt"), "original 2\n")
		const baseCommit = await gitCommit(TMP_ROOT, "initial commit")
		await writeFile(tmpPath("file1.txt"), "modified 1\n")
		await writeFile(tmpPath("file3.txt"), "new file\n")
		const headCommit = await gitCommit(TMP_ROOT, "multiple changes")

		const files = await generateLocalDiff(baseCommit, headCommit, TMP_ROOT)

		expect(files.length).toBeGreaterThanOrEqual(2)
		const filenames = files.map(f => f.filename)
		expect(filenames).toContain("file1.txt")
		expect(filenames).toContain("file3.txt")
	})

	it("throws when workspace is not a git repo", async () => {
		await createTmpDir()

		expect(generateLocalDiff("abc123", "def456", TMP_ROOT)).rejects.toThrow("No git repository found")
	})

	it("throws when base commit does not exist", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("file.txt"), "content\n")
		const headCommit = await gitCommit(TMP_ROOT, "initial commit")

		expect(generateLocalDiff("nonexistent000000", headCommit, TMP_ROOT)).rejects.toThrow("Base commit")
	})

	it("throws when head commit does not exist", async () => {
		await createTmpDir()
		await gitInit(TMP_ROOT)
		await writeFile(tmpPath("file.txt"), "content\n")
		const baseCommit = await gitCommit(TMP_ROOT, "initial commit")

		expect(generateLocalDiff(baseCommit, "nonexistent000000", TMP_ROOT)).rejects.toThrow("Head commit")
	})
})
