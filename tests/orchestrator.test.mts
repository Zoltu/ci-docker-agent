import { describe, it, expect } from "bun:test"
import { runOnLabelTrigger, runOnPullRequest, runOnLocalDiff } from "../source/orchestrator.mts"
import { AGGREGATOR_AGENT_NAME, type Agent, type AgentReader } from "../source/agents.mts"
import { REVIEW_START_LABEL } from "../source/labels.mts"
import { IDENTITY_PROFILE } from "../source/provider-profiles.mts"
import type { SpawnGit, GitDiffResult } from "../source/diff.mts"
import type { Fetch, Random, Sleep } from "../source/agent-loop.mts"
import type { GitHubFetch } from "../source/github.mts"
import type { Logger } from "../source/logger.mts"
import { BASE_COMMIT_SHA, makeAgent, makeLabelTriggerConfiguration, makePullRequestConfiguration, makeLocalDiffConfiguration, createMockLogger, createMockAgentFetch, buildContentSse } from "./helpers.mts"
import type { DebugWriter } from "../source/debug.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"

const silentLogger = createMockLogger()
const noopDebugWriter: DebugWriter = { writePrompt: async () => {}, writeTrace: async () => {} }
const instantSleep: Sleep = async () => {}
const fixedRandom: Random = () => 1

const userAgentsDirectory = "/test/user-agents"
const builtinAgentsDirectory = "/test/builtin-agents"

// The shipped builtin agents directory holds the Default reviewer and the Aggregator, so a repository with no .ci-agents of its own reviews with Default alone.
const shippedBuiltinAgents: Agent[] = [
	{ name: "Default", prompt: "Builtin default prompt." },
	{ name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." },
]

function makeReadAgents(userAgents: Agent[], builtinAgents: Agent[] = []): AgentReader {
	return async (directory: string) => {
		if (directory === userAgentsDirectory) return userAgents
		if (directory === builtinAgentsDirectory) return builtinAgents
		throw new Error(`Unexpected readAgents directory: ${directory}`)
	}
}

function makeFetch(body: string, capturedBodies?: string[]): Fetch {
	const respond = createMockAgentFetch(buildContentSse(JSON.stringify({ body, comments: [] })))
	if (capturedBodies === undefined) return respond
	return async (signal, requestBody, headers) => {
		capturedBodies.push(requestBody)
		return respond(signal, requestBody, headers)
	}
}

// The system message of each request carries the prompt of the agent that request belongs to.
function requestedAgentNames(bodies: readonly string[], agents: readonly Agent[]): string[] {
	const agentNames: string[] = []
	for (const body of bodies) {
		const systemPrompt = JSON.parse(body).messages[0].content
		const agent = agents.find(candidate => candidate.prompt === systemPrompt)
		if (agent === undefined) continue
		agentNames.push(agent.name)
	}
	return agentNames
}

function makeSpawnGitOk(): SpawnGit {
	return async (params: string[]) => {
		if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
		return { stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
	}
}

function makeSpawnGitWithDiff(diffText: string): SpawnGit {
	return async (params: string[]) => {
		if (params[0] === "diff") return { stdout: diffText, stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
		if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
		return { stdout: "", stderr: "", exitCode: 0, signalCode: null } satisfies GitDiffResult
	}
}

function makeGithubFetch(options: { diffText?: string, baseCommit?: string, labelNames?: readonly string[], diffError?: Error, submitStatus?: number, submitResponses?: readonly { status: number; body?: string }[], deleteLabelStatus?: number } = {}): { githubFetch: GitHubFetch, submitCallCount: () => number, submittedReviews: () => readonly GitHubReviewPayload[], deletedLabelUrls: () => readonly string[] } {
	let submitIndex = 0
	const reviewBodies: GitHubReviewPayload[] = []
	const deleteUrls: string[] = []

	const handlePullRequest = (init: RequestInit): Response => {
		const headers = new Headers(init.headers)
		const isDiffRequest = headers.get("Accept") === "application/vnd.github.diff"
		if (options.diffError && isDiffRequest) throw options.diffError
		if (isDiffRequest) return new Response(options.diffText ?? "", { status: 200 })
		const labels = (options.labelNames ?? []).map(name => ({ name }))
		return new Response(JSON.stringify({ base: { sha: options.baseCommit ?? BASE_COMMIT_SHA }, labels }), { status: 200 })
	}

	const handleReviews = (init: RequestInit): Response => {
		submitIndex++
		if (options.submitResponses) {
			const response = options.submitResponses[Math.min(submitIndex - 1, options.submitResponses.length - 1)]!
			if (response.status === 200 && typeof init.body === "string") {
				reviewBodies.push(JSON.parse(init.body))
			}
			return new Response(response.body ?? null, { status: response.status })
		}
		if (options.submitStatus !== undefined && options.submitStatus !== 200) {
			return new Response("Error", { status: options.submitStatus, statusText: "Error" })
		}
		if (typeof init.body === "string") {
			reviewBodies.push(JSON.parse(init.body))
		}
		return new Response(null, { status: 200 })
	}

	const handleDeleteLabel = (url: string): Response => {
		deleteUrls.push(url)
		if (options.deleteLabelStatus !== undefined && options.deleteLabelStatus !== 200) return new Response("Error", { status: options.deleteLabelStatus, statusText: "Error" })
		return new Response(null, { status: 200 })
	}

	const githubFetch: GitHubFetch = async (url, init) => {
		const method = init.method ?? "GET"
		if (method === "POST" && /\/reviews/.test(url)) return handleReviews(init)
		if (method === "DELETE" && /\/labels\//.test(url)) return handleDeleteLabel(url)
		if (url.includes("/pulls/")) return handlePullRequest(init)
		throw new Error(`Unexpected githubFetch call: ${method} ${url}`)
	}

	return { githubFetch, submitCallCount: () => submitIndex, submittedReviews: () => reviewBodies, deletedLabelUrls: () => deleteUrls }
}

const SAMPLE_DIFF = [
	"diff --git a/src/file.ts b/src/file.ts",
	"--- a/src/file.ts",
	"+++ b/src/file.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
].join("\n")

// source/github.mts owns the endpoint spelling and the percent-encoding, and tests/github.test.mts covers both, so these tests only prove which label the orchestration deletes.
function deletedLabelNames(urls: readonly string[]): string[] {
	return urls.map(url => {
		const labelSegment = new URL(url).pathname.split("/").at(-1)
		if (labelSegment === undefined) throw new Error(`DELETE request URL carries no label segment: ${url}`)
		return decodeURIComponent(labelSegment)
	})
}

describe("runOnPullRequest", () => {
	it("returns early when no files changed", async () => {
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: "" })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([], shippedBuiltinAgents),
				githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		expect(submittedReviews()).toHaveLength(0)
	})

	it("submits review after analysis", async () => {
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch,
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.event).toBe("COMMENT")
		expect(submittedReviews()[0]!.body).toContain("Great work")
		expect(submittedReviews()[0]!.body).toContain("Reviewers: All 1 reviewer ran.")
	})

	it("reports a full review of the built-in Default when the repository ships no prompt", async () => {
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([], shippedBuiltinAgents),
				githubFetch,
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		// A repository without .ci-agents resolves the built-in Default alone, so an automatic run on an opened pull request is a full review of one reviewer and its total cannot fall below that count.
		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.body).toContain("Reviewers: All 1 reviewer ran.")
		expect(submittedReviews()[0]!.body).not.toContain("**")
		expect(submittedReviews()[0]!.body).not.toContain("> ")
	})

	it("warns when the configured AGENTS names only some of the reviewers", async () => {
		const userAgents: Agent[] = [
			{ name: "Bug Hunter", prompt: "Bug hunter prompt." },
			{ name: "Security", prompt: "Security prompt." },
			{ name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." },
		]
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents(userAgents),
				githubFetch,
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration({ agents: ["Security"] }),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		const partialNotice = "⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: `Security`. This is not a full review.**"
		expect(submittedReviews()[0]!.body.split(partialNotice)).toHaveLength(3)
	})

	it("reports a full review when AGENTS names every selectable reviewer, including the built-in Default", async () => {
		const builtinAgents: Agent[] = [{ name: "Default", prompt: "Builtin default prompt." }]
		const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([{ name: "Security", prompt: "Security prompt." }, { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }], builtinAgents),
				githubFetch,
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration({ agents: ["Security", "Default"] }),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		// AGENTS can name the built-in Default too, so a selection that names every selectable reviewer left nobody out and must not report more reviewers than the run had.
		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.body).toContain("Reviewers: All 2 reviewers ran.")
		expect(submittedReviews()[0]!.body).not.toContain("**")
	})

	it("removes no label, even when the trigger label is on the pull request", async () => {
		const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL] })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch,
				fetch: makeFetch("Great work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		// Pull-request mode needs only pull-requests: write, so a label removal through the issues endpoint would be a permission it does not ask for.
		expect(deletedLabelUrls()).toEqual([])
		expect(submitCallCount()).toBe(1)
	})

	it("runs every agent and removes no label when an automatic run carries selector labels", async () => {
		const capturedBodies: string[] = []
		const userAgents: Agent[] = [
			{ name: "Bug Hunter", prompt: "Bug hunter prompt." },
			{ name: "Security", prompt: "Security prompt." },
			{ name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." },
		]
		// An opened run carries no trigger label, so a stale `Reviewer - All` or `Reviewer - Aggregator` label must not be read and no label may be removed.
		const { githubFetch, deletedLabelUrls, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - All", "Reviewer - Aggregator", "Reviewer - Bug Hunter"] })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents(userAgents),
				githubFetch,
				fetch: makeFetch("Great work", capturedBodies),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		// The automatic run selects every user agent, so the labels neither narrow the selection nor fail it.
		const agentNames = requestedAgentNames(capturedBodies, userAgents).filter(name => name !== AGGREGATOR_AGENT_NAME)
		expect(agentNames.sort()).toEqual(["Bug Hunter", "Security"])
		expect(capturedBodies).toHaveLength(3)
		expect(submittedReviews()).toHaveLength(1)
		expect(deletedLabelUrls()).toEqual([])
	})

	it("forwards the configured max tokens to the request bodies", async () => {
		const capturedBodies: string[] = []
		const { githubFetch } = makeGithubFetch({ diffText: SAMPLE_DIFF })

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch,
				fetch: makeFetch("Great work", capturedBodies),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			250_000,
			IDENTITY_PROFILE,
		)

		expect(capturedBodies).toHaveLength(2)
		expect(JSON.parse(capturedBodies[0]!).max_tokens).toBe(250_000)
		expect(JSON.parse(capturedBodies[1]!).max_tokens).toBe(250_000)
	})

	it("propagates error when fetchPullRequestDiff throws", async () => {
		await expect(runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([], shippedBuiltinAgents),
				githubFetch: makeGithubFetch({ diffError: new Error("API error") }).githubFetch,
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)).rejects.toThrow("API error")
	})

	it("propagates a non-422 submit failure as a single-line message", async () => {
		// main prints this message, so the response body must not be able to start a line of its own.
		await expect(runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch: makeGithubFetch({ diffText: SAMPLE_DIFF, submitResponses: [{ status: 500, body: "rate limited\nFORGED LOG LINE" }] }).githubFetch,
				fetch: makeFetch("Good work"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)).rejects.toThrow(/^Failed to submit review: 500 rate limited\\u000aFORGED LOG LINE$/)
	})

	it("retries submit when GitHub returns 422 and accepts the corrected output", async () => {
		const capturedBodies: string[] = []
		let fetchCount = 0
		const fetch: Fetch = async (_signal, body, _headers) => {
			capturedBodies.push(body)
			fetchCount++
			const content = fetchCount === 1
				? JSON.stringify({ body: "Agent result", comments: [] })
				: (fetchCount === 2
					? JSON.stringify({ body: "First try", comments: [{ path: "src/file.ts", line: 999, side: "RIGHT", body: "wrong line" }] })
					: JSON.stringify({ body: "Second try", comments: [{ path: "src/file.ts", line: 1, side: "RIGHT", body: "correct line" }] }))
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(buildContentSse(content)))
					controller.close()
				}
			})
			return new Response(stream, { status: 200 })
		}

		const { githubFetch, submitCallCount, submittedReviews } = makeGithubFetch({
			diffText: SAMPLE_DIFF,
			submitResponses: [
				{ status: 422, body: JSON.stringify({ message: "Unprocessable Entity", errors: ["Line could not be resolved"] }) },
				{ status: 200 },
			],
		})

		await runOnPullRequest(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch,
				fetch,
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makePullRequestConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			IDENTITY_PROFILE,
		)

		expect(submitCallCount()).toBe(2)
		expect(submittedReviews()).toHaveLength(1)
		expect(submittedReviews()[0]!.body).toContain("Second try")
		expect(submittedReviews()[0]!.comments).toHaveLength(1)
		expect(submittedReviews()[0]!.comments[0]!.line).toBe(1)
		// The retried body is built from the corrected aggregator output alone, so the reviewer notice appears once rather than accumulating per attempt.
		expect(submittedReviews()[0]!.body.split("Reviewers: All 1 reviewer ran.")).toHaveLength(2)

		const thirdAggregatorRequest = JSON.parse(capturedBodies[2]!)
		const lastUserMessage = thirdAggregatorRequest.messages.at(-1)
		expect(lastUserMessage.role).toBe("user")
		expect(lastUserMessage.content).toContain("Your previous output failed on submission to GitHub:\nHTTP Status: 422\n{\"message\":\"Unprocessable Entity\",\"errors\":[\"Line could not be resolved\"]}")
		expect(lastUserMessage.content).toContain("Line could not be resolved")
	})

	it("does not retry on 401/403/404/429 submit errors", async () => {
		for (const status of [401, 403, 404, 429]) {
			const { githubFetch, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, submitStatus: status })

			await expect(runOnPullRequest(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makePullRequestConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow()

			expect(submitCallCount()).toBe(1)
		}
	})
})

describe("runOnLabelTrigger", () => {
	const namedAgents: Agent[] = [
		{ name: "Bug Hunter", prompt: "Bug hunter prompt." },
		{ name: "Security", prompt: "Security prompt." },
		{ name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." },
	]
	const builtinOnlyAgents: Agent[] = [
		{ name: "Default", prompt: "Builtin default prompt." },
	]

	describe("label removal", () => {
		it("removes the trigger label before running any agent", async () => {
			const { githubFetch, deletedLabelUrls, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL] })
			const respond = makeFetch("Good work")
			const deletedLabelSnapshots: (readonly string[])[] = []
			// Snapshot what has already been deleted at the moment each model request is made.
			const fetch: Fetch = async (signal, body, headers) => {
				deletedLabelSnapshots.push([...deletedLabelUrls()])
				return respond(signal, body, headers)
			}

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
					githubFetch,
					fetch,
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL])
			// Every model request must see the trigger label already gone, and how many requests a run makes is not part of the label lifecycle.
			expect(deletedLabelSnapshots.length).toBeGreaterThan(0)
			for (const snapshot of deletedLabelSnapshots) expect(deletedLabelNames(snapshot)).toEqual([REVIEW_START_LABEL])
			expect(submittedReviews()).toHaveLength(1)
		})

		it("removes the trigger label and every selector label before running any agent", async () => {
			const { githubFetch, deletedLabelUrls, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Security", "Reviewer - Bug Hunter"] })
			const respond = makeFetch("Good work")
			const deletedLabelSnapshots: (readonly string[])[] = []
			const fetch: Fetch = async (signal, body, headers) => {
				deletedLabelSnapshots.push([...deletedLabelUrls()])
				return respond(signal, body, headers)
			}

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch,
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// The trigger label goes first and the selector labels follow in the order the pull request lists them.
			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL, "Reviewer - Security", "Reviewer - Bug Hunter"])
			expect(deletedLabelSnapshots.length).toBeGreaterThan(0)
			for (const snapshot of deletedLabelSnapshots) expect(deletedLabelNames(snapshot)).toEqual([REVIEW_START_LABEL, "Reviewer - Security", "Reviewer - Bug Hunter"])
			expect(submittedReviews()).toHaveLength(1)
		})

		it("logs every label it removes on one line", async () => {
			// A label name can carry an invisible character that the DELETE encoding passes through, so the log line escapes it like every other untrusted name.
			const hostileReviewerName = "Bug\u202eHunter"
			const labelNames = [REVIEW_START_LABEL, "Reviewer - Security", `Reviewer - ${hostileReviewerName}`]
			const userAgents: Agent[] = [
				{ name: "Security", prompt: "Security prompt." },
				{ name: hostileReviewerName, prompt: "Hostile prompt." },
				{ name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." },
			]
			const { githubFetch, deletedLabelUrls } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames })
			const logLines: string[] = []
			const logger: Logger = { log: (...data: unknown[]) => logLines.push(data.map(String).join(" ")) }

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(userAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL, "Reviewer - Security", `Reviewer - ${hostileReviewerName}`])
			expect(logLines.filter(line => line.startsWith("Removed label"))).toEqual([
				`Removed label "${REVIEW_START_LABEL}"`,
				"Removed label \"Reviewer - Security\"",
				"Removed label \"Reviewer - Bug\\u202eHunter\"",
			])
		})
	})

	describe("agent selection", () => {
		it("runs only the agent named by a selector label", async () => {
			const capturedBodies: string[] = []
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Security"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work", capturedBodies),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			expect(capturedBodies).toHaveLength(2)
			expect(capturedBodies[0]!).toContain("Security prompt.")
			expect(capturedBodies[0]!).not.toContain("Bug hunter prompt.")
			expect(submittedReviews()).toHaveLength(1)

			// A subset review carries the warning twice, once where a reader starts and once where a long review ends.
			const partialNotice = "⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: `Security`. This is not a full review.**"
			expect(submittedReviews()[0]!.body.split(partialNotice)).toHaveLength(3)
			expect(submittedReviews()[0]!.body.endsWith(partialNotice)).toBe(true)
		})

		it("runs every user agent when only the trigger label is present", async () => {
			const capturedBodies: string[] = []
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work", capturedBodies),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// Agents run concurrently, so the request order is a scheduling detail; the set of agents that produced a request is not.
			const agentNames = requestedAgentNames(capturedBodies, namedAgents).filter(name => name !== AGGREGATOR_AGENT_NAME)
			expect(agentNames.sort()).toEqual(["Bug Hunter", "Security"])
			expect(capturedBodies).toHaveLength(3)
			expect(submittedReviews()).toHaveLength(1)
			expect(submittedReviews()[0]!.body).toContain("Reviewers: All 2 reviewers ran.")
			expect(submittedReviews()[0]!.body).not.toContain("**")
		})

		it("reports a full review of the built-in Default when the repository ships no prompt", async () => {
			const capturedBodies: string[] = []
			const { githubFetch, deletedLabelUrls, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents([], shippedBuiltinAgents),
					githubFetch,
					fetch: makeFetch("Good work", capturedBodies),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// No selector label is applied, so the run keeps the all-reviewer selection, and with no .ci-agents directory that selection is the built-in Default alone: a full review of one reviewer rather than a warning whose total is smaller than the run.
			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL])
			expect(capturedBodies).toHaveLength(2)
			expect(submittedReviews()).toHaveLength(1)
			expect(submittedReviews()[0]!.body).toContain("Reviewers: All 1 reviewer ran.")
			expect(submittedReviews()[0]!.body).not.toContain("**")
			expect(submittedReviews()[0]!.body).not.toContain("> ")
		})

		it("reports a full review when every selector label is applied explicitly", async () => {
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Bug Hunter", "Reviewer - Security"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// Naming every reviewer one label at a time is the same set a run with no selectors uses, so the review must not read as a subset.
			expect(submittedReviews()).toHaveLength(1)
			expect(submittedReviews()[0]!.body).toContain("Reviewers: All 2 reviewers ran.")
			expect(submittedReviews()[0]!.body).not.toContain("**")
		})

		it("reads a selector for every repository prompt as a full review beside the shipped built-in agents", async () => {
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Bug Hunter", "Reviewer - Security"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents, shippedBuiltinAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// The shipped built-in Default is selectable but opt-in, so a run that labels every prompt of its own reviews exactly the reviewers a bare run uses and must not read as narrowed.
			expect(submittedReviews()).toHaveLength(1)
			expect(submittedReviews()[0]!.body).toContain("Reviewers: All 2 reviewers ran.")
			expect(submittedReviews()[0]!.body).not.toContain("**")
		})

		it("reports a full review when the labels name every selectable reviewer, including the built-in Default", async () => {
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Bug Hunter", "Reviewer - Security", "Reviewer - Default"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents, builtinOnlyAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// A selector label can name the built-in Default too, so this run left nobody out and a subset warning here would carry a total smaller than the selection.
			expect(submittedReviews()).toHaveLength(1)
			expect(submittedReviews()[0]!.body).toContain("Reviewers: All 3 reviewers ran.")
			expect(submittedReviews()[0]!.body).not.toContain("**")
		})

		it("reports a total above its count when a selection adds the built-in Default but leaves a repository prompt out", async () => {
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Security", "Reviewer - Default"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents, builtinOnlyAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// `namedAgents` holds Bug Hunter and Security, so this run left Bug Hunter out while adding the built-in Default: the count follows the two reviewers that ran, and the total also counts the reviewer no bare run uses.
			expect(submittedReviews()).toHaveLength(1)
			expect(submittedReviews()[0]!.body).toContain("⚠️ **PARTIAL REVIEW — 2 of 3 reviewers ran: `Security`, `Default`. This is not a full review.**")
			expect(submittedReviews()[0]!.body).not.toContain("Reviewers: All ")
		})

		it("ignores a label that does not look like a selector and runs every user agent", async () => {
			const capturedBodies: string[] = []
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "documentation"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work", capturedBodies),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			// An unrelated label is neither a selector nor a near miss, so the run keeps the automatic all-agent selection.
			const agentNames = requestedAgentNames(capturedBodies, namedAgents).filter(name => name !== AGGREGATOR_AGENT_NAME)
			expect(agentNames.sort()).toEqual(["Bug Hunter", "Security"])
			expect(submittedReviews()).toHaveLength(1)
		})

		it("selects an agent that only exists in the builtin agents directory", async () => {
			const capturedBodies: string[] = []
			const { githubFetch, submittedReviews } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Default"] })

			await runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents, builtinOnlyAgents),
					githubFetch,
					fetch: makeFetch("Good work", capturedBodies),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)

			expect(capturedBodies).toHaveLength(2)
			expect(capturedBodies[0]!).toContain("Builtin default prompt.")
			expect(submittedReviews()).toHaveLength(1)
			// The run reviewed with a reviewer no bare run of this repository would use, so the total counts that reviewer beside the two reference reviewers it left out.
			expect(submittedReviews()[0]!.body).toContain("⚠️ **PARTIAL REVIEW — 1 of 3 reviewers ran: `Default`. This is not a full review.**")
		})
	})

	describe("failures", () => {
		it("rejects when the trigger label is not on the pull request and removes nothing", async () => {
			const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: ["Reviewer - Security"] })

			await expect(runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow(`Invalid PR labels: "${REVIEW_START_LABEL}" is missing from pull request #42`)

			expect(deletedLabelUrls()).toHaveLength(0)
			expect(submitCallCount()).toBe(0)
		})

		it("fails the run when a label removal fails and submits nothing", async () => {
			const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Security"], deleteLabelStatus: 403 })

			await expect(runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow(`Failed to remove label "${REVIEW_START_LABEL}": 403 Error`)

			// A failed removal stops the run at that label, so no agent runs and the labels it had not reached yet stay on the pull request.
			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL])
			expect(submitCallCount()).toBe(0)
		})

		it("rejects an unknown selector after removing the trigger label and that selector label", async () => {
			const capturedBodies: string[] = []
			const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Nope"] })

			await expect(runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work", capturedBodies),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow(`Invalid selector label "Reviewer - Nope": it names no available agent, and a label's agent name is matched case-sensitively. Available agents: Bug Hunter, Security.`)

			// Removal runs before validation, so the label that failed the run is gone and the run is retryable by adding the trigger label back.
			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL, "Reviewer - Nope"])
			expect(capturedBodies).toHaveLength(0)
			expect(submitCallCount()).toBe(0)
		})

		it("rejects an aggregator selector after removing the trigger label and that selector label", async () => {
			const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Aggregator"] })

			await expect(runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow(`"Reviewer - Aggregator" is a configuration error`)

			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL, "Reviewer - Aggregator"])
			expect(submitCallCount()).toBe(0)
		})

		it("rejects a leftover Reviewer - All label after removing every label that carries the selector prefix", async () => {
			const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - All", "Reviewer - Security"] })

			await expect(runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(namedAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow(`Invalid selector label "Reviewer - All": it names no available agent`)

			// The label that fails the run is removed with the rest, so a leftover costs one failed run rather than a manual cleanup.
			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL, "Reviewer - All", "Reviewer - Security"])
			expect(submitCallCount()).toBe(0)
		})

		it("rejects case-colliding prompt files after removing the trigger label and the selector label", async () => {
			const collidingAgents: Agent[] = [
				{ name: "Security", prompt: "Security prompt." },
				{ name: "security", prompt: "Lowercase prompt." },
				{ name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." },
			]
			const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, "Reviewer - Security"] })

			await expect(runOnLabelTrigger(
				{
					spawnGit: makeSpawnGitOk(),
					readAgents: makeReadAgents(collidingAgents),
					githubFetch,
					fetch: makeFetch("Good work"),
					logger: silentLogger,
					debugWriter: noopDebugWriter,
					sleep: instantSleep,
					random: fixedRandom,
				},
				makeLabelTriggerConfiguration(),
				userAgentsDirectory,
				builtinAgentsDirectory,
				"test-model",
				100_000,
				IDENTITY_PROFILE,
			)).rejects.toThrow('Duplicate agent prompt file names: "Security" and "security"')

			// The selector label matches one of the two files case-sensitively, so the run must fail rather than review with one prompt and call that a full review.
			// The labels are gone either way, so the run is retryable by adding the trigger label back once the prompt directory is fixed.
			expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL, "Reviewer - Security"])
			expect(submitCallCount()).toBe(0)
		})

		it("rejects a near-miss selector label after removing the trigger label and leaves that label in place", async () => {
			for (const nearMissLabelName of ["reviewer - Security", "Reviewers - Security", "Reviewer- Security"]) {
				const { githubFetch, deletedLabelUrls, submitCallCount } = makeGithubFetch({ diffText: SAMPLE_DIFF, labelNames: [REVIEW_START_LABEL, nearMissLabelName] })

				await expect(runOnLabelTrigger(
					{
						spawnGit: makeSpawnGitOk(),
						readAgents: makeReadAgents(namedAgents),
						githubFetch,
						fetch: makeFetch("Good work"),
						logger: silentLogger,
						debugWriter: noopDebugWriter,
						sleep: instantSleep,
						random: fixedRandom,
					},
					makeLabelTriggerConfiguration(),
					userAgentsDirectory,
					builtinAgentsDirectory,
					"test-model",
					100_000,
					IDENTITY_PROFILE,
				)).rejects.toThrow(`Invalid selector label "${nearMissLabelName}": a selector label must be spelled "Reviewer - <Name>"`)

				// Removal keys on the exact prefix, so a near miss survives and fails every run it is present on until someone corrects it.
				expect(deletedLabelNames(deletedLabelUrls())).toEqual([REVIEW_START_LABEL])
				expect(submitCallCount()).toBe(0)
			}
		})
	})
})

describe("runOnLocalDiff", () => {
	it("returns early when no files changed", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitOk(),
				readAgents: makeReadAgents([]),
				githubFetch: async () => new Response(),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(result).toBe("No files changed, nothing to review")
	})

	it("formats review to console", async () => {
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch: async () => new Response(),
				fetch: makeFetch("Looks good"),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(result).toContain("Looks good")
	})

	it("forwards the configured max tokens to the request bodies", async () => {
		const capturedBodies: string[] = []
		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch: async () => new Response(),
				fetch: makeFetch("Looks good", capturedBodies),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			250_000,
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(capturedBodies).toHaveLength(2)
		expect(result).toContain("Looks good")
		expect(JSON.parse(capturedBodies[0]!).max_tokens).toBe(250_000)
		expect(JSON.parse(capturedBodies[1]!).max_tokens).toBe(250_000)
	})

	it("propagates error when validateGitRepository throws", async () => {
		const spawnGit: SpawnGit = async (params) => {
			if (params[0] === "rev-parse") return { stdout: "", stderr: "fatal: not a git repository", exitCode: 1, signalCode: null }
			if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null }
			return { stdout: "", stderr: "", exitCode: 0, signalCode: null }
		}

		await expect(runOnLocalDiff(
			{
				spawnGit,
				readAgents: makeReadAgents([]),
				githubFetch: async () => new Response(),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			"/test/workspace",
			IDENTITY_PROFILE,
		)).rejects.toThrow("No git repository found")
	})

	it("propagates error when generateLocalDiff throws", async () => {
		const spawnGit: SpawnGit = async (params) => {
			if (params[0] === "diff") return { stdout: "", stderr: "diff failed", exitCode: 1, signalCode: null }
			if (params[0] === "cat-file" && params[1] === "-t") return { stdout: "commit", stderr: "", exitCode: 0, signalCode: null }
			return { stdout: "", stderr: "", exitCode: 0, signalCode: null }
		}

		await expect(runOnLocalDiff(
			{
				spawnGit,
				readAgents: makeReadAgents([]),
				githubFetch: async () => new Response(),
				fetch: makeFetch(""),
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			"/test/workspace",
			IDENTITY_PROFILE,
		)).rejects.toThrow("Failed to get diff")
	})

	it("feeds back the parse error and accepts the corrected output in local-diff mode", async () => {
		let callCount = 0
		const fetch: Fetch = async (_signal, _body, _headers) => {
			callCount++
			const content = callCount === 1
				? JSON.stringify({ body: "Agent result", comments: [] })
				: (callCount === 2
					? "not json"
					: JSON.stringify({ body: "Looks good", comments: [] }))
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(buildContentSse(content)))
					controller.close()
				}
			})
			return new Response(stream, { status: 200 })
		}

		const result = await runOnLocalDiff(
			{
				spawnGit: makeSpawnGitWithDiff(SAMPLE_DIFF),
				readAgents: makeReadAgents([makeAgent(), { name: AGGREGATOR_AGENT_NAME, prompt: "Aggregate." }]),
				githubFetch: async () => new Response(),
				fetch,
				logger: silentLogger,
				debugWriter: noopDebugWriter,
				sleep: instantSleep,
				random: fixedRandom,
			},
			makeLocalDiffConfiguration(),
			userAgentsDirectory,
			builtinAgentsDirectory,
			"test-model",
			100_000,
			"/test/workspace",
			IDENTITY_PROFILE,
		)

		expect(callCount).toBe(3)
		expect(result).toContain("Looks good")
	})
})
