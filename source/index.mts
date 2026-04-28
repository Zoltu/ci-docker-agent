import { createGetConfiguration } from "./configuration.mts"
import { createGithubFetch, createFetchPullRequestFiles, createFetchPullRequestBaseCommit, createSubmitReview, createReactToComment } from "./github.mts"
import { createSpawnGit, createGenerateLocalDiff } from "./diff.mts"
import { createGetBaseCommitContext } from "./base-commit.mts"
import { createDefaultCallApi } from "./ai.mts"
import { createLoadAgents, createLoadAggregator, createReadAgentsFromDisk } from "./agents.mts"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "./orchestrator.mts"
import { assertNever } from "./typescript-helpers.mts"
import { USER_AGENTS_DIRECTORY, BUILTIN_AGENTS_DIRECTORY, WORKSPACE_DIRECTORY } from "./paths.mts"

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
			const spawnGit = createSpawnGit(WORKSPACE_DIRECTORY)
			const dependencies = {
				fetchPullRequestFiles: createFetchPullRequestFiles(githubFetch, configuration.github),
				fetchPullRequestBaseCommit: createFetchPullRequestBaseCommit(githubFetch, configuration.github),
				getBaseCommitContext: createGetBaseCommitContext(spawnGit),
				submitReview: createSubmitReview(githubFetch, configuration.github),
				reactToComment: createReactToComment(githubFetch, configuration.github),
				loadAgents,
				loadAggregator,
				callApi,
			}
			return runOnCommentTrigger(dependencies, configuration)
		}
		case "pull-request": {
			const spawnGit = createSpawnGit(WORKSPACE_DIRECTORY)
			const dependencies = {
				fetchPullRequestFiles: createFetchPullRequestFiles(githubFetch, configuration.github),
				fetchPullRequestBaseCommit: createFetchPullRequestBaseCommit(githubFetch, configuration.github),
				getBaseCommitContext: createGetBaseCommitContext(spawnGit),
				submitReview: createSubmitReview(githubFetch, configuration.github),
				loadAgents,
				loadAggregator,
				callApi,
			}
			return runOnPullRequest(dependencies, configuration)
		}
		case "local-diff": {
			const spawnGit = createSpawnGit(configuration.workspaceDirectory)
			const dependencies = {
				generateLocalDiff: createGenerateLocalDiff(configuration.workspaceDirectory, spawnGit),
				getBaseCommitContext: createGetBaseCommitContext(spawnGit),
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
