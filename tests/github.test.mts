import { describe, it, expect } from "bun:test"
import { createCheckRun, fetchPullRequestDiff, fetchPullRequestBaseCommit, fetchPullRequestHeadSha, findActiveCheckRunByName, submitReview, updateCheckRun, type GitHubFetch } from "../source/github.mts"
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
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" }, head: { sha: "def456ghi" } }), { status: 200 })
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
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: 123 }, head: { sha: "def" } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestBaseCommit({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})
})

describe("fetchPullRequestHeadSha", () => {
	it("fetches head commit sha from GitHub API", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" }, head: { sha: "def456ghi" } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const headSha = await fetchPullRequestHeadSha({ githubFetch }, configuration)

		expect(headSha).toBe("def456ghi")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestHeadSha({ githubFetch }, configuration)).rejects.toThrow("Failed to fetch PR head commit")
	})

	it("throws when response is missing head.sha", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc" } }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		expect(fetchPullRequestHeadSha({ githubFetch }, configuration)).rejects.toThrow("Invalid PR response")
	})
})

describe("createCheckRun", () => {
	it("creates a check run and returns its id", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ id: 12345 }), { status: 201 })
		const configuration = makeGitHubConfiguration()

		const id = await createCheckRun({ githubFetch }, configuration, "headSha123", "Test Check", {
			title: "Test",
			summary: "Test summary",
		})

		expect(id).toBe(12345)
	})

	it("sends POST to /check-runs with correct payload", async () => {
		let capturedUrl = ""
		let capturedBody = ""
		const githubFetch: GitHubFetch = async (url, options) => {
			capturedUrl = url
			capturedBody = options.body as string
			return new Response(JSON.stringify({ id: 1 }), { status: 201 })
		}
		const configuration = makeGitHubConfiguration()

		await createCheckRun({ githubFetch }, configuration, "headSha123", "Test Check", {
			title: "Test",
			summary: "Test summary",
			text: "Detail",
		})

		expect(capturedUrl).toBe("https://api.github.com/repos/owner/repo/check-runs")
		const payload = JSON.parse(capturedBody)
		expect(payload.name).toBe("Test Check")
		expect(payload.head_sha).toBe("headSha123")
		expect(payload.status).toBe("in_progress")
		expect(payload.output.title).toBe("Test")
		expect(payload.output.summary).toBe("Test summary")
		expect(payload.output.text).toBe("Detail")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })
		const configuration = makeGitHubConfiguration()

		expect(createCheckRun({ githubFetch }, configuration, "headSha123", "Test", { title: "T", summary: "S" })).rejects.toThrow("Failed to create check run")
	})

	it("throws when response is missing id", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({}), { status: 201 })
		const configuration = makeGitHubConfiguration()

		expect(createCheckRun({ githubFetch }, configuration, "headSha123", "Test", { title: "T", summary: "S" })).rejects.toThrow("Invalid check run response")
	})
})

describe("updateCheckRun", () => {
	it("sends PATCH to /check-runs/{id} with correct payload", async () => {
		let capturedUrl = ""
		let capturedBody = ""
		const githubFetch: GitHubFetch = async (url, options) => {
			capturedUrl = url
			capturedBody = options.body as string
			return new Response(null, { status: 200 })
		}
		const configuration = makeGitHubConfiguration()

		await updateCheckRun({ githubFetch }, configuration, 999, "failure", {
			title: "Failed",
			summary: "It broke",
			text: "Stack trace here",
		})

		expect(capturedUrl).toBe("https://api.github.com/repos/owner/repo/check-runs/999")
		const payload = JSON.parse(capturedBody)
		expect(payload.status).toBe("completed")
		expect(payload.conclusion).toBe("failure")
		expect(payload.output.title).toBe("Failed")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		expect(updateCheckRun({ githubFetch }, configuration, 1, "success", { title: "T", summary: "S" })).rejects.toThrow("Failed to update check run")
	})
})

describe("findActiveCheckRunByName", () => {
	it("returns the id of the in-progress check run matching the name", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({
			check_runs: [
				{ id: 100, name: "ci-agent", status: "completed" },
				{ id: 200, name: "ci-agent", status: "in_progress" },
				{ id: 300, name: "other-job", status: "in_progress" },
			],
		}), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const id = await findActiveCheckRunByName({ githubFetch }, configuration, "headSha123", "ci-agent")

		expect(id).toBe(200)
	})

	it("returns null when no in-progress check run matches the name", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({
			check_runs: [
				{ id: 100, name: "ci-agent", status: "completed" },
				{ id: 300, name: "other-job", status: "in_progress" },
			],
		}), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const id = await findActiveCheckRunByName({ githubFetch }, configuration, "headSha123", "ci-agent")

		expect(id).toBeNull()
	})

	it("returns null on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const configuration = makeGitHubConfiguration()

		const id = await findActiveCheckRunByName({ githubFetch }, configuration, "headSha123", "ci-agent")

		expect(id).toBeNull()
	})

	it("returns null when response has invalid structure", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 })
		const configuration = makeGitHubConfiguration()

		const id = await findActiveCheckRunByName({ githubFetch }, configuration, "headSha123", "ci-agent")

		expect(id).toBeNull()
	})

	it("includes the check name as a query parameter", async () => {
		let capturedUrl = ""
		const githubFetch: GitHubFetch = async (url) => {
			capturedUrl = url
			return new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
		}
		const configuration = makeGitHubConfiguration()

		await findActiveCheckRunByName({ githubFetch }, configuration, "headSha123", "ci-agent")

		expect(capturedUrl).toContain("/commits/headSha123/check-runs")
		expect(capturedUrl).toContain("check_name=ci-agent")
	})
})

