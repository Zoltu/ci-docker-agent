import { existsSync } from "node:fs"

export type DiffFileStatus = "added" | "modified" | "removed" | "renamed"

export interface DiffFile {
	filename: string
	status: DiffFileStatus
	additions: number
	deletions: number
	patch: string
}

export interface DiffResult {
	files: DiffFile[]
	binaryFiles: string[]
}

export function parseDiffOutput(output: string): DiffResult {
	const files: DiffFile[] = []
	const binaryFiles: string[] = []
	const lines = output.split("\n")

	let fromFilename: string | null = null
	let toFilename: string | null = null
	let additions = 0
	let deletions = 0
	const patchLines: string[] = []

	function saveCurrentFile(): void {
		if (toFilename !== null || fromFilename !== null) {
			const filename = toFilename ?? fromFilename!
			let status: DiffFileStatus
			if (fromFilename === null) {
				status = "added"
			} else if (toFilename === null) {
				status = "removed"
			} else if (fromFilename !== toFilename) {
				status = "renamed"
			} else {
				status = "modified"
			}

			files.push({
				filename,
				status,
				additions,
				deletions,
				patch: patchLines.join("\n"),
			})
		}
	}

	function resetState(): void {
		fromFilename = null
		toFilename = null
		additions = 0
		deletions = 0
		patchLines.length = 0
	}

	for (const line of lines) {
		const diffSeparator = /^diff --git /.test(line)
		if (diffSeparator) {
			saveCurrentFile()
			resetState()
			continue
		}

		const fromMatch = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line)
		if (fromMatch) {
			saveCurrentFile()
			resetState()
			fromFilename = fromMatch[1] ?? null
			patchLines.push(line)
			continue
		}

		const toMatch = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line)
		if (toMatch) {
			toFilename = toMatch[1] ?? null
			patchLines.push(line)
			continue
		}

		const binaryMatch = /^Binary files (.+) and (.+) differ$/.exec(line)
		if (binaryMatch) {
			saveCurrentFile()
			resetState()
			const toPart = binaryMatch[2]!
			const fromPart = binaryMatch[1]!
			if (toPart.startsWith("b/")) {
				binaryFiles.push(toPart.slice(2))
			} else if (fromPart.startsWith("a/")) {
				binaryFiles.push(fromPart.slice(2))
			}
			continue
		}

		if (fromFilename !== null || toFilename !== null) {
			patchLines.push(line)
			if (line.startsWith("+") && !line.startsWith("++")) {
				additions++
			} else if (line.startsWith("-") && !line.startsWith("--")) {
				deletions++
			}
		}
	}

	saveCurrentFile()

	return { files, binaryFiles }
}

const SUBPROCESS_TIMEOUT_MILLISECONDS = 30_000

export interface GitDiffResult {
	stdout: string
	stderr: string
	exitCode: number | null
	signalCode: string | null
}

export type SpawnGit = (parameters: string[]) => Promise<GitDiffResult>

export function createSpawnGit(workspaceDirectory: string): SpawnGit {
	return async function spawnGit(parameters: string[]): Promise<GitDiffResult> {
		const process = Bun.spawn(["git", ...parameters], { cwd: workspaceDirectory, stderr: "pipe", stdout: "pipe", timeout: SUBPROCESS_TIMEOUT_MILLISECONDS })
		await process.exited
		const stdout = await Bun.readableStreamToText(process.stdout)
		const stderr = await Bun.readableStreamToText(process.stderr)
		return { stdout, stderr, exitCode: process.exitCode, signalCode: process.signalCode }
	}
}

async function validateCommitExists(dependencies: { spawnGit: SpawnGit }, commit: string, label: string): Promise<void> {
	const { exitCode, signalCode, stderr } = await dependencies.spawnGit(["cat-file", "-t", commit])
	if (exitCode === null && signalCode !== null) throw new Error(`Command "git cat-file -t <${label}>" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
	if (exitCode !== 0) {
		throw new Error(
			`${label} commit "${commit}" not found in repository\n` +
			`Please ensure the commit hash is valid and exists in the mounted repository\n` +
			`Error: ${stderr.trim()}`
		)
	}
}

async function validateGitEnvironment(dependencies: { spawnGit: SpawnGit }, baseCommit: string, headCommit: string, workspaceDirectory: string): Promise<void> {
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

export function createGenerateLocalDiff(workspaceDirectory: string, spawnGit: SpawnGit): (baseCommit: string, headCommit: string) => Promise<DiffResult> {
	return async function generateLocalDiff(baseCommit: string, headCommit: string): Promise<DiffResult> {
		await validateGitEnvironment({ spawnGit }, baseCommit, headCommit, workspaceDirectory)

		const result = await spawnGit(["diff", "--unified=3", baseCommit, headCommit])
		if (result.exitCode === null && result.signalCode !== null) throw new Error(`Command "git diff --unified=3" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
		if (result.exitCode !== 0) {
			const errorOutput = result.stderr || result.stdout || "Unknown error"
			throw new Error(`Failed to get diff: ${errorOutput}`)
		}

		return parseDiffOutput(result.stdout)
	}
}
