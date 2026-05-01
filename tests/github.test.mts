import { describe, it, expect } from "bun:test"
import { createFetchPullRequestDiff, createFetchPullRequestBaseCommit, createSubmitReview, type GitHubFetch } from "../source/github.mts"
import { makeGitHubConfiguration } from "./helpers.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"

describe("createFetchPullRequestDiff", () => {
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
		const fetchPullRequestDiff = createFetchPullRequestDiff(githubFetch, makeGitHubConfiguration())

		const result = await fetchPullRequestDiff()

		expect(result).toBe(diffText)
	})

	it("sends Accept: application/vnd.github.diff header", async () => {
		let capturedHeaders = new Headers()
		const githubFetch: GitHubFetch = async (_url, options) => {
			capturedHeaders = new Headers(options.headers)
			return new Response("", { status: 200 })
		}
		const fetchPullRequestDiff = createFetchPullRequestDiff(githubFetch, makeGitHubConfiguration())

		await fetchPullRequestDiff()

		expect(capturedHeaders.get("Accept")).toBe("application/vnd.github.diff")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const fetchPullRequestDiff = createFetchPullRequestDiff(githubFetch, makeGitHubConfiguration())

		expect(fetchPullRequestDiff()).rejects.toThrow("Failed to fetch PR diff")
	})
})

describe("createSubmitReview", () => {
	it("submits a review successfully", async () => {
		const githubFetch: GitHubFetch = async () => new Response(null, { status: 200 })
		const submitReview = createSubmitReview(githubFetch, makeGitHubConfiguration())

		const review: GitHubReviewPayload = { event: "COMMENT", body: "Great work", comments: [] }
		await submitReview(review)
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Error", { status: 422, statusText: "Unprocessable Entity" })
		const submitReview = createSubmitReview(githubFetch, makeGitHubConfiguration())

		const review: GitHubReviewPayload = { event: "COMMENT", body: "Great work", comments: [] }
		expect(submitReview(review)).rejects.toThrow("Failed to submit review")
	})
})

describe("createFetchPullRequestBaseCommit", () => {
	it("fetches base commit sha from GitHub API", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" } }), { status: 200 })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeGitHubConfiguration())

		const baseCommit = await fetchPullRequestBaseCommit()

		expect(baseCommit).toBe("abc123def")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeGitHubConfiguration())

		expect(fetchPullRequestBaseCommit()).rejects.toThrow("Failed to fetch PR base commit")
	})

	it("throws when response is missing base.sha", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ head: { sha: "abc" } }), { status: 200 })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeGitHubConfiguration())

		expect(fetchPullRequestBaseCommit()).rejects.toThrow("Invalid PR response")
	})

	it("throws when base.sha is not a string", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: 123 } }), { status: 200 })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeGitHubConfiguration())

		expect(fetchPullRequestBaseCommit()).rejects.toThrow("Invalid PR response")
	})
})
