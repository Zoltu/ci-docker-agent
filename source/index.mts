import type { PrFile } from "./github-types.mts"
import { getConfig, type CommentTriggerConfiguration, type PullRequestConfiguration, type LocalDiffConfiguration } from "./configuration.mts"
import { shouldRunCI } from "./trigger.mts"
import { fetchPrFiles, submitReview, reactToComment } from "./github.mts"
import { generateLocalDiff } from "./diff.mts"
import { createAiClient } from "./ai.mts"
import { loadAgents, loadAggregator } from "./agents.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"
import type { AiReviewResult } from "./review.mts"
import { assertNever } from "./typescript-helpers.mts"

async function runAnalysis(agentNames: string[], files: PrFile[]): Promise<AiReviewResult> {
	const { agents } = await loadAgents(agentNames)
	const aggregator = await loadAggregator()
	const aiClient = createAiClient()
	return aiClient.analyze(files, agents, aggregator)
}

async function runOnCommentTrigger(config: CommentTriggerConfiguration): Promise<void> {
	const triggerResult = shouldRunCI("issue_comment", config.commentBody)

	if (!triggerResult.shouldRun) return

	try {
		const agentNames = [...config.agents, ...triggerResult.agentNames]
		const files = await fetchPrFiles(config.github)

		if (files.length === 0) return console.log("No files changed, nothing to review")

		const aiResult = await runAnalysis(agentNames, files)
		const reviewPayload = buildReviewPayload(aiResult)
		await submitReview(config.github, reviewPayload)
		console.log("PR review submitted successfully")
	} catch (error) {
		try {
			await reactToComment(config.github, config.commentId, "-1")
		} catch (reactionError) {
			console.error("Failed to react to comment:", reactionError)
		}
		throw error
	}
}

async function runOnPullRequest(config: PullRequestConfiguration): Promise<void> {
	const files = await fetchPrFiles(config.github)

	if (files.length === 0) return console.log("No files changed, nothing to review")

	const aiResult = await runAnalysis(config.agents, files)
	const reviewPayload = buildReviewPayload(aiResult)
	await submitReview(config.github, reviewPayload)
	console.log("PR review submitted successfully")
}

async function runOnLocalDiff(config: LocalDiffConfiguration): Promise<void> {
	const files = await generateLocalDiff(config.baseCommit, config.headCommit)

	if (files.length === 0) return console.log("No files changed, nothing to review")

	const aiResult = await runAnalysis(config.agents, files)
	console.log("\n" + formatReviewForConsole(aiResult, files))
}

async function main(): Promise<void> {
	const config = getConfig(Bun.env)

	switch (config.type) {
		case "comment-trigger":
			return runOnCommentTrigger(config)
		case "pull-request":
			return runOnPullRequest(config)
		case "local-diff":
			return runOnLocalDiff(config)
		default:
			assertNever(config)
	}
}

main().catch(error => {
	console.error("CI Agent failed:", error)
	process.exit(1)
})
