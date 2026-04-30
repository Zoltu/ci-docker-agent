import type { SpawnGit } from "./diff.mts"
import { parseIgnorePatterns, isPathIgnored } from "./ignore-patterns.mts"
import { classifyFileByExtension, isContentText } from "./text-detection.mts"

export { TEXT_FILE_EXTENSIONS, BINARY_FILE_EXTENSIONS, AMBIGUOUS_FILE_EXTENSIONS } from "./text-detection.mts"

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

	const ignorePatterns: string[] = [".git/"]

	const gitignoreResult = await spawnGit(["ls-tree", baseCommit, "--", ".gitignore"])
	if (gitignoreResult.stdout.trim().length > 0) {
		const showResult = await spawnGit(["show", `${baseCommit}:.gitignore`])
		if (showResult.exitCode === 0) {
			ignorePatterns.push(...parseIgnorePatterns(showResult.stdout))
		}
	}

	const dockerignoreResult = await spawnGit(["ls-tree", baseCommit, "--", ".dockerignore"])
	if (dockerignoreResult.stdout.trim().length > 0) {
		const showResult = await spawnGit(["show", `${baseCommit}:.dockerignore`])
		if (showResult.exitCode === 0) {
			ignorePatterns.push(...parseIgnorePatterns(showResult.stdout))
		}
	}

	const fileList = allFiles.filter(file => !isPathIgnored(file, ignorePatterns))

	const classifications = new Map<string, "text" | "binary" | "ambiguous">()
	for (const file of fileList) {
		classifications.set(file, classifyFileByExtension(file))
	}

	const filesToFetch = fileList.filter(file => classifications.get(file) !== "binary")

	const rawResults = await Promise.all(
		filesToFetch.map(async file => {
			const showResult = await spawnGit(["show", `${baseCommit}:${file}`])
			if (showResult.exitCode !== 0) {
				throw new Error(`Failed to read file ${file} at commit ${baseCommit}: ${showResult.stderr.trim()}`)
			}
			return [file, showResult.stdout] as const
		})
	)

	const fileContents = new Map<string, string>()
	for (const [file, content] of rawResults) {
		const classification = classifications.get(file)
		if (classification === "text" || isContentText(content)) {
			fileContents.set(file, content)
		}
	}

	return { fileList, fileContents }
}
