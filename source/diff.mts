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

const COMMITISH_TYPES = new Set(["commit", "tag"])

function isCommitishType(stdout: string): boolean {
	return COMMITISH_TYPES.has(stdout.trim())
}

async function validateCommitExists(dependencies: { spawnGit: SpawnGit }, commit: string, label: string): Promise<void> {
	const { exitCode, signalCode, stdout, stderr } = await dependencies.spawnGit(["cat-file", "-t", commit])
	if (exitCode === null && signalCode !== null) throw new Error(`Command "git cat-file -t <${label}>" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
	if (exitCode === 0 && isCommitishType(stdout)) return
	if (exitCode === 0) throw new Error(`${label} reference "${commit}" is a ${stdout.trim()}, not a commit\nPlease ensure the reference points to a commit`)
	throw new Error(`${label} commit "${commit}" not found in repository\nPlease ensure the commit hash is valid and exists in the mounted repository\nError: ${stderr.trim()}`)
}

export async function validateGitRepository(dependencies: { spawnGit: SpawnGit }, workspaceDirectory: string): Promise<void> {
	const result = await dependencies.spawnGit(["rev-parse", "--git-dir"])
	if (result.exitCode === 0) return
	throw new Error(`No git repository found at ${workspaceDirectory}\nPlease ensure you are mounting a git repository to ${workspaceDirectory}\nError: ${result.stderr.trim()}`)
}

export async function ensureCommitAvailable(dependencies: { spawnGit: SpawnGit }, commit: string): Promise<void> {
	const check = await dependencies.spawnGit(["cat-file", "-t", commit])
	if (check.exitCode === 0) {
		if (isCommitishType(check.stdout)) return
		throw new Error(`Reference "${commit}" is a ${check.stdout.trim()}, not a commit`)
	}

	const fetch = await dependencies.spawnGit(["fetch", "--depth=1", "origin", commit])
	if (fetch.exitCode === null && fetch.signalCode !== null) throw new Error(`Command "git fetch --depth=1 origin ${commit}" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
	if (fetch.exitCode !== 0) throw new Error(`Failed to fetch commit ${commit}: ${fetch.stderr.trim()}`)
}

export async function validateGitEnvironment(dependencies: { spawnGit: SpawnGit }, baseCommit: string, headCommit: string, workspaceDirectory: string): Promise<void> {
	await validateGitRepository(dependencies, workspaceDirectory)

	await validateCommitExists(dependencies, baseCommit, "Base")
	await validateCommitExists(dependencies, headCommit, "Head")
}

export async function generateLocalDiff(dependencies: { spawnGit: SpawnGit }, baseCommit: string, headCommit: string): Promise<string> {
	const result = await dependencies.spawnGit(["diff", "--unified=3", baseCommit, headCommit])
	if (result.exitCode === null && result.signalCode !== null) throw new Error(`Command "git diff --unified=3" timed out after ${SUBPROCESS_TIMEOUT_MILLISECONDS / 1000}s`)
	if (result.exitCode === 0) return result.stdout
	const errorOutput = result.stderr || result.stdout || "Unknown error"
	throw new Error(`Failed to get diff: ${errorOutput}`)
}
