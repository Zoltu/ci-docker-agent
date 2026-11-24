import { describe, it, expect } from "bun:test"
import { fetchPullRequestDiff, fetchPullRequestMetadata, removePullRequestLabel, submitReview, type GitHubFetch } from "../source/github.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"
import { makeGitHubConfiguration } from "./helpers.mts"

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

describe("fetchPullRequestMetadata", () => {
	it("returns the base sha and the label names", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({
			base: { sha: "abc123def" },
			head: { sha: "def456ghi" },
			labels: [{ name: "Review Start" }, { name: "Reviewer - Bug Hunter" }],
		}), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const metadata = await fetchPullRequestMetadata({ githubFetch }, configuration)

		expect(metadata.baseSha).toBe("abc123def")
		expect(metadata.labelNames).toEqual(["Review Start", "Reviewer - Bug Hunter"])
	})

	it("returns an empty label list when the pull request has no labels", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const metadata = await fetchPullRequestMetadata({ githubFetch }, configuration)

		expect(metadata.labelNames).toEqual([])
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR metadata: 404 Not Found")
	})

	it("throws when the response is missing labels", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})

	it("throws when a label has no name", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" }, labels: [{ color: "ffffff" }] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})

	it("throws when the response is missing base.sha", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})

	it("throws when base.sha is not a string", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: 123 }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})
})

describe("removePullRequestLabel", () => {
	it("sends DELETE to the label URL with the label name encoded", async () => {
		let capturedUrl = ""
		let capturedMethod = ""
		const githubFetch: GitHubFetch = async (url, options) => {
			capturedUrl = url
			capturedMethod = options.method ?? ""
			return new Response(null, { status: 200 })
		}
		const configuration = makeGitHubConfiguration()

		await removePullRequestLabel({ githubFetch }, configuration, "Review Start")

		expect(capturedMethod).toBe("DELETE")
		expect(capturedUrl).toBe("https://api.github.com/repos/owner/repo/issues/42/labels/Review%20Start")
	})

	it("throws with the status and body on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Label does not exist", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		expect(removePullRequestLabel({ githubFetch }, configuration, "Review Start")).rejects.toThrow("Failed to remove label \"Review Start\": 404 Not Found\nLabel does not exist")
	})
})
