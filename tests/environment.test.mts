import { describe, it, expect } from "bun:test"
import { parseEnvironment } from "../source/environment.mts"

describe("parseEnvironment", () => {
	describe("local-diff mode", () => {
		it("parses local diff mode when BASE_COMMIT and HEAD_COMMIT are provided", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
			})

			expect(config.mode).toBe("local-diff")
			expect(config.localDiff).toEqual({
				baseCommit: "abc123",
				headCommit: "def456",
			})
			expect(config.github).toBeUndefined()
			expect(config.agents).toEqual([])
		})

		it("parses agents in local-diff mode", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				AGENTS: "SecurityAgent, StyleAgent",
			})

			expect(config.mode).toBe("local-diff")
			expect(config.agents).toEqual(["SecurityAgent", "StyleAgent"])
		})

		it("defaults eventType to unknown in local-diff mode", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
			})

			expect(config.eventType).toBe("unknown")
		})

		it("parses eventType and commentBody in local-diff mode", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				EVENT_TYPE: "issue_comment",
				COMMENT_BODY: "/review SecurityAgent",
			})

			expect(config.eventType).toBe("issue_comment")
			expect(config.commentBody).toBe("/review SecurityAgent")
		})

		it("defaults commentBody to null when not provided", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
			})

			expect(config.commentBody).toBeNull()
		})

		it("returns empty agents when AGENTS is empty string", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				AGENTS: "",
			})

			expect(config.agents).toEqual([])
		})

		it("trims agent names", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				AGENTS: "  SecurityAgent  ,  StyleAgent  ",
			})

			expect(config.agents).toEqual(["SecurityAgent", "StyleAgent"])
		})
	})

	describe("github mode", () => {
		it("parses github mode when GITHUB_TOKEN, PR_NUMBER, and REPO are provided", () => {
			const config = parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})

			expect(config.mode).toBe("github")
			expect(config.github).toEqual({
				token: "my-token",
				apiUrl: "https://api.github.com",
				repo: "owner/repo",
				owner: "owner",
				repoName: "repo",
				prNumber: 42,
				commentId: undefined,
			})
			expect(config.localDiff).toBeUndefined()
		})

		it("uses custom GITHUB_API_URL when provided", () => {
			const config = parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				GITHUB_API_URL: "https://github.enterprise.com/api/v3",
			})

			expect(config.github?.apiUrl).toBe("https://github.enterprise.com/api/v3")
		})

		it("throws when PR_NUMBER is not a valid number", () => {
			expect(() => parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "not-a-number",
				REPO: "owner/repo",
			})).toThrow("PR_NUMBER must be a valid number, got: not-a-number")
		})

		it("throws when REPO is not in owner/repo format", () => {
			expect(() => parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "invalid",
			})).toThrow("REPO must be in format 'owner/repo', got: invalid")
		})

		it("throws when REPO is empty string after slash", () => {
			expect(() => parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/",
			})).toThrow("REPO must be in format 'owner/repo', got: owner/")
		})

		it("parses agents in github mode", () => {
			const config = parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				AGENTS: "SecurityAgent",
			})

			expect(config.agents).toEqual(["SecurityAgent"])
		})

		it("parses COMMENT_ID when provided", () => {
			const config = parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				COMMENT_ID: "12345",
			})

			expect(config.github?.commentId).toBe(12345)
		})

		it("throws when COMMENT_ID is not a valid number", () => {
			expect(() => parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
				COMMENT_ID: "not-a-number",
			})).toThrow("COMMENT_ID must be a valid number, got: not-a-number")
		})

		it("defaults commentId to undefined when not provided", () => {
			const config = parseEnvironment({
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})

			expect(config.github?.commentId).toBeUndefined()
		})
	})

	describe("local-diff takes priority over github", () => {
		it("uses local-diff mode when both sets of env vars are provided", () => {
			const config = parseEnvironment({
				BASE_COMMIT: "abc123",
				HEAD_COMMIT: "def456",
				GITHUB_TOKEN: "my-token",
				PR_NUMBER: "42",
				REPO: "owner/repo",
			})

			expect(config.mode).toBe("local-diff")
			expect(config.github).toBeUndefined()
		})
	})

	describe("invalid configuration", () => {
		it("throws when no required env vars are provided", () => {
			expect(() => parseEnvironment({})).toThrow("Invalid configuration")
		})

		it("throws when only GITHUB_TOKEN is provided", () => {
			expect(() => parseEnvironment({
				GITHUB_TOKEN: "my-token",
			})).toThrow("Invalid configuration")
		})

		it("throws when only BASE_COMMIT is provided without HEAD_COMMIT", () => {
			expect(() => parseEnvironment({
				BASE_COMMIT: "abc123",
			})).toThrow("Invalid configuration")
		})
	})
})
