import type { PrFile } from "./github-types.mts"
import { existsSync } from "node:fs"

const SUBPROCESS_TIMEOUT_MS = 30_000

async function validateCommitExists(commit: string, label: string, workspaceDir: string): Promise<void> {
	const proc = Bun.spawn(["git", "cat-file", "-t", commit], { cwd: workspaceDir, stdout: "ignore", stderr: "pipe", timeout: SUBPROCESS_TIMEOUT_MS })
	await proc.exited
	if (proc.exitCode === null && proc.signalCode !== null) throw new Error(`Command "git cat-file -t <${label}>" timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`)
	if (proc.exitCode !== 0) {
		const stderrText = await Bun.readableStreamToText(proc.stderr)
		throw new Error(
			`${label} commit "${commit}" not found in repository\n` +
			`Please ensure the commit hash is valid and exists in the mounted repository\n` +
			`Error: ${stderrText.trim()}`
		)
	}
}

async function validateGitEnvironment(baseCommit: string, headCommit: string, workspaceDir: string): Promise<void> {
	if (!existsSync(`${workspaceDir}/.git`)) {
		throw new Error(
			`No git repository found at ${workspaceDir}\n` +
			`Please ensure you are mounting a git repository to /github/workspace\n` +
			`Example: docker run -v "$(pwd)":/github/workspace ci-agent:latest`
		)
	}

	await validateCommitExists(baseCommit, "Base", workspaceDir)
	await validateCommitExists(headCommit, "Head", workspaceDir)
}

export async function generateLocalDiff(baseCommit: string, headCommit: string, workspaceDir = "/github/workspace"): Promise<PrFile[]> {
	await validateGitEnvironment(baseCommit, headCommit, workspaceDir)

	const nameStatusProcess = Bun.spawn(["git", "diff", "--name-status", baseCommit, headCommit], { cwd: workspaceDir, stderr: "pipe", timeout: SUBPROCESS_TIMEOUT_MS })
	await nameStatusProcess.exited
	if (nameStatusProcess.exitCode === null && nameStatusProcess.signalCode !== null) throw new Error(`Command "git diff --name-status" timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`)
	if (nameStatusProcess.exitCode !== 0) {
		const stderrText = await Bun.readableStreamToText(nameStatusProcess.stderr)
		const stdoutText = await Bun.readableStreamToText(nameStatusProcess.stdout)
		const errorOutput = stderrText || stdoutText || "Unknown error"
		throw new Error(`Failed to get file list: ${errorOutput}`)
	}

	const nameStatusOutput = await Bun.readableStreamToText(nameStatusProcess.stdout)
	if (!nameStatusOutput.trim()) return []

	const unifiedProcess = Bun.spawn(["git", "diff", "--unified=0", baseCommit, headCommit], {
		cwd: workspaceDir,
		stderr: "pipe",
		timeout: SUBPROCESS_TIMEOUT_MS,
	})
	await unifiedProcess.exited
	if (unifiedProcess.exitCode === null && unifiedProcess.signalCode !== null) throw new Error(`Command "git diff --unified=0" timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`)
	if (unifiedProcess.exitCode !== 0) {
		const stderrText = await Bun.readableStreamToText(unifiedProcess.stderr)
		throw new Error(`Failed to get unified diff: ${stderrText.trim()}`)
	}

	const unifiedOutput = await Bun.readableStreamToText(unifiedProcess.stdout)
	const patchByFile = parseUnifiedDiff(unifiedOutput)

	const files: PrFile[] = []
	const fileLines = nameStatusOutput.split("\n")

	for (const line of fileLines) {
		const parts = line.split("\t")
		if (parts.length < 2) {
			continue
		}

		const status = parts[0]!
		const filename = parts.length >= 3 ? parts[2]! : parts[1]!
		const patch = patchByFile.get(filename) ?? ""

		let additions = 0
		let deletions = 0
		for (const patchLine of patch.split("\n")) {
			if (patchLine.startsWith("+") && !patchLine.startsWith("+++")) {
				additions++
			} else if (patchLine.startsWith("-") && !patchLine.startsWith("---")) {
				deletions++
			}
		}

		files.push({
			filename,
			status: mapGitStatus(status),
			additions,
			deletions,
			changes: additions + deletions,
			patch: patch || undefined,
		})
	}

	return files
}

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
		case "A":
			return "added"
		case "C":
			return "copied"
		case "D":
			return "removed"
		case "M":
			return "modified"
		case "R":
			return "renamed"
		case "T":
			return "modified"
		default:
			throw new Error(`Unknown git status code: "${status}"`)
	}
}
