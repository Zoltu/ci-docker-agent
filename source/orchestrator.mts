import type { Fetch } from "./agent-loop.mts"
import type { AgentNames, AgentReader } from "./agents.mts"
import { loadAgents, loadAggregator } from "./agents.mts"
import { analyze } from "./ai.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import type { CommentTriggerConfiguration, LocalDiffConfiguration, PullRequestConfiguration } from "./configuration.mts"
import type { DebugWriter } from "./debug.mts"
import type { SpawnGit } from "./diff.mts"
import { ensureCommitAvailable, generateLocalDiff, validateGitEnvironment } from "./diff.mts"
import type { GitHubConfiguration } from "./github-types.mts"
import type { GitHubFetch } from "./github.mts"
import { fetchPullRequestBaseCommit, fetchPullRequestDiff, submitReview } from "./github.mts"
import type { Logger } from "./logger.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import type { AiReviewResult } from "./review.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"
import type { AggregatorSubmitResult } from "./ai.mts"

type OrchestratorDependencies = {
	spawnGit: SpawnGit
	readAgents: AgentReader
	githubFetch: GitHubFetch
	fetch: Fetch
	logger: Logger
	debugWriter: DebugWriter
}

async function runAnalysis(dependencies: OrchestratorDependencies, agentNames: AgentNames, userAgentsDirectory: string, builtinAgentsDirectory: string, diffText: string, baseCommit: string, model: string, profile: ProviderProfile, submit?: (result: AiReviewResult) => Promise<AggregatorSubmitResult>): Promise<AiReviewResult> {
	const agents = await loadAgents(dependencies, userAgentsDirectory, builtinAgentsDirectory, agentNames)
	const aggregator = await loadAggregator(dependencies, userAgentsDirectory, builtinAgentsDirectory)
	await ensureCommitAvailable(dependencies, baseCommit)
	const baseCommitContext = await getBaseCommitContext(dependencies, baseCommit)
	return analyze(dependencies, baseCommitContext, diffText, agents, aggregator, baseCommit, model, profile, submit)
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

	const submit = async (result: AiReviewResult): Promise<AggregatorSubmitResult> => {
		const outcome = await submitReview(dependencies, githubConfiguration, buildReviewPayload(result))
		if (outcome.ok) return { kind: "ok" }
		if (outcome.status === 422) {
			dependencies.logger.log(`GitHub rejected aggregator output with ${outcome.status}, sending feedback to aggregator`)
			return { kind: "retry", feedback: `Your previous output failed on submission to GitHub:\nHTTP Status: ${outcome.status}\n${outcome.body}` }
		}
		return { kind: "fatal", message: `Failed to submit review: ${outcome.status} ${outcome.body}` }
	}
	await runAnalysis(dependencies, agentNames, userAgentsDirectory, builtinAgentsDirectory, diffText, baseCommit, model, profile, submit)
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
