import { describe, it, expect } from "bun:test"
import { getConfiguration, type CommentTriggerConfiguration, type PullRequestConfiguration, type LocalDiffConfiguration, type Configuration } from "../source/configuration.mts"

function resolveConfiguration(environment: Record<string, string | undefined>): Configuration {
	return getConfiguration(environment)
}

function getLocalDiffConfiguration(environment: Record<string, string | undefined> = {}): LocalDiffConfiguration {
	const configuration = resolveConfiguration({ BASE_COMMIT: "abc123", HEAD_COMMIT: "def456", ...environment })
	if (configuration.type !== "local-diff") throw new Error(`Expected local-diff, got ${configuration.type}`)
	return configuration
}

function getCommentTriggerConfiguration(environment: Record<string, string | undefined> = {}): CommentTriggerConfiguration {
	const configuration = resolveConfiguration({
		GITHUB_TOKEN: "my-token",
		PR_NUMBER: "42",
		REPO: "owner/repo",
		COMMENT_BODY: "/review",
		...environment,
	})
	if (configuration.type !== "comment-trigger") throw new Error(`Expected comment-trigger, got ${configuration.type}`)
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

	describe("comment-trigger configuration", () => {
		it("returns comment-trigger when COMMENT_BODY is set with GitHub vars", () => {
			const configuration = getCommentTriggerConfiguration()

			expect(configuration.type).toBe("comment-trigger")
			expect(configuration.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				repository: "owner/repo",
				owner: "owner",
				repositoryName: "repo",
				pullRequestNumber: 42,
			})
			expect(configuration.commentBody).toBe("/review")
		})

		it("uses custom GITHUB_API_URL when provided", () => {
			const configuration = getCommentTriggerConfiguration({ GITHUB_API_URL: "https://github.enterprise.com/api/v3" })

			expect(configuration.github.apiUrl).toBe("https://github.enterprise.com/api/v3")
		})
	})

	describe("pull-request configuration", () => {
		it("returns pull-request when GitHub vars are provided without COMMENT_BODY", () => {
			const configuration = getPullRequestConfiguration()

			expect(configuration.type).toBe("pull-request")
			expect(configuration.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				repository: "owner/repo",
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
			})).toThrow("PR_NUMBER must be a valid number, got: not-a-number")
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
	})
})
