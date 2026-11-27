import type { Fetch, Random, Sleep } from "./agent-loop.mts"
import type { Agent, AgentReader, ReviewerRun } from "./agents.mts"
import { loadAggregator, loadReviewerRun, loadSelectedAgents } from "./agents.mts"
import { analyze } from "./ai.mts"
import { getBaseCommitContext } from "./base-commit.mts"
import type { LabelTriggerConfiguration, LocalDiffConfiguration, PullRequestConfiguration } from "./configuration.mts"
import type { DebugWriter } from "./debug.mts"
import type { SpawnGit } from "./diff.mts"
import { ensureCommitAvailable, generateLocalDiff, validateGitEnvironment } from "./diff.mts"
import type { GitHubConfiguration } from "./github-types.mts"
import type { GitHubFetch } from "./github.mts"
import { fetchPullRequestDiff, fetchPullRequestMetadata, removePullRequestLabel, submitReview } from "./github.mts"
import { isTriggerLabel, selectAgentNamesFromLabels, selectLabelNamesToRemove } from "./labels.mts"
import type { Logger } from "./logger.mts"
import type { ProviderProfile } from "./provider-profiles.mts"
import type { AiReviewResult } from "./review.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import { sanitizeForSingleLine } from "./typescript-helpers.mts"
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

async function runAnalysis(dependencies: OrchestratorDependencies, agents: readonly Agent[], userAgentsDirectory: string, builtinAgentsDirectory: string, diffText: string, baseCommit: string, model: string, maxTokens: number, profile: ProviderProfile, submit?: (result: AiReviewResult) => Promise<AggregatorSubmitResult>): Promise<AiReviewResult> {
	const aggregator = await loadAggregator(dependencies, userAgentsDirectory, builtinAgentsDirectory)
	await ensureCommitAvailable(dependencies, baseCommit)
	const baseCommitContext = await getBaseCommitContext(dependencies, baseCommit)
	return analyze(dependencies, baseCommitContext, diffText, agents, aggregator, baseCommit, model, maxTokens, profile, submit)
}

async function submitPrReview(dependencies: OrchestratorDependencies, reviewerRun: ReviewerRun, baseSha: string, userAgentsDirectory: string, builtinAgentsDirectory: string, githubConfiguration: GitHubConfiguration, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const diffText = await fetchPullRequestDiff(dependencies, githubConfiguration)

	if (diffText.trim() === "") {
		dependencies.logger.log("No files changed, nothing to review")
		return
	}

	const submit = async (result: AiReviewResult): Promise<AggregatorSubmitResult> => {
		const outcome = await submitReview(dependencies, githubConfiguration, buildReviewPayload(result, reviewerRun.coverage))
		if (outcome.ok) return { kind: "ok" }
		if (outcome.status === 422) {
			dependencies.logger.log(`GitHub rejected aggregator output with ${outcome.status}, sending feedback to aggregator`)
			return { kind: "retry", feedback: `Your previous output failed on submission to GitHub:\nHTTP Status: ${outcome.status}\n${outcome.body}` }
		}
		// main prints the fatal message, so a multi-line body would forge extra log lines; the retry feedback above is read by the aggregator as data and keeps the body byte-exact.
		return { kind: "fatal", message: `Failed to submit review: ${outcome.status} ${sanitizeForSingleLine(outcome.body)}` }
	}
	await runAnalysis(dependencies, reviewerRun.agents, userAgentsDirectory, builtinAgentsDirectory, diffText, baseSha, model, maxTokens, profile, submit)
	dependencies.logger.log("PR review submitted successfully")
}

export async function runOnPullRequest(dependencies: OrchestratorDependencies, configuration: PullRequestConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const metadata = await fetchPullRequestMetadata(dependencies, configuration.github)
	const reviewerRun = await loadReviewerRun(dependencies, userAgentsDirectory, builtinAgentsDirectory, () => configuration.agents)
	await submitPrReview(dependencies, reviewerRun, metadata.baseSha, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, maxTokens, profile)
}

export async function runOnLabelTrigger(dependencies: OrchestratorDependencies, configuration: LabelTriggerConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, profile: ProviderProfile): Promise<void> {
	const metadata = await fetchPullRequestMetadata(dependencies, configuration.github)

	// The guard has no listed spelling to name because none matched, so the message echoes the configured `TRIGGER_LABEL`, a value configuration already accepted as matching `Review Start` ignoring case.
	if (!metadata.labelNames.some(isTriggerLabel)) throw new Error(`Invalid PR labels: "${sanitizeForSingleLine(configuration.triggerLabel)}" is missing from pull request #${configuration.github.pullRequestNumber}. Re-add the label to start a new run.`)

	// The trigger label and every selector label are removed before any validation and before any agent runs, so a run that fails hard can be retried by adding the one label back and no selector can narrow a later run.
	for (const labelName of selectLabelNamesToRemove(metadata.labelNames)) {
		await removePullRequestLabel(dependencies, configuration.github, labelName)
		// A removed label is gone from the pull request, so the run's own log is the only record of what it consumed.
		// A label name can carry an invisible character that would make that record read differently from the bytes deleted, so it is escaped like every other untrusted name.
		dependencies.logger.log(`Removed label "${sanitizeForSingleLine(labelName)}"`)
	}

	// The labels the pull request carried are the selection input even though they are now gone, so the selection is made from the metadata read before removal.
	const reviewerRun = await loadReviewerRun(dependencies, userAgentsDirectory, builtinAgentsDirectory, availableAgentNames => selectAgentNamesFromLabels(metadata.labelNames, availableAgentNames))
	await submitPrReview(dependencies, reviewerRun, metadata.baseSha, userAgentsDirectory, builtinAgentsDirectory, configuration.github, model, maxTokens, profile)
}

// workspaceDirectory is advisory and only appears in diagnostics.
// The working directory is captured where the git spawner is created, so a misaligned argument here surfaces as a misleading message instead of a read from the wrong directory.
export async function runOnLocalDiff(dependencies: OrchestratorDependencies, configuration: LocalDiffConfiguration, userAgentsDirectory: string, builtinAgentsDirectory: string, model: string, maxTokens: number, workspaceDirectory: string, profile: ProviderProfile): Promise<string> {
	await validateGitEnvironment(dependencies, configuration.baseCommit, configuration.headCommit, workspaceDirectory)

	const diffText = await generateLocalDiff(dependencies, configuration.baseCommit, configuration.headCommit)

	if (diffText.trim() === "") return "No files changed, nothing to review"

	const agents = await loadSelectedAgents(dependencies, userAgentsDirectory, builtinAgentsDirectory, () => configuration.agents)
	const aiResult = await runAnalysis(dependencies, agents, userAgentsDirectory, builtinAgentsDirectory, diffText, configuration.baseCommit, model, maxTokens, profile)
	return formatReviewForConsole(aiResult)
}
