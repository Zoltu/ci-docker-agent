import type { PRFile } from "./github-types.mts"

export interface DiffResult {
	files: PRFile[]
}

export async function generateLocalDiff(baseCommit: string, headCommit: string): Promise<DiffResult> {
	// Get list of changed files
	const fileListProcess = await Bun.spawn(["git", "diff", "--name-status", baseCommit, headCommit])
	if (fileListProcess.exitCode !== 0) {
		const stderr = fileListProcess.stderr as Buffer | null | undefined
		throw new Error(`Failed to get file list: ${stderr?.toString() ?? "Unknown error"}`)
	}

	const fileList = fileListProcess.stdout.toString().trim()
	if (!fileList) {
		return { files: [] }
	}

	const files: PRFile[] = []
	const fileLines = fileList.split("\n")

	for (const line of fileLines) {
		const parts = line.split("\t")
		if (parts.length < 2) {
			continue
		}

		const status = parts[0]
		const filename = parts[1]

		if (status === undefined || filename === undefined) {
			continue
		}

		// Get the patch for this file
		const patchProcess = await Bun.spawn([
			"git",
			"diff",
			"--unified=0",
			baseCommit,
			headCommit,
			"--",
			filename,
		])

		const patch = patchProcess.stdout.toString()

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
