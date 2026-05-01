import { createLoadAgents, createLoadAggregator, createReadAgentsFromDisk } from "./agents.mts"
import { createDefaultCallApi } from "./ai.mts"
import { createGetConfiguration } from "./configuration.mts"
import { createGenerateLocalDiff, createSpawnGit, createValidateGitRepository } from "./diff.mts"
import { createFetchPullRequestBaseCommit, createFetchPullRequestDiff, createGithubFetch, createSubmitReview } from "./github.mts"
import { createLogger } from "./logger.mts"
import { runOnCommentTrigger, runOnLocalDiff, runOnPullRequest } from "./orchestrator.mts"
import { BUILTIN_AGENTS_DIRECTORY, USER_AGENTS_DIRECTORY } from "./paths.mts"
import { assertNever } from "./typescript-helpers.mts"

async function main(): Promise<void> {
	const getConfiguration = createGetConfiguration(Bun.env)
	const configuration = getConfiguration()
	const agentDirectories = { userAgentsDirectory: USER_AGENTS_DIRECTORY, builtinAgentsDirectory: BUILTIN_AGENTS_DIRECTORY }

	const log = createLogger()
	const readAgentsFromDisk = createReadAgentsFromDisk()
	const spawnGit = createSpawnGit()
	const validateGitRepository = createValidateGitRepository(spawnGit)
	const callApi = createDefaultCallApi(Bun.env)
	const loadAgents = createLoadAgents(agentDirectories, readAgentsFromDisk)
	const loadAggregator = createLoadAggregator(agentDirectories, readAgentsFromDisk)
	const githubFetch = createGithubFetch(log)

	const dependencies = {
		spawnGit,
		validateGitRepository,
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
			log(result)
			return
		}
		default: assertNever(configuration)
	}
}

main().catch(error => {
	console.error("CI Agent failed:", error)
	process.exit(1)
})
