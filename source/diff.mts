import type { PrFile } from "./github-types.mts"
import { existsSync } from "node:fs"

export interface DiffResult {
	files: PrFile[]
}

const WORKSPACE_DIR = "/github/workspace"

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

async function validateGitEnvironment(baseCommit: string, headCommit: string): Promise<void> {
	// Check if .git directory exists
	if (!existsSync(`${WORKSPACE_DIR}/.git`)) {
		throw new Error(
			`No git repository found at ${WORKSPACE_DIR}\n` +
			`Please ensure you are mounting a git repository to /github/workspace\n` +
			`Example: docker run -v "$(pwd)":/github/workspace ci-agent:latest`
		)
	}

	// Verify base commit exists
	const baseCheck = Bun.spawn(["git", "cat-file", "-t", baseCommit], { stderr: "pipe" })
	await baseCheck.exited
	if (baseCheck.exitCode !== 0) {
		const stderrText = await streamToString(baseCheck.stderr)
		throw new Error(
			`Base commit "${baseCommit}" not found in repository\n` +
			`Please ensure the commit hash is valid and exists in the mounted repository\n` +
			`Error: ${stderrText.trim()}`
		)
	}

	// Verify head commit exists
	const headCheck = Bun.spawn(["git", "cat-file", "-t", headCommit], { stderr: "pipe" })
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

export async function generateLocalDiff(baseCommit: string, headCommit: string): Promise<DiffResult> {
	// Validate git environment before proceeding
	await validateGitEnvironment(baseCommit, headCommit)

	// Get list of changed files
	const fileListProcess = Bun.spawn(["git", "diff", "--name-status", baseCommit, headCommit], {
		stderr: "pipe",
	})
	await fileListProcess.exited
	if (fileListProcess.exitCode !== 0) {
		const stderrText = await streamToString(fileListProcess.stderr)
		const stdoutText = await streamToString(fileListProcess.stdout)
		const errorOutput = stderrText || stdoutText || "Unknown error"
		throw new Error(`Failed to get file list: ${errorOutput}`)
	}

	const fileList = await streamToString(fileListProcess.stdout)
	if (!fileList.trim()) {
		return { files: [] }
	}

	const files: PrFile[] = []
	const fileLines = fileList.split("\n")

	for (const line of fileLines) {
		const parts = line.split("\t")
		if (parts.length < 2) {
			continue
		}

		const status = parts[0]!
		const filename = parts[1]!

		// Get the patch for this file
		const patchProcess = Bun.spawn([
			"git",
			"diff",
			"--unified=0",
			baseCommit,
			headCommit,
			"--",
			filename,
		])
		await patchProcess.exited

		const patch = await streamToString(patchProcess.stdout)

		// Count additions and deletions from the patch
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
			blob_url: "",
			raw_url: "",
			contents_url: "",
			patch,
		})
	}

	return { files }
}

function mapGitStatus(status: string): string {
	switch (status) {
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
