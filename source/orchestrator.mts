import type { GitHubReviewPayload } from "./github-types.mts"
import type { AgentNames, ResolveResult, Agent } from "./agents.mts"
import type { AiReviewResult } from "./review.mts"
import type { CallApi } from "./ai.mts"
import { analyze } from "./ai.mts"
import type { BaseCommitContext } from "./base-commit.mts"
import type { DiffResult } from "./diff.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"
import type { CommentTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "./configuration.mts"

type RunAnalysisDependencies = {
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	getBaseCommitContext: (baseCommit: string) => Promise<BaseCommitContext>
}

export async function runAnalysis(dependencies: RunAnalysisDependencies, agentNames: AgentNames, diffResult: DiffResult, baseCommit: string): Promise<AiReviewResult> {
	const { agents } = await dependencies.loadAgents(agentNames)
	const aggregator = await dependencies.loadAggregator()
	const baseCommitContext = await dependencies.getBaseCommitContext(baseCommit)
	return analyze({ callApi: dependencies.callApi }, baseCommitContext, diffResult, agents, aggregator)
}

type SubmitPrReviewDependencies = {
	fetchPullRequestDiff: () => Promise<DiffResult>
	fetchPullRequestBaseCommit: () => Promise<string>
	getBaseCommitContext: (baseCommit: string) => Promise<BaseCommitContext>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	submitReview: (review: GitHubReviewPayload) => Promise<void>
}

async function submitPrReview(dependencies: SubmitPrReviewDependencies, agentNames: AgentNames): Promise<void> {
	const diffResult = await dependencies.fetchPullRequestDiff()

	if (diffResult.files.length === 0 && diffResult.binaryFiles.length === 0) return console.log("No files changed, nothing to review")

	const baseCommit = await dependencies.fetchPullRequestBaseCommit()
	const aiResult = await runAnalysis(dependencies, agentNames, diffResult, baseCommit)
	const reviewPayload = buildReviewPayload(aiResult)
	await dependencies.submitReview(reviewPayload)
	console.log("PR review submitted successfully")
}

type RunOnCommentTriggerDependencies = {
	fetchPullRequestDiff: () => Promise<DiffResult>
	fetchPullRequestBaseCommit: () => Promise<string>
	getBaseCommitContext: (baseCommit: string) => Promise<BaseCommitContext>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	submitReview: (review: GitHubReviewPayload) => Promise<void>
	reactToComment: (commentId: number, content: string) => Promise<void>
}

export async function runOnCommentTrigger(dependencies: RunOnCommentTriggerDependencies, configuration: CommentTriggerConfiguration): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") return

	try {
		await submitPrReview(dependencies, triggerResult)
	} catch (error) {
		try {
			// Alert the user that something went wrong (the review itself is the positive feedback)
			await dependencies.reactToComment(configuration.commentId, "-1")
		} catch (reactionError) {
			console.error(`Failed to react to comment ${configuration.commentId} with "-1":`, reactionError)
		}
		throw error
	}
}

type RunOnPullRequestDependencies = {
	fetchPullRequestDiff: () => Promise<DiffResult>
	fetchPullRequestBaseCommit: () => Promise<string>
	getBaseCommitContext: (baseCommit: string) => Promise<BaseCommitContext>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
	submitReview: (review: GitHubReviewPayload) => Promise<void>
}

export async function runOnPullRequest(dependencies: RunOnPullRequestDependencies, configuration: PullRequestConfiguration): Promise<void> {
	await submitPrReview(dependencies, configuration.agents)
}

type RunOnLocalDiffDependencies = {
	generateLocalDiff: (baseCommit: string, headCommit: string) => Promise<DiffResult>
	getBaseCommitContext: (baseCommit: string) => Promise<BaseCommitContext>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	callApi: CallApi
}

export async function runOnLocalDiff(dependencies: RunOnLocalDiffDependencies, configuration: LocalDiffConfiguration): Promise<string> {
	const diffResult = await dependencies.generateLocalDiff(configuration.baseCommit, configuration.headCommit)

	if (diffResult.files.length === 0 && diffResult.binaryFiles.length === 0) return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, diffResult, configuration.baseCommit)
	return formatReviewForConsole(aiResult, diffResult)
}
