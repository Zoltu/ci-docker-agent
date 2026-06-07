import type { AgentNames, AgentReader } from "./agents.mts"
import { loadAgents, loadAggregator } from "./agents.mts"
import { analyze } from "./ai.mts"
import type { Fetch } from "./agent-loop.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import type { CommentTriggerConfiguration, LocalDiffConfiguration, PullRequestConfiguration } from "./configuration.mts"
import { ensureCommitAvailable, generateLocalDiff, validateGitEnvironment } from "./diff.mts"
import type { SpawnGit } from "./diff.mts"
import type { DebugWriter } from "./debug.mts"
import { fetchPullRequestDiff, fetchPullRequestBaseCommit, submitReview } from "./github.mts"
import type { GitHubFetch } from "./github.mts"
import type { GitHubConfiguration } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"

type OrchestratorDependencies = {
	spawnGit: SpawnGit
	readAgents: AgentReader
	githubFetch: GitHubFetch
	fetch: Fetch
	logger: Logger
	debugWriter: DebugWriter
}

async function runAnalysis(dependencies: OrchestratorDependencies, agentNames: AgentNames, userAgentsDirectory: string, builtinAgentsDirectory: string, diffText: string, baseCommit: string, model: string, profile: ProviderProfile): Promise<AiReviewResult> {
	const agents = await loadAgents(dependencies, userAgentsDirectory, builtinAgentsDirectory, agentNames)
	const aggregator = await loadAggregator(dependencies, userAgentsDirectory, builtinAgentsDirectory)
	await ensureCommitAvailable(dependencies, baseCommit)
	const baseCommitContext = await getBaseCommitContext(dependencies, baseCommit)
	return analyze(dependencies, baseCommitContext, diffText, agents, aggregator, baseCommit, model, profile)
}

async function submitPrReview(dependencies: OrchestratorDependencies, agentNames: AgentNames, userAgentsDirectory: string, builtinAgentsDirectory: string, githubConfiguration: GitHubConfiguration, model: string, profile: ProviderProfile): Promise<void> {
	const [diffText, baseCommit] = await Promise.all([
		fetchPullRequestDiff(dependencies, githubConfiguration),
		fetchPullRequestBaseCommit(dependencies, githubConfiguration),
	])

	if (diffText.trim() === "") {
		dependencies.logger.log("No files changed, nothing to review")
		return
	}

	const aiResult = await runAnalysis(dependencies, agentNames, userAgentsDirectory, builtinAgentsDirectory, diffText, baseCommit, model, profile)
	const reviewPayload = buildReviewPayload(aiResult)
	await submitReview(dependencies, githubConfiguration, reviewPayload)
	dependencies.logger.log("PR review submitted successfully")
}

export async function runOnCommentTrigger(dependencies: OrchestratorDependencies, configuration: CommentTriggerConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, profile: ProviderProfile): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") {
		dependencies.logger.log("No /review trigger found in comment")
		return
	}

	await submitPrReview(dependencies, triggerResult, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, profile)
}

export async function runOnPullRequest(dependencies: OrchestratorDependencies, configuration: PullRequestConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, profile: ProviderProfile): Promise<void> {
	await submitPrReview(dependencies, configuration.agents, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, profile)
}

export async function runOnLocalDiff(dependencies: OrchestratorDependencies, configuration: LocalDiffConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, workspaceDirectory: string, profile: ProviderProfile): Promise<string> {
	await validateGitEnvironment(dependencies, configuration.baseCommit, configuration.headCommit, workspaceDirectory)

	const diffText = await generateLocalDiff(dependencies, configuration.baseCommit, configuration.headCommit)

	if (diffText.trim() === "") return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, userAgentsDirectory, builtinAgentsDirectory, diffText, configuration.baseCommit, model, profile)
	return formatReviewForConsole(aiResult)
}
