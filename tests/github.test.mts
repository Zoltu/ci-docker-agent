import { describe, it, expect } from "bun:test"
import { fetchPullRequestDiff, fetchPullRequestMetadata, removePullRequestLabel, submitReview, type GitHubFetch } from "../source/github.mts"
import type { GitHubReviewPayload } from "../source/github-types.mts"
import { BASE_COMMIT_SHA, BASE_COMMIT_SHA_256, makeGitHubConfiguration } from "./helpers.mts"

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

		await expect(fetchPullRequestDiff({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR diff")
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

	it("returns a multi-line body byte-exact because the aggregator reads it as data", async () => {
		const body = "{\n  \"message\": \"Unprocessable Entity\"\n}"
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
			base: { sha: BASE_COMMIT_SHA },
			head: { sha: "fedcba9876543210fedcba9876543210fedcba98" },
			labels: [{ name: "Review Start" }, { name: "Reviewer - Bug Hunter" }],
		}), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const metadata = await fetchPullRequestMetadata({ githubFetch }, configuration)

		expect(metadata.baseSha).toBe(BASE_COMMIT_SHA)
		expect(metadata.labelNames).toEqual(["Review Start", "Reviewer - Bug Hunter"])
	})

	it("accepts a 64 character commit object name from a SHA-256 repository", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA_256 }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const metadata = await fetchPullRequestMetadata({ githubFetch }, configuration)

		expect(metadata.baseSha).toBe(BASE_COMMIT_SHA_256)
	})

	it("returns an empty label list when the pull request has no labels", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const metadata = await fetchPullRequestMetadata({ githubFetch }, configuration)

		expect(metadata.labelNames).toEqual([])
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR metadata: 404 Not Found")
	})

	it("escapes a response body so a multi-line body cannot forge an extra log line", async () => {
		const githubFetch: GitHubFetch = async () => new Response("rate limited\nFORGED LOG LINE", { status: 500, statusText: "Internal Server Error" })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR metadata: 500 Internal Server Error\nrate limited\\u000aFORGED LOG LINE")
	})

	it("throws when the response is missing labels", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing labels[].name")
	})

	it("throws when labels is not an array", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA }, labels: "Review Start" }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing labels[].name")
	})

	it("throws when a label has no name", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA }, labels: [{ color: "ffffff" }] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing labels[].name")
	})

	it("throws when a label name is not a string", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA }, labels: [{ name: 7 }] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing labels[].name")
	})

	it("throws when the response is missing base", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing base.sha")
	})

	it("throws when the response is missing base.sha", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: {}, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing base.sha")
	})

	it("throws when base.sha is not a string", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: 123 }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: missing base.sha")
	})

	it("rejects a base.sha that is not a hex commit object name", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: base.sha must be a 40 or 64 character hex commit object name, got: \"abc123def\"")
	})

	it("rejects a base.sha that carries a git argument", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "--upload-pack=evil" }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response: base.sha must be a 40 or 64 character hex commit object name, got: \"--upload-pack=evil\"")
	})

	it("rejects a base.sha whose length is one hex digit short", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: BASE_COMMIT_SHA.slice(0, 39) }, labels: [] }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		await expect(fetchPullRequestMetadata({ githubFetch }, configuration)).rejects.toThrow("base.sha must be a 40 or 64 character hex commit object name")
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

		await expect(removePullRequestLabel({ githubFetch }, configuration, "Review Start")).rejects.toThrow("Failed to remove label \"Review Start\": 404 Not Found\nLabel does not exist")
	})

	it("escapes a response body so a multi-line body cannot forge an extra log line", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Label does not exist\nFORGED LOG LINE", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		await expect(removePullRequestLabel({ githubFetch }, configuration, "Review Start")).rejects.toThrow("Failed to remove label \"Review Start\": 404 Not Found\nLabel does not exist\\u000aFORGED LOG LINE")
	})

	it("escapes a line separator in the label name while the request URL carries it encoded", async () => {
		let capturedUrl = ""
		const githubFetch: GitHubFetch = async (url) => {
			capturedUrl = url
			return new Response("Label does not exist", { status: 404, statusText: "Not Found" })
		}
		const configuration = makeGitHubConfiguration()

		await expect(removePullRequestLabel({ githubFetch }, configuration, "Evil\u2028FORGED")).rejects.toThrow("Failed to remove label \"Evil\\u2028FORGED\": 404 Not Found\nLabel does not exist")

		expect(capturedUrl).toBe("https://api.github.com/repos/owner/repo/issues/42/labels/Evil%E2%80%A8FORGED")
	})

	it("refuses a dot segment, an empty name, or a separator-bearing name without issuing any request", async () => {
		const requestedUrls: string[] = []
		const githubFetch: GitHubFetch = async (url) => {
			requestedUrls.push(url)
			return new Response(null, { status: 200 })
		}
		const configuration = makeGitHubConfiguration()
		// encodeURIComponent leaves a dot segment intact, so each of these would otherwise build a URL that parses to a different endpoint than the label.
		const refusedLabelNames: ReadonlyArray<readonly [string, string]> = [
			["", "Label name must not be empty or whitespace only"],
			["   ", "Label name must not be empty or whitespace only"],
			[".", "Label name must not be a dot segment"],
			["..", "Label name must not be a dot segment"],
			["Review Start/..", "Label name must not contain a path separator or a control character"],
			["..\\Review Start", "Label name must not contain a path separator or a control character"],
			["Review Start\nFORGED", "Label name must not contain a path separator or a control character"]
		]

		for (const [labelName, expectedMessage] of refusedLabelNames) {
			await expect(removePullRequestLabel({ githubFetch }, configuration, labelName)).rejects.toThrow(expectedMessage)
		}

		expect(requestedUrls).toEqual([])
	})
})
