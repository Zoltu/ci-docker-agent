import type { PullRequestFile, GitHubReviewPayload } from "./github-types.mts"
import type { AgentNames, ResolveResult, Agent } from "./agents.mts"
import type { AiReviewResult } from "./review.mts"
import type { CallApi } from "./ai.mts"
import { analyze } from "./ai.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"
import type { CommentTriggerConfiguration, PullRequestConfiguration, LocalDiffConfiguration } from "./configuration.mts"

type RunAnalysisDependencies = { loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>; loadAggregator: () => Promise<Agent>; callApi: CallApi }

export async function runAnalysis(dependencies: RunAnalysisDependencies, agentNames: AgentNames, files: PullRequestFile[]): Promise<AiReviewResult> {
	const { agents } = await dependencies.loadAgents(agentNames)
	const aggregator = await dependencies.loadAggregator()
	return analyze({ callApi: dependencies.callApi }, files, agents, aggregator)
}

type RunOnCommentTriggerDependencies = { fetchPullRequestFiles: () => Promise<PullRequestFile[]>; loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>; loadAggregator: () => Promise<Agent>; callApi: CallApi; submitReview: (review: GitHubReviewPayload) => Promise<void>; reactToComment: (commentId: number, content: string) => Promise<void> }

export async function runOnCommentTrigger(dependencies: RunOnCommentTriggerDependencies, configuration: CommentTriggerConfiguration): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") return

	try {
		const files = await dependencies.fetchPullRequestFiles()

		if (files.length === 0) return console.log("No files changed, nothing to review")

		const aiResult = await runAnalysis(dependencies, triggerResult, files)
		const reviewPayload = buildReviewPayload(aiResult)
		await dependencies.submitReview(reviewPayload)
		console.log("PR review submitted successfully")
	} catch (error) {
		try {
			await dependencies.reactToComment(configuration.commentId, "-1")
		} catch (reactionError) {
			console.error(`Failed to react to comment ${configuration.commentId} with "-1":`, reactionError)
		}
		throw error
	}
}

type RunOnPullRequestDependencies = { fetchPullRequestFiles: () => Promise<PullRequestFile[]>; loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>; loadAggregator: () => Promise<Agent>; callApi: CallApi; submitReview: (review: GitHubReviewPayload) => Promise<void> }

export async function runOnPullRequest(dependencies: RunOnPullRequestDependencies, configuration: PullRequestConfiguration): Promise<void> {
	const files = await dependencies.fetchPullRequestFiles()

	if (files.length === 0) return console.log("No files changed, nothing to review")

	const aiResult = await runAnalysis(dependencies, configuration.agents, files)
	const reviewPayload = buildReviewPayload(aiResult)
	await dependencies.submitReview(reviewPayload)
	console.log("PR review submitted successfully")
}

type RunOnLocalDiffDependencies = { generateLocalDiff: (baseCommit: string, headCommit: string) => Promise<PullRequestFile[]>; loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>; loadAggregator: () => Promise<Agent>; callApi: CallApi }

export async function runOnLocalDiff(dependencies: RunOnLocalDiffDependencies, configuration: LocalDiffConfiguration): Promise<string> {
	const files = await dependencies.generateLocalDiff(configuration.baseCommit, configuration.headCommit)

	if (files.length === 0) return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, files)
	return "\n" + formatReviewForConsole(aiResult, files)
}
