import type { PullRequestFile } from "./github-types.mts"
import { existsSync } from "node:fs"

const SUBPROCESS_TIMEOUT_MILLISECONDS = 30_000

export function parseUnifiedDiff(output: string): Map<string, string> {
	// Binary files produce "Binary files a/X and b/Y differ" instead of ---/+++ headers and are silently skipped
	const files = new Map<string, string>()
	const lines = output.split("\n")
	let filename: string | null = null
	const patch: string[] = []

	function saveCurrentFile(): void {
		if (filename !== null) {
			files.set(filename, patch.join("\n"))
		}
	}

	for (const line of lines) {
		const fromMatch = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line)
		if (fromMatch) {
			saveCurrentFile()
			// For deleted files (where +++ is /dev/null), this is the only filename we get. For added/modified files, the +++ line below will overwrite this with the canonical "to" path.
			filename = fromMatch[1] ?? null
			patch.length = 0
			patch.push(line)
			continue
		}

		const toMatch = /^\+\+\+ b\/(.+)$/.exec(line)
		if (toMatch) {
			// Always use the "to" path as the canonical key. This handles renames where --- and +++ reference different filenames.
			// Non-null: the (.+) capture group requires 1+ characters, so [1] is always populated on match
			filename = toMatch[1]!
			patch.push(line)
			continue
		}

		if (filename !== null) {
			patch.push(line)
		}
	}

	saveCurrentFile()

	return files
}

export function mapGitStatus(status: string): "added" | "copied" | "removed" | "modified" | "renamed" {
	switch (status[0] ?? "") {
		case "A": return "added"
		case "C": return "copied"
		case "D": return "removed"
		case "M": return "modified"
		case "R": return "renamed"
		case "T": return "modified" // git marks file type changes (e.g. symlink ↔ regular file) with "T"
		default: throw new Error(`Unknown git status code: "${status}"`)
	}
}

export function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
	const result = new Map<string, { additions: number; deletions: number }>()
	for (const line of output.split("\n")) {
		const parts = line.split("\t")
		if (parts.length < 3) continue
		const additions = Number.parseInt(parts[0]!, 10)
		const deletions = Number.parseInt(parts[1]!, 10)
		const filename = parts[2]!
		if (!Number.isNaN(additions) && !Number.isNaN(deletions)) {
			result.set(filename, { additions, deletions })
		}
	}
	return result
}

export interface GitDiffResult {
	stdout: string
	stderr: string
	exitCode: number | null
	signalCode: string | null
}

export type SpawnGitDiff = (parameters: string[]) => Promise<GitDiffResult>

export function createSpawnGitDiff(workspaceDirectory: string): SpawnGitDiff {
	return async function spawnGitDiff(parameters: string[]): Promise<GitDiffResult> {
		const process = Bun.spawn(["git", ...parameters], { cwd: workspaceDirectory, stderr: "pipe", stdout: "pipe", timeout: SUBPROCESS_TIMEOUT_MILLISECONDS })
		await process.exited
		const stdout = await Bun.readableStreamToText(process.stdout)
		const stderr = await Bun.readableStreamToText(process.stderr)
		return { stdout, stderr, exitCode: process.exitCode, signalCode: process.signalCode }
	}
}

async function validateCommitExists(dependencies: { spawnGitDiff: SpawnGitDiff }, commit: string, label: string): Promise<void> {
	const { exitCode, signalCode, stderr } = await dependencies.spawnGitDiff(["cat-file", "-t", commit])
	if (exitCode === null && signalCode !== null) throw new Error(`Command "git cat-file -t <${label}>" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
	if (exitCode !== 0) {
		throw new Error(
			`${label} commit "${commit}" not found in repository\n` +
			`Please ensure the commit hash is valid and exists in the mounted repository\n` +
			`Error: ${stderr.trim()}`
		)
	}
}

async function validateGitEnvironment(dependencies: { spawnGitDiff: SpawnGitDiff }, baseCommit: string, headCommit: string, workspaceDirectory: string): Promise<void> {
	if (!existsSync(`${workspaceDirectory}/.git`)) {
		throw new Error(
			`No git repository found at ${workspaceDirectory}\n` +
			`Please ensure you are mounting a git repository to /github/workspace\n` +
			`Example: docker run -v "$(pwd)":/github/workspace ci-agent:latest`
		)
	}

	await validateCommitExists(dependencies, baseCommit, "Base")
	await validateCommitExists(dependencies, headCommit, "Head")
}

export function buildLocalDiff(nameStatusOutput: string, unifiedOutput: string, numstatByFile: Map<string, { additions: number; deletions: number }>): PullRequestFile[] {
	const patchByFile = parseUnifiedDiff(unifiedOutput)

	const files: PullRequestFile[] = []
	const fileLines = nameStatusOutput.split("\n")

	for (const line of fileLines) {
		const parts = line.split("\t")
		if (parts.length < 2) {
			continue
		}

		const status = parts[0]!
		const filename = parts.length >= 3 ? parts[2]! : parts[1]!
		const patch = patchByFile.get(filename)

		const stats = numstatByFile.get(filename)
		const additions = stats?.additions ?? 0
		const deletions = stats?.deletions ?? 0
		const changes = additions + deletions

		files.push({ filename, status: mapGitStatus(status), additions, deletions, changes, patch })
	}

	return files
}

export function createGenerateLocalDiff(workspaceDirectory: string, spawnGitDiff: SpawnGitDiff): (baseCommit: string, headCommit: string) => Promise<PullRequestFile[]> {
	return async function generateLocalDiff(baseCommit: string, headCommit: string): Promise<PullRequestFile[]> {
		await validateGitEnvironment({ spawnGitDiff }, baseCommit, headCommit, workspaceDirectory)

		const nameStatusResult = await spawnGitDiff(["diff", "--name-status", baseCommit, headCommit])
		if (nameStatusResult.exitCode === null && nameStatusResult.signalCode !== null) throw new Error(`Command "git diff --name-status" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
		if (nameStatusResult.exitCode !== 0) {
			const errorOutput = nameStatusResult.stderr || nameStatusResult.stdout || "Unknown error"
			throw new Error(`Failed to get file list: ${errorOutput}`)
		}

		const nameStatusOutput = nameStatusResult.stdout
		if (!nameStatusOutput.trim()) return []

		const numstatResult = await spawnGitDiff(["diff", "--numstat", baseCommit, headCommit])
		if (numstatResult.exitCode === null && numstatResult.signalCode !== null) throw new Error(`Command "git diff --numstat" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
		if (numstatResult.exitCode !== 0) {
			throw new Error(`Failed to get numstat diff: ${numstatResult.stderr.trim()}`)
		}

		const unifiedResult = await spawnGitDiff(["diff", "--unified=0", baseCommit, headCommit])
		if (unifiedResult.exitCode === null && unifiedResult.signalCode !== null) throw new Error(`Command "git diff --unified=0" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
		if (unifiedResult.exitCode !== 0) {
			throw new Error(`Failed to get unified diff: ${unifiedResult.stderr.trim()}`)
		}

		const unifiedOutput = unifiedResult.stdout
		return buildLocalDiff(nameStatusOutput, unifiedOutput, parseNumstat(numstatResult.stdout))
	}
}
