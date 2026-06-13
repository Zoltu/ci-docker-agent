import type { GitHubConfiguration, GitHubReviewPayload } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import { guard, isArrayOf, isInteger, isString } from "./typescript-helpers.mts"

const REQUEST_TIMEOUT_MILLISECONDS = 10_000
const RETRY_DELAY_MILLISECONDS = 30_000
const DEADLINE_MILLISECONDS = 300_000

export type GitHubFetch = (url: string, options: RequestInit) => Promise<Response>

function buildRepoUrl(configuration: GitHubConfiguration, pathSegments: readonly string[], query?: Readonly<Record<string, string>>): string {
	const { apiUrl, owner, repositoryName } = configuration
	let url = `${apiUrl}/repos/${owner}/${repositoryName}/${pathSegments.join("/")}`
	if (query) {
		const queryString = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")
		url += `?${queryString}`
	}
	return url
}

export function createGithubFetch(logger: Logger): GitHubFetch {
	return async function githubFetch(url: string, options: RequestInit): Promise<Response> {
		// Retries rate limiting (429) and request timeouts; everything else fails fast.
		const deadline = Date.now() + DEADLINE_MILLISECONDS

		while (true) {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MILLISECONDS)

			try {
				const response = await fetch(url, { ...options, signal: controller.signal })
				clearTimeout(timeoutId)

				if (response.status === 429) {
					if (Date.now() >= deadline) {
						throw new Error(`GitHub API request exceeded ${DEADLINE_MILLISECONDS / 1000}s deadline`)
					}

					const retryAfter = response.headers.get("Retry-After")
					if (retryAfter !== null) {
						const seconds = Number.parseInt(retryAfter, 10)
						if (!Number.isFinite(seconds) || seconds < 0) {
							throw new Error(`GitHub API returned a non-numeric Retry-After header: ${JSON.stringify(retryAfter)}`)
						}
						const milliseconds = seconds * 1000
						logger.log(`Rate limited (429), retrying in ${seconds}s`)
						await new Promise(resolve => setTimeout(resolve, milliseconds))
					} else {
						logger.log(`Rate limited (429), retrying in ${RETRY_DELAY_MILLISECONDS / 1000}s`)
						await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MILLISECONDS))
					}
					continue
				}

				return response
			} catch (error) {
				clearTimeout(timeoutId)

				if (!controller.signal.aborted) throw error

				if (Date.now() >= deadline) {
					throw new Error(`GitHub API request exceeded ${DEADLINE_MILLISECONDS / 1000}s deadline`)
				}

				logger.log(`Request timed out after ${REQUEST_TIMEOUT_MILLISECONDS / 1000}s, retrying in ${RETRY_DELAY_MILLISECONDS / 1000}s`)

				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MILLISECONDS))
			}
		}
	}
}

export async function fetchPullRequestDiff(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration): Promise<string> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["pulls", String(configuration.pullRequestNumber)])

	const response = await dependencies.githubFetch(url, {
		method: "GET",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.diff" },
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
	}

	return response.text()
}

export type SubmitReviewResult = { ok: true } | { ok: false, status: number, body: string }
export async function submitReview(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration, review: GitHubReviewPayload): Promise<SubmitReviewResult> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["pulls", String(configuration.pullRequestNumber), "reviews"])

	const response = await dependencies.githubFetch(url, {
		method: "POST",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify(review),
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		return { ok: false, status: response.status, body }
	}
	return { ok: true }
}

const isPrRef = guard({ sha: isString })
const isValidPrMetadata = guard({
	base: isPrRef,
	head: isPrRef,
})

async function fetchPrShaField(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration, field: "base" | "head"): Promise<string> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["pulls", String(configuration.pullRequestNumber)])

	const response = await dependencies.githubFetch(url, {
		method: "GET",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to fetch PR ${field} commit: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
	}

	const data: unknown = await response.json()
	if (!isValidPrMetadata(data)) throw new Error(`Invalid PR response: missing ${field}.sha`)
	return data[field].sha
}

export async function fetchPullRequestBaseCommit(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration): Promise<string> {
	return fetchPrShaField(dependencies, configuration, "base")
}

export async function fetchPullRequestHeadSha(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration): Promise<string> {
	return fetchPrShaField(dependencies, configuration, "head")
}

export interface CheckRunOutput {
	title: string
	summary: string
	text?: string
}

const isValidCheckRunResponse = guard({ id: isInteger })
const isCheckRunSummary = guard({ id: isInteger, name: isString, status: isString })
const isValidCheckRunsList = guard({ check_runs: isArrayOf(isCheckRunSummary) })

export async function findActiveCheckRunByName(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration, headSha: string, name: string): Promise<number | null> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["commits", headSha, "check-runs"], { check_name: name })

	const response = await dependencies.githubFetch(url, {
		method: "GET",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
	})

	if (!response.ok) return null

	const data: unknown = await response.json()
	if (!isValidCheckRunsList(data)) return null

	const active = data.check_runs.find(run => run.name === name && run.status === "in_progress")
	return active?.id ?? null
}

export async function createCheckRun(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration, headSha: string, name: string, output: CheckRunOutput): Promise<number> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["check-runs"])

	const response = await dependencies.githubFetch(url, {
		method: "POST",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify({ name, head_sha: headSha, status: "in_progress", output }),
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to create check run: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
	}

	const data: unknown = await response.json()
	if (!isValidCheckRunResponse(data)) throw new Error("Invalid check run response: missing id")

	return data.id
}

export async function updateCheckRun(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration, checkRunId: number, conclusion: "success" | "failure" | "cancelled", output: CheckRunOutput): Promise<void> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["check-runs", String(checkRunId)])

	const response = await dependencies.githubFetch(url, {
		method: "PATCH",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify({ status: "completed", conclusion, output }),
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to update check run: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`)
	}
}
