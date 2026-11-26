import type { GitHubConfiguration, GitHubReviewPayload } from "./github-types.mts"
import type { Logger } from "./logger.mts"
import { guard, isArrayOf, isRecord, isString, normalizeFetchError, sanitizeForSingleLine } from "./typescript-helpers.mts"

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
				const response = await normalizeFetchError(fetch(url, { ...options, signal: controller.signal }))
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
		throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}${body ? `\n${sanitizeForSingleLine(body)}` : ""}`)
	}

	return response.text()
}

// A non-2xx from submitReview is aggregator feedback the caller acts on (a 422 becomes a retry instruction), so it is returned as data.
// Every other non-2xx in this module throws, because the caller has no alternative but to fail the run.
// The body stays byte-exact because the aggregator reads it as data, so this is the one response body in the module that is not sanitized.
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

export interface PullRequestMetadata {
	baseSha: string
	labelNames: readonly string[]
}

// GitHub reports commit object names as hex, and base.sha reaches git as an argument, so a value of any other shape is rejected here.
const COMMIT_OBJECT_NAME_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

const isPullRequestBase = guard({ sha: isString })
const isPullRequestLabels = isArrayOf(guard({ name: isString }))

// Each message names the wire field the response got wrong, so a diagnosis points at the payload GitHub returned rather than at the domain fields derived from it.
function parsePullRequestResponse(data: unknown): PullRequestMetadata {
	if (!isRecord(data)) throw new Error("Invalid PR response: the body is not a JSON object")
	if (!isPullRequestBase(data.base)) throw new Error("Invalid PR response: missing base.sha")
	if (!isPullRequestLabels(data.labels)) throw new Error("Invalid PR response: missing labels[].name")
	if (!COMMIT_OBJECT_NAME_PATTERN.test(data.base.sha)) throw new Error(`Invalid PR response: base.sha must be a 40 or 64 character hex commit object name, got: ${sanitizeForSingleLine(JSON.stringify(data.base.sha))}`)

	return { baseSha: data.base.sha, labelNames: data.labels.map(label => label.name) }
}

export async function fetchPullRequestMetadata(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration): Promise<PullRequestMetadata> {
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["pulls", String(configuration.pullRequestNumber)])

	const response = await dependencies.githubFetch(url, {
		method: "GET",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to fetch PR metadata: ${response.status} ${response.statusText}${body ? `\n${sanitizeForSingleLine(body)}` : ""}`)
	}

	const data: unknown = await response.json()
	return parsePullRequestResponse(data)
}

// A URL parser resolves a bare dot segment out of a path and treats a backslash as a separator, so either one moves the DELETE off the label URL and onto a different endpoint.
const LABEL_NAME_SEPARATOR_OR_CONTROL_CHARACTER_PATTERN = /[/\\\u0000-\u001F\u007F-\u009F]/

function assertLabelNameTargetsOnePathSegment(labelName: string): void {
	const reflectedLabelName = sanitizeForSingleLine(JSON.stringify(labelName))
	if (labelName.trim().length === 0) throw new Error(`Label name must not be empty or whitespace only, got: ${reflectedLabelName}`)
	if (labelName === "." || labelName === "..") throw new Error(`Label name must not be a dot segment, got: ${reflectedLabelName}`)
	if (LABEL_NAME_SEPARATOR_OR_CONTROL_CHARACTER_PATTERN.test(labelName)) throw new Error(`Label name must not contain a path separator or a control character, got: ${reflectedLabelName}`)
}

export async function removePullRequestLabel(dependencies: { githubFetch: GitHubFetch }, configuration: GitHubConfiguration, labelName: string): Promise<void> {
	assertLabelNameTargetsOnePathSegment(labelName)
	// `pull-requests: write` suffices for this DELETE by GitHub's documented either-scope rule, and no test verifies that.
	// The caller must have verified the label is on the pull request, so a 404 here is a real failure rather than a no-op.
	const { token } = configuration
	const url = buildRepoUrl(configuration, ["issues", String(configuration.pullRequestNumber), "labels", encodeURIComponent(labelName)])

	const response = await dependencies.githubFetch(url, {
		method: "DELETE",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
	})

	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`Failed to remove label "${sanitizeForSingleLine(labelName)}": ${response.status} ${response.statusText}${body ? `\n${sanitizeForSingleLine(body)}` : ""}`)
	}
}
