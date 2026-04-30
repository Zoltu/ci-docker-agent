import { existsSync } from "node:fs"

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
	if (exitCode === 0) return
	throw new Error(
		`${label} commit "${commit}" not found in repository\n` +
		`Please ensure the commit hash is valid and exists in the mounted repository\n` +
		`Error: ${stderr.trim()}`
	)
}

export async function validateGitEnvironment(dependencies: { spawnGit: SpawnGit }, baseCommit: string, headCommit: string, workspaceDirectory: string): Promise<void> {
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

export function createGenerateLocalDiff(spawnGit: SpawnGit): (baseCommit: string, headCommit: string) => Promise<string> {
	return async function generateLocalDiff(baseCommit: string, headCommit: string): Promise<string> {
		const result = await spawnGit(["diff", "--unified=3", baseCommit, headCommit])
		if (result.exitCode === null && result.signalCode !== null) throw new Error(`Command "git diff --unified=3" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
		if (result.exitCode === 0) return result.stdout
		const errorOutput = result.stderr || result.stdout || "Unknown error"
		throw new Error(`Failed to get diff: ${errorOutput}`)
	}
}
