import type { Agent, AgentNames, ResolveResult } from "./agents.mts"
import type { CallApi } from "./ai.mts"
import { analyze } from "./ai.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import type { CommentTriggerConfiguration, LocalDiffConfiguration, PullRequestConfiguration } from "./configuration.mts"
import type { SpawnGit } from "./diff.mts"
import { validateGitEnvironment } from "./diff.mts"
import type { GitHubReviewPayload } from "./github-types.mts"
import type { Log } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"

type RunAnalysisDependencies = {
	spawnGit: SpawnGit
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	log: Log
}

async function runAnalysis(dependencies: RunAnalysisDependencies, agentNames: AgentNames, diffText: string, baseCommit: string): Promise<AiReviewResult> {
	const { agents } = await dependencies.loadAgents(agentNames)
	const aggregator = await dependencies.loadAggregator()
	const baseCommitContext = await getBaseCommitContext({ spawnGit: dependencies.spawnGit }, baseCommit)
	return analyze({ callApi: dependencies.callApi, log: dependencies.log }, baseCommitContext, diffText, agents, aggregator)
}

type SubmitPrReviewDependencies = {
	spawnGit: SpawnGit
	fetchPullRequestDiff: () => Promise<string>
	fetchPullRequestBaseCommit: () => Promise<string>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	log: Log
	submitReview: (review: GitHubReviewPayload) => Promise<void>
}

async function submitPrReview(dependencies: SubmitPrReviewDependencies, agentNames: AgentNames): Promise<void> {
	const diffText = await dependencies.fetchPullRequestDiff()

	if (diffText.trim() === "") {
		dependencies.log("No files changed, nothing to review")
		return
	}

	const baseCommit = await dependencies.fetchPullRequestBaseCommit()
	const aiResult = await runAnalysis(dependencies, agentNames, diffText, baseCommit)
	const reviewPayload = buildReviewPayload(aiResult)
	await dependencies.submitReview(reviewPayload)
	dependencies.log("PR review submitted successfully")
}

type RunOnCommentTriggerDependencies = {
	spawnGit: SpawnGit
	fetchPullRequestDiff: () => Promise<string>
	fetchPullRequestBaseCommit: () => Promise<string>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	log: Log
	submitReview: (review: GitHubReviewPayload) => Promise<void>
}

export async function runOnCommentTrigger(dependencies: RunOnCommentTriggerDependencies, configuration: CommentTriggerConfiguration): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") {
		dependencies.log("No /review trigger found in comment")
		return
	}

	await submitPrReview(dependencies, triggerResult)
}

type RunOnPullRequestDependencies = {
	spawnGit: SpawnGit
	fetchPullRequestDiff: () => Promise<string>
	fetchPullRequestBaseCommit: () => Promise<string>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	log: Log
	submitReview: (review: GitHubReviewPayload) => Promise<void>
}

export async function runOnPullRequest(dependencies: RunOnPullRequestDependencies, configuration: PullRequestConfiguration): Promise<void> {
	await submitPrReview(dependencies, configuration.agents)
}

type RunOnLocalDiffDependencies = {
	spawnGit: SpawnGit
	generateLocalDiff: (baseCommit: string, headCommit: string) => Promise<string>
	validateGitRepository: () => void
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	log: Log
}

export async function runOnLocalDiff(dependencies: RunOnLocalDiffDependencies, configuration: LocalDiffConfiguration): Promise<string> {
	await validateGitEnvironment({ spawnGit: dependencies.spawnGit, validateGitRepository: dependencies.validateGitRepository }, configuration.baseCommit, configuration.headCommit)

	const diffText = await dependencies.generateLocalDiff(configuration.baseCommit, configuration.headCommit)

	if (diffText.trim() === "") return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, diffText, configuration.baseCommit)
	return formatReviewForConsole(aiResult)
}
