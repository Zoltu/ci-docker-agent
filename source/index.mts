import { createGetConfiguration } from "./configuration.mts"
import { createGithubFetch, createFetchPullRequestDiff, createFetchPullRequestBaseCommit, createSubmitReview, createReactToComment } from "./github.mts"
import { createSpawnGit, createGenerateLocalDiff } from "./diff.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import { createDefaultCallApi } from "./ai.mts"
import { createLoadAgents, createLoadAggregator, createReadAgentsFromDisk } from "./agents.mts"
import { runOnCommentTrigger, runOnPullRequest, runOnLocalDiff } from "./orchestrator.mts"
import { createLogger } from "./logger.mts"
import { assertNever } from "./typescript-helpers.mts"
import { USER_AGENTS_DIRECTORY, BUILTIN_AGENTS_DIRECTORY } from "./paths.mts"

async function main(): Promise<void> {
	const getConfiguration = createGetConfiguration(Bun.env)
	const configuration = getConfiguration()
	const agentDirectories = { userAgentsDirectory: USER_AGENTS_DIRECTORY, builtinAgentsDirectory: BUILTIN_AGENTS_DIRECTORY }

	const log = createLogger()
	const readAgentsFromDisk = createReadAgentsFromDisk()
	const spawnGit = createSpawnGit(configuration.workspaceDirectory)
	const loadAgents = createLoadAgents(agentDirectories, readAgentsFromDisk)
	const loadAggregator = createLoadAggregator(agentDirectories, readAgentsFromDisk)
	const callApi = createDefaultCallApi(Bun.env)
	const githubFetch = createGithubFetch(log)

	const dependencies = {
		spawnGit,
		getBaseCommitContext: (baseCommit: string) => getBaseCommitContext({ spawnGit }, baseCommit),
		loadAgents,
		loadAggregator,
		callApi,
		log,
	}

	switch (configuration.type) {
		case "comment-trigger": {
			return runOnCommentTrigger({
				...dependencies,
				fetchPullRequestDiff: createFetchPullRequestDiff(githubFetch, configuration.github),
				fetchPullRequestBaseCommit: createFetchPullRequestBaseCommit(githubFetch, configuration.github),
				submitReview: createSubmitReview(githubFetch, configuration.github),
				reactToComment: createReactToComment(githubFetch, configuration.github),
			}, configuration)
		}
		case "pull-request": {
			return runOnPullRequest({
				...dependencies,
				fetchPullRequestDiff: createFetchPullRequestDiff(githubFetch, configuration.github),
				fetchPullRequestBaseCommit: createFetchPullRequestBaseCommit(githubFetch, configuration.github),
				submitReview: createSubmitReview(githubFetch, configuration.github),
			}, configuration)
		}
		case "local-diff": {
			const result = await runOnLocalDiff({
				...dependencies,
				generateLocalDiff: createGenerateLocalDiff(spawnGit),
			}, configuration)
			console.log(result)
			return
		}
		default: assertNever(configuration)
	}
}

main().catch(error => {
	console.error("CI Agent failed:", error)
	process.exit(1)
})
