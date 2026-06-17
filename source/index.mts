import { createReadAgentsFromDisk } from "./agents.mts"
import { createFetch, createHttpFetch, createNow, createRandom, createSleep, parseAiConfiguration } from "./ai.mts"
import { getConfiguration } from "./configuration.mts"
import { createDebugWriter } from "./debug.mts"
import { createSpawnGit } from "./diff.mts"
import { createGithubFetch } from "./github.mts"
import { createLogger } from "./logger.mts"
import { runOnCommentTrigger, runOnLocalDiff, runOnPullRequest } from "./orchestrator.mts"
import { BUILTIN_AGENTS_DIRECTORY, DEBUG_DIRECTORY, getWorkspaceDirectory } from "./paths.mts"
import { selectProviderProfile } from "./provider-profiles.mts"
import { assertNever } from "./typescript-helpers.mts"

async function main(): Promise<void> {
	const configuration = getConfiguration(Bun.env)
	const workspaceDirectory = getWorkspaceDirectory(Bun.env)
	const userAgentsDirectory = `${workspaceDirectory}/.ci-agents`
	const builtinAgentsDirectory = BUILTIN_AGENTS_DIRECTORY

	const logger = createLogger()
	const debugWriter = await createDebugWriter(DEBUG_DIRECTORY)
	const readAgents = createReadAgentsFromDisk()
	const spawnGit = createSpawnGit(workspaceDirectory)
	const aiConfiguration = parseAiConfiguration(Bun.env)
	const fetch = createFetch({ httpFetch: createHttpFetch(aiConfiguration), sleep: createSleep(), random: createRandom(), now: createNow() })
	const githubFetch = createGithubFetch(logger)
	const profile = selectProviderProfile(aiConfiguration.apiUrl, aiConfiguration.model)

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
			return runOnCommentTrigger(dependencies, configuration, userAgentsDirectory, builtinAgentsDirectory, aiConfiguration.model, profile)
		}
		case "pull-request": {
			return runOnPullRequest(dependencies, configuration, userAgentsDirectory, builtinAgentsDirectory, aiConfiguration.model, profile)
		}
		case "local-diff": {
			const result = await runOnLocalDiff(dependencies, configuration, userAgentsDirectory, builtinAgentsDirectory, aiConfiguration.model, workspaceDirectory, profile)
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
