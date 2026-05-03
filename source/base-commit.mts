import type { SpawnGit } from "./diff.mts"

export interface BaseCommitContext {
	fileList: string[]
}

type GetBaseCommitContextDependencies = {
	spawnGit: SpawnGit
}

export async function getBaseCommitContext(dependencies: GetBaseCommitContextDependencies, baseCommit: string): Promise<BaseCommitContext> {
	const lsTreeResult = await dependencies.spawnGit(["ls-tree", "-r", "--name-only", baseCommit])
	if (lsTreeResult.exitCode !== 0) {
		throw new Error(`Failed to list files in base commit: ${lsTreeResult.stderr.trim()}`)
	}

	const fileList = lsTreeResult.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)

	return { fileList }
}
