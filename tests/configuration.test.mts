import { describe, it, expect } from "bun:test"
import { getConfiguration, type LabelTriggerConfiguration, type PullRequestConfiguration, type LocalDiffConfiguration, type Configuration } from "../source/configuration.mts"
import { REVIEW_START_LABEL } from "../source/labels.mts"

const REPOSITORY_HAZARD_MESSAGE = "REPO must not contain a dot segment, path separator, whitespace, control character, query marker, fragment marker or percent character"

function resolveConfiguration(environment: Record<string, string | undefined>): Configuration {
	return getConfiguration(environment)
}

// A run with no arguments and a run whose TRIGGER_LABEL is empty reach the same two rejected branches, and neither contributes a reason of its own.
const NOTHING_CONFIGURED_FAILURE_MESSAGE = /^No valid configuration found:\n- BASE_COMMIT and HEAD_COMMIT are not set\n- GitHub mode requires GITHUB_TOKEN and PR_NUMBER and REPO$/

function getLocalDiffConfiguration(environment: Record<string, string | undefined> = {}): LocalDiffConfiguration {
	const configuration = resolveConfiguration({ BASE_COMMIT: "abc123", HEAD_COMMIT: "def456", ...environment })
	if (configuration.type !== "local-diff") throw new Error(`Expected local-diff, got ${configuration.type}`)
	return configuration
}

function getLabelTriggerConfiguration(environment: Record<string, string | undefined> = {}): LabelTriggerConfiguration {
	const configuration = resolveConfiguration({
		GITHUB_TOKEN: "my-token",
		PR_NUMBER: "42",
		REPO: "owner/repo",
		TRIGGER_LABEL: REVIEW_START_LABEL,
		...environment,
	})
	if (configuration.type !== "label-trigger") throw new Error(`Expected label-trigger, got ${configuration.type}`)
	return configuration
}

function getPullRequestConfiguration(environment: Record<string, string | undefined> = {}): PullRequestConfiguration {
	const configuration = resolveConfiguration({
		GITHUB_TOKEN: "my-token",
		PR_NUMBER: "42",
		REPO: "owner/repo",
		...environment,
	})
	if (configuration.type !== "pull-request") throw new Error(`Expected pull-request, got ${configuration.type}`)
	return configuration
}

describe("resolveConfiguration", () => {
	describe("local-diff configuration", () => {
		it("returns local-diff when BASE_COMMIT and HEAD_COMMIT are provided", () => {
			const configuration = getLocalDiffConfiguration()

			expect(configuration.type).toBe("local-diff")
			expect(configuration.baseCommit).toBe("abc123")
			expect(configuration.headCommit).toBe("def456")
			expect(configuration.agents).toBe("run all agents")
		})

		it("parses agents in local-diff mode", () => {
			const configuration = getLocalDiffConfiguration({ AGENTS: "SecurityAgent, StyleAgent" })

			expect(configuration.agents).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("returns 'run all agents' when AGENTS is empty string", () => {
			const configuration = getLocalDiffConfiguration({ AGENTS: "" })

			expect(configuration.agents).toBe("run all agents")
		})

		it("trims agent names", () => {
			const configuration = getLocalDiffConfiguration({ AGENTS: "  SecurityAgent  ,  StyleAgent  " })

			expect(configuration.agents).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("takes priority over github when both sets of environment vars are provided", () => {
			const configuration = resolveConfiguration({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})

			expect(configuration.type).toBe("local-diff")
		})
	})

	describe("label-trigger configuration", () => {
		it("returns label-trigger with the trigger label and GitHub fields", () => {
			const configuration = getLabelTriggerConfiguration()

			expect(configuration.type).toBe("label-trigger")
			expect(configuration.triggerLabel).toBe(REVIEW_START_LABEL)
			expect(configuration.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				owner: "owner",
				repositoryName: "repo",
				pullRequestNumber: 42,
			})
		})

		it("accepts a trigger label that differs from the review start label only in case", () => {
			const spellings = [REVIEW_START_LABEL.toLowerCase(), REVIEW_START_LABEL.toUpperCase(), "rEvIeW sTaRt"]
			for (const triggerLabel of spellings) {
				const configuration = getLabelTriggerConfiguration({ TRIGGER_LABEL: triggerLabel })

				expect(configuration.type).toBe("label-trigger")
			}
		})

		it("keeps the trigger label spelling the environment supplied", () => {
			const configuration = getLabelTriggerConfiguration({ TRIGGER_LABEL: "review start" })

			// The stored spelling names the label the run reports and removes, so a value replaced by the constant would make both of those miss a differently-cased label.
			expect(configuration.triggerLabel).toBe("review start")
		})

		it("uses custom GITHUB_API_URL when provided", () => {
			const configuration = getLabelTriggerConfiguration({ GITHUB_API_URL: "https://github.enterprise.com/api/v3" })

			expect(configuration.github.apiUrl).toBe("https://github.enterprise.com/api/v3")
		})

		it("does not carry AGENTS into a label-triggered configuration", () => {
			const configuration = getLabelTriggerConfiguration({ AGENTS: "SecurityAgent" })

			expect("agents" in configuration).toBe(false)
		})

		it("takes priority over pull-request when both are satisfiable", () => {
			const configuration = resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				TRIGGER_LABEL: REVIEW_START_LABEL,
			})

			expect(configuration.type).toBe("label-trigger")
		})

		it("returns pull-request when TRIGGER_LABEL is absent", () => {
			const configuration = resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})

			expect(configuration.type).toBe("pull-request")
		})

		it("treats an empty TRIGGER_LABEL as absent", () => {
			const configuration = resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				TRIGGER_LABEL: "",
			})

			expect(configuration.type).toBe("pull-request")
		})
	})

	describe("pull-request configuration", () => {
		it("returns pull-request when GitHub vars are provided without TRIGGER_LABEL", () => {
			const configuration = getPullRequestConfiguration()

			expect(configuration.type).toBe("pull-request")
			expect(configuration.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				owner: "owner",
				repositoryName: "repo",
				pullRequestNumber: 42,
			})
		})

		it("uses custom GITHUB_API_URL when provided", () => {
			const configuration = getPullRequestConfiguration({ GITHUB_API_URL: "https://github.enterprise.com/api/v3" })

			expect(configuration.github.apiUrl).toBe("https://github.enterprise.com/api/v3")
		})

		it("parses agents in pull-request mode", () => {
			const configuration = getPullRequestConfiguration({ AGENTS: "SecurityAgent" })

			expect(configuration.agents).toEqual(["SecurityAgent"])
		})
	})

	describe("validation errors", () => {
		it("throws when no required environment vars are provided", () => {
			expect(() => resolveConfiguration({})).toThrow("No valid configuration found")
		})

		it("does not report an unset TRIGGER_LABEL as a missing requirement for a run with no arguments", () => {
			// A TRIGGER_LABEL reason here would tell an opened or manual run that it lacks a variable the workflow leaves empty.
			expect(() => resolveConfiguration({})).toThrow(NOTHING_CONFIGURED_FAILURE_MESSAGE)
		})

		it("does not report an empty TRIGGER_LABEL as a missing requirement", () => {
			expect(() => resolveConfiguration({ TRIGGER_LABEL: "" })).toThrow(NOTHING_CONFIGURED_FAILURE_MESSAGE)
		})

		it("throws when only GITHUB_TOKEN is provided", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
			})).toThrow("GitHub mode requires PR_NUMBER and REPO")
		})

		it("throws when only BASE_COMMIT is provided without HEAD_COMMIT", () => {
			expect(() => resolveConfiguration({
				BASE_COMMIT: "abc123",
			})).toThrow("HEAD_COMMIT is required when BASE_COMMIT is provided")
		})

		it("throws when only HEAD_COMMIT is provided without BASE_COMMIT", () => {
			expect(() => resolveConfiguration({
				HEAD_COMMIT: "def456",
			})).toThrow("BASE_COMMIT is required when HEAD_COMMIT is provided")
		})

		it("throws when PR_NUMBER is provided without GITHUB_TOKEN and REPO", () => {
			expect(() => resolveConfiguration({
				PR_NUMBER: "42",
			})).toThrow("GitHub mode requires GITHUB_TOKEN and REPO")
		})

		it("throws when REPO is provided without GITHUB_TOKEN and PR_NUMBER", () => {
			expect(() => resolveConfiguration({
				REPO: "owner/repo",
			})).toThrow("GitHub mode requires GITHUB_TOKEN and PR_NUMBER")
		})

		it("throws when GITHUB_TOKEN and PR_NUMBER are provided without REPO", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
			})).toThrow("GitHub mode requires REPO")
		})

		it("throws when PR_NUMBER is not a valid number", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "not-a-number",
				REPO: "owner/repo",
			})).toThrow('PR_NUMBER must be a valid number, got: "not-a-number"')
		})

		it("escapes a line separator in PR_NUMBER so the failure message stays on one line", () => {
			const environment = { GITHUB_TOKEN: "my-token", PR_NUMBER: "x\u2028y", REPO: "owner/repo" }

			expect(() => resolveConfiguration(environment)).toThrow("- PR_NUMBER must be a valid number, got: \"x\\u2028y\"")
			expect(() => resolveConfiguration(environment)).not.toThrow("\u2028")
		})

		it("throws when PR_NUMBER is not a positive integer", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "0",
				REPO: "owner/repo",
			})).toThrow("PR_NUMBER must be a positive integer, got: 0")
		})

		it("throws when REPO is not in owner/repo format", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "invalid",
			})).toThrow("REPO must be in format 'owner/repo', got: invalid")
		})

		it("throws when REPO is empty string after slash", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/",
			})).toThrow("REPO must be in format 'owner/repo', got: owner/")
		})

		it("throws when REPO has extra slashes", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo/extra",
			})).toThrow("REPO must be in format 'owner/repo', got: owner/repo/extra")
		})

		it("throws when REPO contains a dot segment", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "x/..",
			})).toThrow(`${REPOSITORY_HAZARD_MESSAGE}, got: "x/.."`)
		})

		it("throws when REPO contains a path separator, whitespace or control character", () => {
			const invalidRepositories = ["owner/.", "owner/re po", "owner/re\u0000po"]
			for (const repository of invalidRepositories) {
				expect(() => resolveConfiguration({
					GITHUB_TOKEN: "my-token",
					PR_NUMBER: "42",
					REPO: repository,
				})).toThrow(REPOSITORY_HAZARD_MESSAGE)
			}
		})

		it("throws when REPO contains a query, fragment or percent character, which would change the request target", () => {
			// GitHub's own repository names never carry these, so a value that does is an attempt to move the request off the repository endpoint.
			const invalidRepositories = ["owner/re?po", "owner/re#po", "owner/re%po", "own%2Fer/repo"]
			for (const repository of invalidRepositories) {
				expect(() => resolveConfiguration({
					GITHUB_TOKEN: "my-token",
					PR_NUMBER: "42",
					REPO: repository,
				})).toThrow(REPOSITORY_HAZARD_MESSAGE)
			}
		})

		it("throws when TRIGGER_LABEL is not the review start label instead of falling back to a pull-request run", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				TRIGGER_LABEL: "Start Review",
			})).toThrow(`TRIGGER_LABEL must be "${REVIEW_START_LABEL}" ignoring case, got: "Start Review"`)
		})

		it("throws when TRIGGER_LABEL has trailing whitespace", () => {
			expect(() => resolveConfiguration({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				TRIGGER_LABEL: `${REVIEW_START_LABEL} `,
			})).toThrow(`TRIGGER_LABEL must be "${REVIEW_START_LABEL}" ignoring case, got: "${REVIEW_START_LABEL} "`)
		})

		it("escapes a line separator in TRIGGER_LABEL so the failure message stays on one line", () => {
			const environment = { TRIGGER_LABEL: `${REVIEW_START_LABEL}\u2028FORGED` }

			expect(() => resolveConfiguration(environment)).toThrow(`got: "${REVIEW_START_LABEL}\\u2028FORGED"`)
			expect(() => resolveConfiguration(environment)).not.toThrow("\u2028")
		})

		it("reports the trigger label reason together with the reasons of the other configuration branches", () => {
			const environment = { TRIGGER_LABEL: "Start Review" }

			// Each reason is asserted on its own, so this does not pin the order of the independent branches.
			expect(() => resolveConfiguration(environment)).toThrow("No valid configuration found:")
			expect(() => resolveConfiguration(environment)).toThrow("- BASE_COMMIT and HEAD_COMMIT are not set")
			expect(() => resolveConfiguration(environment)).toThrow(`- TRIGGER_LABEL must be "${REVIEW_START_LABEL}" ignoring case, got: "Start Review"`)
			expect(() => resolveConfiguration(environment)).toThrow("- GitHub mode requires GITHUB_TOKEN and PR_NUMBER and REPO")
		})

		it("reports each distinct branch reason once", () => {
			// The label-trigger and pull-request branches share the GitHub configuration parser, so one invalid GitHub configuration yields the same reason from both, and the anchored pattern holds that reason to the end of the message.
			expect(() => resolveConfiguration({ TRIGGER_LABEL: REVIEW_START_LABEL, GITHUB_TOKEN: "my-token" })).toThrow(/^No valid configuration found:\n- BASE_COMMIT and HEAD_COMMIT are not set\n- GitHub mode requires PR_NUMBER and REPO$/)
		})

		it("states that GitHub mode was rejected because TRIGGER_LABEL is set", () => {
			const environment = { GITHUB_TOKEN: "my-token", PR_NUMBER: "42", REPO: "owner/repo", TRIGGER_LABEL: "Start Review" }

			expect(() => resolveConfiguration(environment)).toThrow(`- TRIGGER_LABEL must be "${REVIEW_START_LABEL}" ignoring case, got: "Start Review"`)
			expect(() => resolveConfiguration(environment)).toThrow("- GitHub mode is ignored because TRIGGER_LABEL is set to \"Start Review\"")
		})
	})
})
