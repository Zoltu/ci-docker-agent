import { createGetConfiguration } from "./configuration.mts"
import { createGithubFetch, createFetchPullRequestFiles, createSubmitReview, createReactToComment } from "./github.mts"
import { createSpawnGitDiff, createGenerateLocalDiff } from "./diff.mts"
import { createDefaultCallApi } from "./ai.mts"
import { createLoadAgents, createLoadAggregator, createReadAgentsFromDisk } from "./agents.mts"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "./orchestrator.mts"
import { assertNever } from "./typescript-helpers.mts"
import { USER_AGENTS_DIRECTORY, BUILTIN_AGENTS_DIRECTORY } from "./paths.mts"

async function main(): Promise<void> {
	const getConfiguration = createGetConfiguration(Bun.env)
	const configuration = getConfiguration()
	const agentDirectories = { userAgentsDirectory: USER_AGENTS_DIRECTORY, builtinAgentsDirectory: BUILTIN_AGENTS_DIRECTORY }

	const readAgentsFromDisk = createReadAgentsFromDisk()
	const loadAgents = createLoadAgents(agentDirectories, readAgentsFromDisk)
	const loadAggregator = createLoadAggregator(agentDirectories, readAgentsFromDisk)
	const callApi = createDefaultCallApi(Bun.env)
	const githubFetch = createGithubFetch()

	switch (configuration.type) {
		case "comment-trigger": {
			const dependencies = {
				fetchPullRequestFiles: createFetchPullRequestFiles(githubFetch, configuration.github),
				submitReview: createSubmitReview(githubFetch, configuration.github),
				reactToComment: createReactToComment(githubFetch, configuration.github),
				loadAgents,
				loadAggregator,
				callApi,
			}
			return runOnCommentTrigger(dependencies, configuration)
		}
		case "pull-request": {
			const dependencies = {
				fetchPullRequestFiles: createFetchPullRequestFiles(githubFetch, configuration.github),
				submitReview: createSubmitReview(githubFetch, configuration.github),
				loadAgents,
				loadAggregator,
				callApi,
			}
			return runOnPullRequest(dependencies, configuration)
		}
		case "local-diff": {
			const spawnGitDiff = createSpawnGitDiff(configuration.workspaceDirectory)
			const dependencies = {
				generateLocalDiff: createGenerateLocalDiff(configuration.workspaceDirectory, spawnGitDiff),
				loadAgents,
				loadAggregator,
				callApi,
			}
			console.log(await runOnLocalDiff(dependencies, configuration))
			return
		}
		default: assertNever(configuration)
	}
}

main().catch(error => {
	console.error("CI Agent failed:", error)
	process.exit(1)
})
