import { describe, it, expect } from "bun:test"
import { fetchPullRequestDiff, fetchPullRequestBaseCommit, submitReview, type GitHubFetch } from "../source/github.mts"
import { makeGitHubConfiguration } from "./helpers.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"

describe("fetchPullRequestDiff", () => {
	it("fetches PR diff text from GitHub API", async () => {
		const diffText = [
			"diff --git a/src/file.ts b/src/file.ts",
			"--- a/src/file.ts",
			"+++ b/src/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n")
		const githubFetch: GitHubFetch = async () => new Response(diffText, { status: 200 })
		const configuration = makeGitHubConfiguration()

		const result = await fetchPullRequestDiff({ githubFetch }, configuration)

		expect(result).toBe(diffText)
	})

	it("sends Accept: application/vnd.github.diff header", async () => {
		let capturedHeaders = new Headers()
		const githubFetch: GitHubFetch = async (_url, options) => {
			capturedHeaders = new Headers(options.headers)
			return new Response("", { status: 200 })
		}
		const configuration = makeGitHubConfiguration()

		await fetchPullRequestDiff({ githubFetch }, configuration)

		expect(capturedHeaders.get("Accept")).toBe("application/vnd.github.diff")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestDiff({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR diff")
	})
})

describe("submitReview", () => {
	it("submits a review successfully", async () => {
		const githubFetch: GitHubFetch = async () => new Response(null, { status: 200 })
		const configuration = makeGitHubConfiguration()

		const review: GitHubReviewPayload = { event: "COMMENT", body: "Great work", comments: [] }
		const result = await submitReview({ githubFetch }, configuration, review)
		expect(result).toEqual({ ok: true })
	})

	it("returns a result with status and body on non-2xx response", async () => {
		const body = JSON.stringify({ message: "Unprocessable Entity", errors: ["Line could not be resolved"] })
		const githubFetch: GitHubFetch = async () => new Response(body, { status: 422, statusText: "Unprocessable Entity" })
		const configuration = makeGitHubConfiguration()

		const review: GitHubReviewPayload = { event: "COMMENT", body: "Great work", comments: [] }
		const result = await submitReview({ githubFetch }, configuration, review)
		expect(result).toEqual({ ok: false, status: 422, body })
	})
})

describe("fetchPullRequestBaseCommit", () => {
	it("fetches base commit sha from GitHub API", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const baseCommit = await fetchPullRequestBaseCommit({ githubFetch }, configuration)

		expect(baseCommit).toBe("abc123def")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestBaseCommit({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR base commit")
	})

	it("throws when response is missing base.sha", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ head: { sha: "abc" } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestBaseCommit({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})

	it("throws when base.sha is not a string", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: 123 } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestBaseCommit({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})
})
