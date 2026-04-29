import { describe, it, expect } from "bun:test"
import { parseDiffOutput, createGenerateLocalDiff, createSpawnGit } from "../source/diff.mts"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PROJECT_ROOT = join(import.meta.dir, "..")

async function gitRevParse(ref: string, cwd: string): Promise<string> {
	const process = Bun.spawn(["git", "rev-parse", ref], { cwd, stderr: "pipe", stdout: "pipe" })
	await process.exited
	expect(process.exitCode).toBe(0)
	return await Bun.readableStreamToText(process.stdout)
}

describe("parseDiffOutput", () => {
	it("parses a modified file diff", () => {
		const diff = [
			"diff --git a/src/file.ts b/src/file.ts",
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1,2 +1,2 @@",
			"-old line",
			"+new line",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(1)
		expect(result.files[0]!.filename).toBe("src/file.ts")
		expect(result.files[0]!.status).toBe("modified")
		expect(result.files[0]!.additions).toBe(1)
		expect(result.files[0]!.deletions).toBe(1)
		expect(result.files[0]!.patch).toContain("-old line")
		expect(result.files[0]!.patch).toContain("+new line")
		expect(result.binaryFiles).toEqual([])
	})

	it("parses a new file diff with /dev/null source", () => {
		const diff = [
			"diff --git a/src/new-file.ts b/src/new-file.ts",
			"--- /dev/null",
			"+++ b/src/new-file.ts",
			"@@ -0,0 +1,3 @@",
			"+line 1",
			"+line 2",
			"+line 3",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(1)
		expect(result.files[0]!.filename).toBe("src/new-file.ts")
		expect(result.files[0]!.status).toBe("added")
		expect(result.files[0]!.additions).toBe(3)
		expect(result.files[0]!.deletions).toBe(0)
	})

	it("parses a deleted file diff with /dev/null target", () => {
		const diff = [
			"diff --git a/src/old-file.ts b/src/old-file.ts",
			"--- a/src/old-file.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-line 1",
			"-line 2",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(1)
		expect(result.files[0]!.filename).toBe("src/old-file.ts")
		expect(result.files[0]!.status).toBe("removed")
		expect(result.files[0]!.additions).toBe(0)
		expect(result.files[0]!.deletions).toBe(2)
	})

	it("parses multiple files in one diff", () => {
		const diff = [
			"diff --git a/src/file1.ts b/src/file1.ts",
			"--- a/src/file1.ts",
			"+++ b/src/file1.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/src/file2.ts b/src/file2.ts",
			"--- /dev/null",
			"+++ b/src/file2.ts",
			"@@ -0,0 +1 @@",
			"+added",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(2)
		expect(result.files[0]!.filename).toBe("src/file1.ts")
		expect(result.files[1]!.filename).toBe("src/file2.ts")
	})

	it("detects renames when --- and +++ have different filenames", () => {
		const diff = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"--- a/src/old-name.ts",
			"+++ b/src/new-name.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(1)
		expect(result.files[0]!.filename).toBe("src/new-name.ts")
		expect(result.files[0]!.status).toBe("renamed")
	})

	it("detects binary files", () => {
		const diff = [
			"diff --git a/image.png b/image.png",
			"Binary files a/image.png and b/image.png differ",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(0)
		expect(result.binaryFiles).toEqual(["image.png"])
	})

	it("detects added binary files", () => {
		const diff = [
			"diff --git a/image.png b/image.png",
			"Binary files /dev/null and b/image.png differ",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.binaryFiles).toEqual(["image.png"])
	})

	it("detects removed binary files", () => {
		const diff = [
			"diff --git a/image.png b/image.png",
			"Binary files a/image.png and /dev/null differ",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.binaryFiles).toEqual(["image.png"])
	})

	it("returns empty result for empty input", () => {
		const result = parseDiffOutput("")

		expect(result.files).toEqual([])
		expect(result.binaryFiles).toEqual([])
	})

	it("includes the --- and +++ header lines in the patch", () => {
		const diff = [
			"diff --git a/src/file.ts b/src/file.ts",
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")

		const result = parseDiffOutput(diff)
		const patch = result.files[0]!.patch

		expect(patch).toContain("--- a/src/file.ts")
		expect(patch).toContain("+++ b/src/file.ts")
	})

	it("does not include diff --git or index lines in patches", () => {
		const diff = [
			"diff --git a/src/file.ts b/src/file.ts",
			"index abc123..def456 100644",
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")

		const result = parseDiffOutput(diff)
		const patch = result.files[0]!.patch

		expect(patch).not.toContain("diff --git")
		expect(patch).not.toContain("index abc123")
	})

	it("counts additions and deletions correctly", () => {
		const diff = [
			"diff --git a/src/file.ts b/src/file.ts",
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1,3 +1,3 @@",
			" context1",
			"-removed1",
			"-removed2",
			"+added1",
			" context2",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files[0]!.additions).toBe(1)
		expect(result.files[0]!.deletions).toBe(2)
	})

	it("handles mixed text and binary files", () => {
		const diff = [
			"diff --git a/src/file.ts b/src/file.ts",
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/logo.png b/logo.png",
			"Binary files a/logo.png and b/logo.png differ",
		].join("\n")

		const result = parseDiffOutput(diff)

		expect(result.files).toHaveLength(1)
		expect(result.files[0]!.filename).toBe("src/file.ts")
		expect(result.binaryFiles).toEqual(["logo.png"])
	})
})

describe("createGenerateLocalDiff", () => {
	it("returns well-formed DiffResult from a real git diff", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()
		const head1 = (await gitRevParse("HEAD~1", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGit(PROJECT_ROOT))
		const result = await generateLocalDiff(head1, head)

		expect(result.files.length + result.binaryFiles.length).toBeGreaterThan(0)
		for (const file of result.files) {
			expect(file.filename).toBeTruthy()
			expect(["added", "removed", "modified", "renamed"]).toContain(file.status)
			expect(typeof file.additions).toBe("number")
			expect(typeof file.deletions).toBe("number")
			expect(typeof file.patch).toBe("string")
		}
	})

	it("returns empty result for identical commits", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGit(PROJECT_ROOT))
		const result = await generateLocalDiff(head, head)

		expect(result.files).toEqual([])
		expect(result.binaryFiles).toEqual([])
	})

	it("throws when workspace is not a git repository", async () => {
		const notAGitRepo = import.meta.dir

		const generateLocalDiff = createGenerateLocalDiff(notAGitRepo, createSpawnGit(notAGitRepo))
		await expect(generateLocalDiff("abc123", "def456")).rejects.toThrow("No git repository found")
	})

	it("throws when base commit does not exist", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const head = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGit(PROJECT_ROOT))
		await expect(generateLocalDiff("nonexistent000000", head)).rejects.toThrow("Base commit")
	})

	it("throws when head commit does not exist", async () => {
		expect(existsSync(join(PROJECT_ROOT, ".git"))).toBe(true)

		const base = (await gitRevParse("HEAD", PROJECT_ROOT)).trim()

		const generateLocalDiff = createGenerateLocalDiff(PROJECT_ROOT, createSpawnGit(PROJECT_ROOT))
		await expect(generateLocalDiff(base, "nonexistent000000")).rejects.toThrow("Head commit")
	})
})
