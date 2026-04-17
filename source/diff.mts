import type { PrFile } from "./github-types.mts"
import { existsSync } from "node:fs"

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	const chunks: string[] = []
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(decoder.decode(value))
	}
	return chunks.join("")
}

async function validateGitEnvironment(baseCommit: string, headCommit: string, workspaceDir: string): Promise<void> {
	if (!existsSync(`${workspaceDir}/.git`)) {
		throw new Error(
			`No git repository found at ${workspaceDir}\n` +
			`Please ensure you are mounting a git repository to /github/workspace\n` +
			`Example: docker run -v "$(pwd)":/github/workspace ci-agent:latest`
		)
	}

	const baseCheck = Bun.spawn(["git", "cat-file", "-t", baseCommit], { cwd: workspaceDir, stderr: "pipe" })
	await baseCheck.exited
	if (baseCheck.exitCode !== 0) {
		const stderrText = await streamToString(baseCheck.stderr)
		throw new Error(
			`Base commit "${baseCommit}" not found in repository\n` +
			`Please ensure the commit hash is valid and exists in the mounted repository\n` +
			`Error: ${stderrText.trim()}`
		)
	}

	const headCheck = Bun.spawn(["git", "cat-file", "-t", headCommit], { cwd: workspaceDir, stderr: "pipe" })
	await headCheck.exited
	if (headCheck.exitCode !== 0) {
		const stderrText = await streamToString(headCheck.stderr)
		throw new Error(
			`Head commit "${headCommit}" not found in repository\n` +
			`Please ensure the commit hash is valid and exists in the mounted repository\n` +
			`Error: ${stderrText.trim()}`
		)
	}
}

export async function generateLocalDiff(baseCommit: string, headCommit: string, workspaceDir = "/github/workspace"): Promise<PrFile[]> {
	await validateGitEnvironment(baseCommit, headCommit, workspaceDir)

	const nameStatusProcess = Bun.spawn(["git", "diff", "--name-status", baseCommit, headCommit], { cwd: workspaceDir, stderr: "pipe" })
	await nameStatusProcess.exited
	if (nameStatusProcess.exitCode !== 0) {
		const stderrText = await streamToString(nameStatusProcess.stderr)
		const stdoutText = await streamToString(nameStatusProcess.stdout)
		const errorOutput = stderrText || stdoutText || "Unknown error"
		throw new Error(`Failed to get file list: ${errorOutput}`)
	}

	const nameStatusOutput = await streamToString(nameStatusProcess.stdout)
	if (!nameStatusOutput.trim()) {
		return []
	}

	const unifiedProcess = Bun.spawn(["git", "diff", "--unified=0", baseCommit, headCommit], {
		cwd: workspaceDir,
		stderr: "pipe",
	})
	await unifiedProcess.exited
	if (unifiedProcess.exitCode !== 0) {
		const stderrText = await streamToString(unifiedProcess.stderr)
		throw new Error(`Failed to get unified diff: ${stderrText.trim()}`)
	}

	const unifiedOutput = await streamToString(unifiedProcess.stdout)
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
	const files = new Map<string, string>()
	const lines = output.split("\n")
	let currentFile: string | null = null
	const currentPatch: string[] = []

	function saveCurrentFile(): void {
		if (currentFile !== null) {
			files.set(currentFile, currentPatch.join("\n"))
		}
	}

	for (const line of lines) {
		const fromMatch = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line)
		if (fromMatch) {
			saveCurrentFile()
			currentFile = fromMatch[1] ?? null
			currentPatch.length = 0
			currentPatch.push(line)
			continue
		}

		const toMatch = /^\+\+\+ b\/(.+)$/.exec(line)
		if (toMatch) {
			currentFile = toMatch[1]!
			currentPatch.push(line)
			continue
		}

		if (currentFile !== null) {
			currentPatch.push(line)
		}
	}

	saveCurrentFile()

	return files
}

export function mapGitStatus(status: string): string {
	switch (status[0] ?? "") {
		case "A":
			return "added"
		case "D":
			return "deleted"
		case "M":
			return "modified"
		case "R":
			return "renamed"
		case "C":
			return "copied"
		default:
			return "modified"
	}
}
