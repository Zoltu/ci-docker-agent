import type { AgentNames } from "./agents.mts"
import type { GitHubConfiguration } from "./github-types.mts"
import { REVIEW_START_LABEL } from "./labels.mts"
import type { TryResult } from "./typescript-helpers.mts"
import { parseCommaSeparatedList, sanitizeForSingleLine } from "./typescript-helpers.mts"

// The trigger label the run deletes from the pull request is the value the label-trigger parser compared against the workflow gate.
// The type records the value that parsing validated; the isTriggerLabel guard, not the type, is what enforces the comparison, so a value of this type carries the fact that it is exactly REVIEW_START_LABEL rather than merely some string.
export type TriggerLabel = typeof REVIEW_START_LABEL

export interface LabelTriggerConfiguration {
	type: "label-trigger"
	triggerLabel: TriggerLabel
	github: GitHubConfiguration
}

export interface PullRequestConfiguration {
	type: "pull-request"
	agents: AgentNames
	github: GitHubConfiguration
}

export interface LocalDiffConfiguration {
	type: "local-diff"
	agents: AgentNames
	baseCommit: string
	headCommit: string
}

export type Configuration = LabelTriggerConfiguration | PullRequestConfiguration | LocalDiffConfiguration

function isTriggerLabel(value: string): value is TriggerLabel {
	return value === REVIEW_START_LABEL
}

// A dot segment, a path separator, whitespace, or a control character in either half would build a URL whose path resolves to a different endpoint, including the DELETE target.
// A `?`, `#`, or `%` would move the tail of the request target into a query or fragment, or decode into a separator, and GitHub's own repository names contain none of them.
const REPOSITORY_PART_HAZARD_PATTERN = /[/\\\s\u0000-\u001F\u007F-\u009F?#%]/

function isValidRepositoryPart(part: string): boolean {
	if (part === "." || part === "..") return false
	return !REPOSITORY_PART_HAZARD_PATTERN.test(part)
}

function tryParseGitHubConfiguration(environment: Record<string, string | undefined>): TryResult<GitHubConfiguration> {
	const token = environment.GITHUB_TOKEN
	const pullRequestNumberString = environment.PR_NUMBER
	const repository = environment.REPO

	if (!token || !pullRequestNumberString || !repository) {
		const missing = []
		if (!token) missing.push("GITHUB_TOKEN")
		if (!pullRequestNumberString) missing.push("PR_NUMBER")
		if (!repository) missing.push("REPO")
		return { ok: false, reason: `GitHub mode requires ${missing.join(" and ")}` }
	}

	const pullRequestNumber = Number.parseInt(pullRequestNumberString, 10)
	if (Number.isNaN(pullRequestNumber)) return { ok: false, reason: `PR_NUMBER must be a valid number, got: ${sanitizeForSingleLine(JSON.stringify(pullRequestNumberString))}` }
	if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) return { ok: false, reason: `PR_NUMBER must be a positive integer, got: ${pullRequestNumber}` }

	const parts = repository.split("/")
	if (parts.length !== 2) return { ok: false, reason: `REPO must be in format 'owner/repo', got: ${repository}` }
	const owner = parts[0]
	const repositoryName = parts[1]
	if (!owner || !repositoryName) return { ok: false, reason: `REPO must be in format 'owner/repo', got: ${repository}` }
	if (!isValidRepositoryPart(owner) || !isValidRepositoryPart(repositoryName)) return { ok: false, reason: `REPO must not contain a dot segment, path separator, whitespace, control character, query marker, fragment marker or percent character, got: ${sanitizeForSingleLine(JSON.stringify(repository))}` }

	const apiUrl = environment.GITHUB_API_URL ?? "https://api.github.com"

	return { ok: true, value: { token, apiUrl, owner, repositoryName, pullRequestNumber } }
}

function tryGetLocalDiffConfiguration(environment: Record<string, string | undefined>, agents: AgentNames): TryResult<LocalDiffConfiguration> {
	const baseCommit = environment.BASE_COMMIT
	const headCommit = environment.HEAD_COMMIT

	if (!baseCommit || !headCommit) {
		if (!baseCommit && !headCommit) return { ok: false, reason: "BASE_COMMIT and HEAD_COMMIT are not set" }
		if (!headCommit) return { ok: false, reason: "HEAD_COMMIT is required when BASE_COMMIT is provided" }
		return { ok: false, reason: "BASE_COMMIT is required when HEAD_COMMIT is provided" }
	}

	return { ok: true, value: { type: "local-diff", agents, baseCommit, headCommit } }
}

// A null value means the branch does not apply: GitHub substitutes an empty string for an unset expression, so an empty TRIGGER_LABEL means the event carried no label at all.
// Such a run is not label-triggered, so it reports no missing requirement for a variable that is normally unset.
function tryGetLabelTriggerConfiguration(environment: Record<string, string | undefined>): TryResult<LabelTriggerConfiguration | null> {
	const triggerLabel = environment.TRIGGER_LABEL
	if (!triggerLabel) return { ok: true, value: null }
	if (!isTriggerLabel(triggerLabel)) return { ok: false, reason: `TRIGGER_LABEL must be "${REVIEW_START_LABEL}", got: ${sanitizeForSingleLine(JSON.stringify(triggerLabel))}` }

	const githubResult = tryParseGitHubConfiguration(environment)
	if (!githubResult.ok) return githubResult

	return { ok: true, value: { type: "label-trigger", triggerLabel, github: githubResult.value } }
}

function tryGetPullRequestConfiguration(environment: Record<string, string | undefined>, agents: AgentNames): TryResult<PullRequestConfiguration> {
	const githubResult = tryParseGitHubConfiguration(environment)
	if (!githubResult.ok) return githubResult

	return { ok: true, value: { type: "pull-request", agents, github: githubResult.value } }
}

export function getConfiguration(environment: Record<string, string | undefined>): Configuration {
	const agents: AgentNames = environment.AGENTS ? parseCommaSeparatedList(environment.AGENTS) : "run all agents"

	const localResult = tryGetLocalDiffConfiguration(environment, agents)
	if (localResult.ok) return localResult.value

	const labelTriggerResult = tryGetLabelTriggerConfiguration(environment)
	if (labelTriggerResult.ok && labelTriggerResult.value !== null) return labelTriggerResult.value

	const pullRequestResult = tryGetPullRequestConfiguration(environment, agents)
	// A set TRIGGER_LABEL means the workflow started this run from a label event, so the run must be label-triggered: a label the gate accepted but the label-trigger branch rejects fails here instead of reviewing the pull request with every agent.
	if (pullRequestResult.ok && !environment.TRIGGER_LABEL) return pullRequestResult.value

	// Both the label-trigger and the pull-request branches reach the same GitHub configuration parser, so identical reasons are reported once.
	const failedResults = [localResult, labelTriggerResult, pullRequestResult]
		.filter((r): r is { ok: false; reason: string } => !r.ok)
	const reasons = [...new Set(failedResults.map(r => r.reason))]
	// A pull-request branch that succeeded contributes no reason of its own, so without this line the operator would never learn that GitHub mode was deliberately rejected because TRIGGER_LABEL is set.
	if (pullRequestResult.ok) reasons.push(`GitHub mode is ignored because TRIGGER_LABEL is set to ${sanitizeForSingleLine(JSON.stringify(environment.TRIGGER_LABEL))}, and a bad TRIGGER_LABEL never falls back to GitHub mode`)
	throw new Error(`No valid configuration found:\n${reasons.map(r => `- ${r}`).join("\n")}`)
}
