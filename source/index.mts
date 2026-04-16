import type { PrFile } from "./github-types.mts"
import { parseEnvironment } from "./environment.mts"
import { shouldRunCI } from "./trigger.mts"
import { fetchPrFiles, submitReview } from "./github.mts"
import { generateLocalDiff } from "./diff.mts"
import { createPlaceholderAiClient } from "./ai.mts"
import { buildReviewPayload, formatReviewForConsole } from "./review.mts"

async function main(): Promise<void> {
	const config = parseEnvironment()

	console.log("CI Agent started")
	console.log("Mode:", config.mode)
	console.log("Event type:", config.eventType)
	console.log("Agents from env:", config.agents.length > 0 ? config.agents.join(", ") : "Default")

	const triggerResult = shouldRunCI(config.eventType, config.commentBody)

	if (!triggerResult.shouldRun) {
		console.log("No trigger found, skipping CI checks")
		return
	}

	// Merge agents from env var with agents from trigger comment
	const agentNames = [...config.agents, ...triggerResult.agentNames]
	if (agentNames.length > 0) {
		console.log("Agents to run:", agentNames.join(", "))
	}

	let files: PrFile[] = []

	if (config.mode === "github" && config.github) {
		console.log("Repository:", config.github.repo)
		console.log("PR Number:", config.github.prNumber)
		files = await fetchPrFiles(config.github)
	} else if (config.mode === "local-diff" && config.localDiff) {
		console.log("Base commit:", config.localDiff.baseCommit)
		console.log("Head commit:", config.localDiff.headCommit)
		const diffResult = await generateLocalDiff(
			config.localDiff.baseCommit,
			config.localDiff.headCommit
		)
		files = diffResult.files
	}

	const aiClient = createPlaceholderAiClient()
	const aiResult = await aiClient.analyze(files, agentNames)

	if (config.mode === "github" && config.github) {
		const reviewPayload = buildReviewPayload(aiResult)
		await submitReview(config.github, reviewPayload)
		console.log("PR review submitted successfully")
	} else {
		const consoleOutput = formatReviewForConsole(aiResult, files)
		console.log("\n" + consoleOutput)
	}
}

main()
