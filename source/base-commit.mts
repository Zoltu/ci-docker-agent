import type { SpawnGit } from "./diff.mts"
import { isBinaryExtension, isContentText } from "./text-detection.mts"

export interface BaseCommitContext {
	fileList: string[]
	fileContents: Map<string, string>
}

type GetBaseCommitContextDependencies = {
	spawnGit: SpawnGit
}

export async function getBaseCommitContext(dependencies: GetBaseCommitContextDependencies, baseCommit: string): Promise<BaseCommitContext> {
	const { spawnGit } = dependencies
	const lsTreeResult = await spawnGit(["ls-tree", "-r", "--name-only", baseCommit])
	if (lsTreeResult.exitCode !== 0) {
		throw new Error(`Failed to list files in base commit: ${lsTreeResult.stderr.trim()}`)
	}

	const allFiles = lsTreeResult.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)

	const fileList = allFiles

	const filesToFetch = fileList.filter(file => !isBinaryExtension(file))

	const rawResults = await Promise.all(
		filesToFetch.map(async file => {
			const showResult = await spawnGit(["show", `${baseCommit}:${file}`])
			if (showResult.exitCode !== 0) throw new Error(`Failed to read file ${file} at commit ${baseCommit}: ${showResult.stderr.trim()}`)
			return [file, showResult.stdout] as const
		})
	)

	const fileContents = new Map<string, string>()
	for (const [file, content] of rawResults) {
		if (!isContentText(content)) continue
		fileContents.set(file, content)
	}

	return { fileList, fileContents }
}
