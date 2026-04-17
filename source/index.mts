import type { PrFile } from "./github-types.mts"
import { parseEnvironment } from "./environment.mts"
import { shouldRunCI } from "./trigger.mts"
import { fetchPrFiles, submitReview, reactToComment } from "./github.mts"
import { generateLocalDiff } from "./diff.mts"
import { createAiClient } from "./ai.mts"
import { loadAgents, loadAggregator } from "./agents.mts"
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

	const agentNames = [...config.agents, ...triggerResult.agentNames]
	if (agentNames.length > 0) {
		console.log("Agents to run:", agentNames.join(", "))
	}

	const { agents: loadedAgents, unresolvedNames } = await loadAgents(agentNames)

	if (config.mode === "github" && config.github?.commentId) {
		const unresolvedFromComment = triggerResult.agentNames.filter(name => unresolvedNames.includes(name))
		if (unresolvedFromComment.length > 0) {
			console.log(`Unresolved agents from comment: ${unresolvedFromComment.join(", ")}`)
			await reactToComment(config.github, config.github.commentId, "-1")
			return
		}
	}

	const aggregator = await loadAggregator()
	if (!aggregator) {
		throw new Error("No aggregator agent found. A builtin Aggregator.md must exist in the agents directory.")
	}

	console.log(`Loaded ${loadedAgents.length} agents: ${loadedAgents.map(a => a.name).join(", ")}`)
	console.log(`Using aggregator: ${aggregator.name}`)

	let files: PrFile[] = []

	if (config.mode === "github" && config.github) {
		console.log("Repository:", config.github.repo)
		console.log("PR Number:", config.github.prNumber)
		files = await fetchPrFiles(config.github)
	} else if (config.mode === "local-diff" && config.localDiff) {
		console.log("Base commit:", config.localDiff.baseCommit)
		console.log("Head commit:", config.localDiff.headCommit)
		files = await generateLocalDiff(config.localDiff.baseCommit, config.localDiff.headCommit)
	}

	const aiClient = createAiClient()
	const aiResult = await aiClient.analyze(files, loadedAgents, aggregator)

	if (config.mode === "github" && config.github) {
		const reviewPayload = buildReviewPayload(aiResult)
		await submitReview(config.github, reviewPayload)
		console.log("PR review submitted successfully")
	} else {
		const consoleOutput = formatReviewForConsole(aiResult, files)
		console.log("\n" + consoleOutput)
	}
}

main().catch(error => {
	console.error("CI Agent failed:", error)
	process.exit(1)
})
