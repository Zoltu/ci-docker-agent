import { createFetch, parseAiConfiguration } from "./ai.mts"
import { createReadAgentsFromDisk } from "./agents.mts"
import { getConfiguration } from "./configuration.mts"
import { createSpawnGit } from "./diff.mts"
import { createDebugWriter } from "./debug.mts"
import { createGithubFetch } from "./github.mts"
import { createLogger } from "./logger.mts"
import { runOnCommentTrigger, runOnLocalDiff, runOnPullRequest } from "./orchestrator.mts"
import { BUILTIN_AGENTS_DIRECTORY, DEBUG_DIRECTORY, getWorkspaceDirectory, getUserAgentsDirectory } from "./paths.mts"
import { assertNever } from "./typescript-helpers.mts"

async function main(): Promise<void> {
	const configuration = getConfiguration(Bun.env)
	const workspaceDirectory = getWorkspaceDirectory(Bun.env)
	const userAgentsDirectory = getUserAgentsDirectory(workspaceDirectory)
	const agentDirectories = { userAgentsDirectory, builtinAgentsDirectory: BUILTIN_AGENTS_DIRECTORY }

	const logger = createLogger()
	const debugWriter = await createDebugWriter(DEBUG_DIRECTORY)
	const readAgents = createReadAgentsFromDisk()
	const spawnGit = createSpawnGit(workspaceDirectory)
	const aiConfiguration = parseAiConfiguration(Bun.env)
	const fetch = createFetch(aiConfiguration)
	const githubFetch = createGithubFetch(logger)

	const dependencies = {
		spawnGit,
		readAgents,
		githubFetch,
		fetch,
		logger,
		debugWriter,
	}

	switch (configuration.type) {
		case "comment-trigger": {
			return runOnCommentTrigger(dependencies, configuration, agentDirectories, aiConfiguration.model)
		}
		case "pull-request": {
			return runOnPullRequest(dependencies, configuration, agentDirectories, aiConfiguration.model)
		}
		case "local-diff": {
			const result = await runOnLocalDiff(dependencies, configuration, agentDirectories, aiConfiguration.model, workspaceDirectory)
			logger.log(result)
			return
		}
		default: assertNever(configuration)
	}
}

process.on("SIGINT", () => process.exit(130))
process.on("SIGTERM", () => process.exit(143))

main().catch(error => {
	console.error("CI Agent failed:", error)
	process.exit(1)
})
