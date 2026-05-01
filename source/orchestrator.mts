import type { Agent, AgentNames, ResolveResult } from "./agents.mts"
import type { AiFetch } from "./ai.mts"
import { analyze } from "./ai.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import type { CommentTriggerConfiguration, LocalDiffConfiguration, PullRequestConfiguration } from "./configuration.mts"
import type { SpawnGit } from "./diff.mts"
import { ensureCommitAvailable, validateGitEnvironment } from "./diff.mts"
import type { DebugWriter } from "./debug.mts"
import type { GitHubReviewPayload } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import type { AiReviewResult } from "./review.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"

type RunAnalysisDependencies = {
	spawnGit: SpawnGit
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	aiFetch: AiFetch
	logger: Logger
	debugWriter: DebugWriter
}

async function runAnalysis(dependencies: RunAnalysisDependencies, agentNames: AgentNames, diffText: string, baseCommit: string): Promise<AiReviewResult> {
	const { agents } = await dependencies.loadAgents(agentNames)
	const aggregator = await dependencies.loadAggregator()
	await ensureCommitAvailable({ spawnGit: dependencies.spawnGit }, baseCommit)
	const baseCommitContext = await getBaseCommitContext({ spawnGit: dependencies.spawnGit }, baseCommit)
	return analyze(dependencies, baseCommitContext, diffText, agents, aggregator)
}

type SubmitPrReviewDependencies = {
	spawnGit: SpawnGit
	fetchPullRequestDiff: () => Promise<string>
	fetchPullRequestBaseCommit: () => Promise<string>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	aiFetch: AiFetch
	logger: Logger
	submitReview: (review: GitHubReviewPayload) => Promise<void>
	debugWriter: DebugWriter
}

async function submitPrReview(dependencies: SubmitPrReviewDependencies, agentNames: AgentNames): Promise<void> {
	const [diffText, baseCommit] = await Promise.all([
		dependencies.fetchPullRequestDiff(),
		dependencies.fetchPullRequestBaseCommit(),
	])

	if (diffText.trim() === "") {
		dependencies.logger.log("No files changed, nothing to review")
		return
	}

	const aiResult = await runAnalysis(dependencies, agentNames, diffText, baseCommit)
	const reviewPayload = buildReviewPayload(aiResult)
	await dependencies.submitReview(reviewPayload)
	dependencies.logger.log("PR review submitted successfully")
}

type RunOnCommentTriggerDependencies = {
	spawnGit: SpawnGit
	fetchPullRequestDiff: () => Promise<string>
	fetchPullRequestBaseCommit: () => Promise<string>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	aiFetch: AiFetch
	logger: Logger
	submitReview: (review: GitHubReviewPayload) => Promise<void>
	debugWriter: DebugWriter
}

export async function runOnCommentTrigger(dependencies: RunOnCommentTriggerDependencies, configuration: CommentTriggerConfiguration): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") {
		dependencies.logger.log("No /review trigger found in comment")
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
	aiFetch: AiFetch
	logger: Logger
	submitReview: (review: GitHubReviewPayload) => Promise<void>
	debugWriter: DebugWriter
}

export async function runOnPullRequest(dependencies: RunOnPullRequestDependencies, configuration: PullRequestConfiguration): Promise<void> {
	await submitPrReview(dependencies, configuration.agents)
}

type RunOnLocalDiffDependencies = {
	spawnGit: SpawnGit
	generateLocalDiff: (baseCommit: string, headCommit: string) => Promise<string>
	validateGitRepository: () => Promise<void>
	loadAgents: (agentNames: AgentNames) => Promise<ResolveResult>
	loadAggregator: () => Promise<Agent>
	aiFetch: AiFetch
	logger: Logger
	debugWriter: DebugWriter
}

export async function runOnLocalDiff(dependencies: RunOnLocalDiffDependencies, configuration: LocalDiffConfiguration): Promise<string> {
	await validateGitEnvironment({ spawnGit: dependencies.spawnGit, validateGitRepository: dependencies.validateGitRepository }, configuration.baseCommit, configuration.headCommit)

	const diffText = await dependencies.generateLocalDiff(configuration.baseCommit, configuration.headCommit)

	if (diffText.trim() === "") return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, diffText, configuration.baseCommit)
	return formatReviewForConsole(aiResult)
}
