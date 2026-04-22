import { describe, it, expect } from "bun:test"
import { getConfig, type CommentTriggerConfiguration, type PullRequestConfiguration, type LocalDiffConfiguration } from "../source/configuration.mts"

function getLocalDiffConfig(env: Record<string, string | undefined> = {}): LocalDiffConfiguration {
	const config = getConfig({ BASE_COMMIT: "abc123", HEAD_COMMIT: "def456", ...env })
	if (config.type !== "local-diff") throw new Error(`Expected local-diff, got ${config.type}`)
	return config
}

function getCommentTriggerConfig(env: Record<string, string | undefined> = {}): CommentTriggerConfiguration {
	const config = getConfig({
		EVENT_TYPE: "issue_comment",
		GITHUB_TOKEN: "my-token",
		PR_NUMBER: "42",
		REPO: "owner/repo",
		COMMENT_ID: "12345",
		COMMENT_BODY: "/review",
		...env,
	})
	if (config.type !== "comment-trigger") throw new Error(`Expected comment-trigger, got ${config.type}`)
	return config
}

function getPullRequestConfig(env: Record<string, string | undefined> = {}): PullRequestConfiguration {
	const config = getConfig({
		GITHUB_TOKEN: "my-token",
		PR_NUMBER: "42",
		REPO: "owner/repo",
		...env,
	})
	if (config.type !== "pull-request") throw new Error(`Expected pull-request, got ${config.type}`)
	return config
}

describe("getConfig", () => {
	describe("local-diff configuration", () => {
		it("returns local-diff when BASE_COMMIT and HEAD_COMMIT are provided", () => {
			const config = getLocalDiffConfig()

			expect(config.type).toBe("local-diff")
			expect(config.baseCommit).toBe("abc123")
			expect(config.headCommit).toBe("def456")
			expect(config.agents).toBe("run all agents")
		})

		it("parses agents in local-diff mode", () => {
			const config = getLocalDiffConfig({ AGENTS: "SecurityAgent, StyleAgent" })

			expect(config.agents).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("returns 'run all agents' when AGENTS is empty string", () => {
			const config = getLocalDiffConfig({ AGENTS: "" })

			expect(config.agents).toBe("run all agents")
		})

		it("trims agent names", () => {
			const config = getLocalDiffConfig({ AGENTS: "  SecurityAgent  ,  StyleAgent  " })

			expect(config.agents).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("takes priority over github when both sets of env vars are provided", () => {
			const config = getConfig({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})

			expect(config.type).toBe("local-diff")
		})
	})

	describe("comment-trigger configuration", () => {
		it("returns comment-trigger when EVENT_TYPE is issue_comment with GitHub vars", () => {
			const config = getCommentTriggerConfig()

			expect(config.type).toBe("comment-trigger")
			expect(config.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				repo: "owner/repo",
				owner: "owner",
				repoName: "repo",
				prNumber: 42,
			})
			expect(config.commentBody).toBe("/review")
			expect(config.commentId).toBe(12345)
		})

		it("defaults commentBody to empty string when not provided", () => {
			const config = getCommentTriggerConfig({ COMMENT_BODY: undefined })

			expect(config.commentBody).toBe("")
		})

		it("uses custom GITHUB_API_URL when provided", () => {
			const config = getCommentTriggerConfig({ GITHUB_API_URL: "https://github.enterprise.com/api/v3" })

			expect(config.github.apiUrl).toBe("https://github.enterprise.com/api/v3")
		})

		it("throws when COMMENT_ID is not provided", () => {
			expect(() => getConfig({
				EVENT_TYPE: "issue_comment",
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})).toThrow("COMMENT_ID is required for comment trigger mode")
		})

		it("throws when COMMENT_ID is not a valid number", () => {
			expect(() => getConfig({
				EVENT_TYPE: "issue_comment",
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				COMMENT_ID: "not-a-number",
			})).toThrow("COMMENT_ID must be a valid number, got: not-a-number")
		})
	})

	describe("pull-request configuration", () => {
		it("returns pull-request when GitHub vars are provided without issue_comment event type", () => {
			const config = getPullRequestConfig()

			expect(config.type).toBe("pull-request")
			expect(config.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				repo: "owner/repo",
				owner: "owner",
				repoName: "repo",
				prNumber: 42,
			})
		})

		it("returns pull-request when EVENT_TYPE is workflow_dispatch", () => {
			const config = getPullRequestConfig({ EVENT_TYPE: "workflow_dispatch" })

			expect(config.type).toBe("pull-request")
		})

		it("returns pull-request when EVENT_TYPE is pull_request_target", () => {
			const config = getPullRequestConfig({ EVENT_TYPE: "pull_request_target" })

			expect(config.type).toBe("pull-request")
		})

		it("uses custom GITHUB_API_URL when provided", () => {
			const config = getPullRequestConfig({ GITHUB_API_URL: "https://github.enterprise.com/api/v3" })

			expect(config.github.apiUrl).toBe("https://github.enterprise.com/api/v3")
		})

		it("parses agents in pull-request mode", () => {
			const config = getPullRequestConfig({ AGENTS: "SecurityAgent" })

			expect(config.agents).toEqual(["SecurityAgent"])
		})
	})

	describe("EVENT_TYPE validation", () => {
		it("accepts valid event types", () => {
			for (const eventType of ["pull_request_target", "workflow_dispatch", "issue_comment", "local"] as const) {
				const config = getConfig({
					BASE_COMMIT: "abc123",
					HEAD_COMMIT: "def456",
					EVENT_TYPE: eventType,
				})
				expect(config.type).toBe("local-diff")
			}
		})

		it("throws for invalid EVENT_TYPE", () => {
			expect(() => getConfig({
				EVENT_TYPE: "bogus",
			})).toThrow("EVENT_TYPE must be one of")
		})
	})

	describe("validation errors", () => {
		it("throws when no required env vars are provided", () => {
			expect(() => getConfig({})).toThrow("No valid configuration found")
		})

		it("throws when only GITHUB_TOKEN is provided", () => {
			expect(() => getConfig({
				GITHUB_TOKEN: "my-token",
			})).toThrow("GitHub mode requires PR_NUMBER and REPO")
		})

		it("throws when only BASE_COMMIT is provided without HEAD_COMMIT", () => {
			expect(() => getConfig({
				BASE_COMMIT: "abc123",
			})).toThrow("HEAD_COMMIT is required when BASE_COMMIT is provided")
		})

		it("throws when only HEAD_COMMIT is provided without BASE_COMMIT", () => {
			expect(() => getConfig({
				HEAD_COMMIT: "def456",
			})).toThrow("BASE_COMMIT is required when HEAD_COMMIT is provided")
		})

		it("throws when PR_NUMBER is provided without GITHUB_TOKEN and REPO", () => {
			expect(() => getConfig({
				PR_NUMBER: "42",
			})).toThrow("GitHub mode requires GITHUB_TOKEN and REPO")
		})

		it("throws when REPO is provided without GITHUB_TOKEN and PR_NUMBER", () => {
			expect(() => getConfig({
				REPO: "owner/repo",
			})).toThrow("GitHub mode requires GITHUB_TOKEN and PR_NUMBER")
		})

		it("throws when GITHUB_TOKEN and PR_NUMBER are provided without REPO", () => {
			expect(() => getConfig({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
			})).toThrow("GitHub mode requires REPO")
		})

		it("throws when PR_NUMBER is not a valid number", () => {
			expect(() => getConfig({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "not-a-number",
				REPO: "owner/repo",
			})).toThrow("PR_NUMBER must be a valid number, got: not-a-number")
		})

		it("throws when REPO is not in owner/repo format", () => {
			expect(() => getConfig({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "invalid",
			})).toThrow("REPO must be in format 'owner/repo', got: invalid")
		})

		it("throws when REPO is empty string after slash", () => {
			expect(() => getConfig({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/",
			})).toThrow("REPO must be in format 'owner/repo', got: owner/")
		})

		it("throws when REPO has extra slashes", () => {
			expect(() => getConfig({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo/extra",
			})).toThrow("REPO must be in format 'owner/repo', got: owner/repo/extra")
		})
	})
})
