import type { Fetch, Random, Sleep } from "./agent-loop.mts"
import type { AgentNames, AgentReader } from "./agents.mts"
import { loadAgents, loadAggregator } from "./agents.mts"
import { analyze } from "./ai.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import type { CommentTriggerConfiguration, LabelTriggerConfiguration, LocalDiffConfiguration, PullRequestConfiguration } from "./configuration.mts"
import type { DebugWriter } from "./debug.mts"
import type { SpawnGit } from "./diff.mts"
import { ensureCommitAvailable, generateLocalDiff, validateGitEnvironment } from "./diff.mts"
import type { GitHubConfiguration } from "./github-types.mts"
import type { GitHubFetch } from "./github.mts"
import { fetchPullRequestDiff, fetchPullRequestMetadata, removePullRequestLabel, submitReview } from "./github.mts"
import { selectAgentNamesFromLabels } from "./labels.mts"
import type { Logger } from "./logger.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import type { AiReviewResult } from "./review.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { getAgentsFromComment } from "./trigger.mts"
import { includes } from "./typescript-helpers.mts"
import type { AggregatorSubmitResult } from "./ai.mts"

type OrchestratorDependencies = {
	spawnGit: SpawnGit
	readAgents: AgentReader
	githubFetch: GitHubFetch
	fetch: Fetch
	logger: Logger
	debugWriter: DebugWriter
	sleep: Sleep
	random: Random
}

async function runAnalysis(dependencies: OrchestratorDependencies, agentNames: AgentNames, userAgentsDirectory: string, builtinAgentsDirectory: string, diffText: string, baseCommit: string, model: string, maxTokens: number, profile: ProviderProfile, submit?: (result: AiReviewResult) => Promise<AggregatorSubmitResult>): Promise<AiReviewResult> {
	const agents = await loadAgents(dependencies, userAgentsDirectory, builtinAgentsDirectory, agentNames)
	const aggregator = await loadAggregator(dependencies, userAgentsDirectory, builtinAgentsDirectory)
	await ensureCommitAvailable(dependencies, baseCommit)
	const baseCommitContext = await getBaseCommitContext(dependencies, baseCommit)
	return analyze(dependencies, baseCommitContext, diffText, agents, aggregator, baseCommit, model, maxTokens, profile, submit)
}

async function submitPrReview(dependencies: OrchestratorDependencies, agentNames: AgentNames, baseSha: string, userAgentsDirectory: string, builtinAgentsDirectory: string, githubConfiguration: GitHubConfiguration, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const diffText = await fetchPullRequestDiff(dependencies, githubConfiguration)

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
	await runAnalysis(dependencies, agentNames, userAgentsDirectory, builtinAgentsDirectory, diffText, baseSha, model, maxTokens, profile, submit)
	dependencies.logger.log("PR review submitted successfully")
}

export async function runOnCommentTrigger(dependencies: OrchestratorDependencies, configuration: CommentTriggerConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const triggerResult = getAgentsFromComment(configuration.commentBody)

	if (triggerResult === "no review triggered") {
		dependencies.logger.log("No /review trigger found in comment")
		return
	}

	const metadata = await fetchPullRequestMetadata(dependencies, configuration.github)
	await submitPrReview(dependencies, triggerResult, metadata.baseSha, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, maxTokens, profile)
}

export async function runOnPullRequest(dependencies: OrchestratorDependencies, configuration: PullRequestConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const metadata = await fetchPullRequestMetadata(dependencies, configuration.github)
	await submitPrReview(dependencies, configuration.agents, metadata.baseSha, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, maxTokens, profile)
}

export async function runOnLabelTrigger(dependencies: OrchestratorDependencies, configuration: LabelTriggerConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const metadata = await fetchPullRequestMetadata(dependencies, configuration.github)

	if (!includes(metadata.labelNames, configuration.triggerLabel)) throw new Error(`Label "${configuration.triggerLabel}" is not on pull request #${configuration.github.pullRequestNumber}. Re-add the label to start a new run.`)

	// The trigger label is removed before any validation and before any agent runs, so a run that fails hard can be retried by adding the one label back.
	await removePullRequestLabel(dependencies, configuration.github, configuration.triggerLabel)

	const userAgents = await dependencies.readAgents(userAgentsDirectory)
	const builtinAgents = await dependencies.readAgents(builtinAgentsDirectory)
	const agentNames = selectAgentNamesFromLabels(metadata.labelNames, [...userAgents, ...builtinAgents].map(agent => agent.name))
	await submitPrReview(dependencies, agentNames, metadata.baseSha, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, maxTokens, profile)
}

export async function runOnLocalDiff(dependencies: OrchestratorDependencies, configuration: LocalDiffConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, workspaceDirectory: string, profile: ProviderProfile): Promise<string> {
	await validateGitEnvironment(dependencies, configuration.baseCommit, configuration.headCommit, workspaceDirectory)

	const diffText = await generateLocalDiff(dependencies, configuration.baseCommit, configuration.headCommit)

	if (diffText.trim() === "") return "No files changed, nothing to review"

	const aiResult = await runAnalysis(dependencies, configuration.agents, userAgentsDirectory, builtinAgentsDirectory, diffText, configuration.baseCommit, model, maxTokens, profile)
	return formatReviewForConsole(aiResult)
}
