import type { AgentDirectories, AgentNames, AgentReader } from "./agents.mts"
import { loadAgents, loadAggregator } from "./agents.mts"
import { analyze } from "./ai.mts"
import type { Fetch } from "./agent-loop.mts"
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

type RunAnalysisDependencies = {
	spawnGit: SpawnGit
	readAgents: AgentReader
	fetch: Fetch
	logger: Logger
	debugWriter: DebugWriter
}

async function runAnalysis(dependencies: RunAnalysisDependencies, agentNames: AgentNames, agentDirectories: AgentDirectories, diffText: string, baseCommit: string, model: string): Promise<AiReviewResult> {
	const { agents } = await loadAgents(dependencies, agentDirectories, agentNames)
	const aggregator = await loadAggregator(dependencies, agentDirectories)
	await ensureCommitAvailable(dependencies, baseCommit)
	const baseCommitContext = await getBaseCommitContext(dependencies, baseCommit)
	return analyze(dependencies, baseCommitContext, diffText, agents, aggregator, baseCommit, model)
}

type PrReviewDependencies = {
	spawnGit: SpawnGit
	readAgents: AgentReader
	githubFetch: GitHubFetch
	fetch: Fetch
	logger: Logger
	debugWriter: DebugWriter
}

async function submitPrReview(dependencies: PrReviewDependencies, agentNames: AgentNames, agentDirectories: AgentDirectories, githubConfiguration: GitHubConfiguration, model: string): Promise<void> {
	const [diffText, baseCommit] = await Promise.all([
		fetchPullRequestDiff(dependencies, githubConfiguration),
		fetchPullRequestBaseCommit(dependencies, githubConfiguration),
	])

	if (diffText.trim() === "") {
		dependencies.logger.log("No files changed, nothing to review")
		return
	}

	const aiResult = await runAnalysis(dependencies, agentNames, agentDirectories, diffText, baseCommit, model)
	const reviewPayload = buildReviewPayload(aiResult)
	await submitReview(dependencies, githubConfiguration, reviewPayload)
	dependencies.logger.log("PR review submitted successfully")
}

export async function runOnCommentTrigger(dependencies: PrReviewDependencies, configuration: CommentTriggerConfiguration, agentDirectories: AgentDirectories, model: string): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") {
		dependencies.logger.log("No /review trigger found in comment")
		return
	}

	await submitPrReview(dependencies, triggerResult, agentDirectories, configuration.github, model)
}

export async function runOnPullRequest(dependencies: PrReviewDependencies, configuration: PullRequestConfiguration, agentDirectories: AgentDirectories, model: string): Promise<void> {
	await submitPrReview(dependencies, configuration.agents, agentDirectories, configuration.github, model)
}

type RunOnLocalDiffDependencies = {
	spawnGit: SpawnGit
	readAgents: AgentReader
	fetch: Fetch
	logger: Logger
	debugWriter: DebugWriter
}

export async function runOnLocalDiff(dependencies: RunOnLocalDiffDependencies, configuration: LocalDiffConfiguration, agentDirectories: AgentDirectories, model: string, workspaceDirectory: string): Promise<string> {
	await validateGitEnvironment(dependencies, configuration.baseCommit, configuration.headCommit, workspaceDirectory)

	const diffText = await generateLocalDiff(dependencies, configuration.baseCommit, configuration.headCommit)

	if (diffText.trim() === "") return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, agentDirectories, diffText, configuration.baseCommit, model)
	return formatReviewForConsole(aiResult)
}
