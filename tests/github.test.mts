import { describe, it, expect } from "bun:test"
import { isPullRequestFile, isPullRequestFileArray, createFetchPullRequestFiles, createFetchPullRequestBaseCommit, createSubmitReview, createReactToComment, type GitHubFetch } from "../source/github.mts"
import type { GitHubConfiguration, GitHubReviewPayload } from "../source/github-types.mts"

function makeConfiguration(overrides: Partial<GitHubConfiguration> = {}): GitHubConfiguration {
	return {
		token: "test-token",
		apiUrl: "https://api.github.com",
		repository: "owner/repo",
		owner: "owner",
		repositoryName: "repo",
		pullRequestNumber: 42,
		...overrides,
	}
}

describe("isPullRequestFile", () => {
	it("returns true for a valid PullRequestFile object", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(true)
	})

	it("returns true for a PullRequestFile with patch", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
			patch: "@@ -1 +1 @@\n-old\n+new",
		})).toBe(true)
	})

	it("returns false when patch is not a string", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
			patch: 123,
		})).toBe(false)
	})

	it("returns false for null", () => {
		expect(isPullRequestFile(null)).toBe(false)
	})

	it("returns false for a string", () => {
		expect(isPullRequestFile("not an object")).toBe(false)
	})

	it("returns false when filename is missing", () => {
		expect(isPullRequestFile({
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when filename is not a string", () => {
		expect(isPullRequestFile({
			filename: 123,
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when status is missing", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when additions is not a number", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "modified",
			additions: "5",
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when deletions is not a number", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: "2",
			changes: 7,
		})).toBe(false)
	})

	it("returns false when changes is not a number", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: "7",
		})).toBe(false)
	})

	it("returns false for an empty object", () => {
		expect(isPullRequestFile({})).toBe(false)
	})

	it("returns false for an unknown status value", () => {
		expect(isPullRequestFile({
			filename: "src/file.ts",
			status: "deleted",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})
})

describe("isPullRequestFileArray", () => {
	it("returns true for an array of valid PullRequestFile objects", () => {
		expect(isPullRequestFileArray([
			{ filename: "a.ts", status: "added", additions: 1, deletions: 0, changes: 1 },
			{ filename: "b.ts", status: "modified", additions: 2, deletions: 1, changes: 3 },
		])).toBe(true)
	})

	it("returns true for an empty array", () => {
		expect(isPullRequestFileArray([])).toBe(true)
	})

	it("returns false if one element is invalid", () => {
		expect(isPullRequestFileArray([
			{ filename: "a.ts", status: "added", additions: 1, deletions: 0, changes: 1 },
			{ filename: 123, status: "added", additions: 1, deletions: 0, changes: 1 },
		])).toBe(false)
	})

	it("returns false for a non-array", () => {
		expect(isPullRequestFileArray("not an array")).toBe(false)
	})

	it("returns false for null", () => {
		expect(isPullRequestFileArray(null)).toBe(false)
	})
})

describe("createFetchPullRequestFiles", () => {
	it("fetches PR files from GitHub API", async () => {
		const pullRequestFile = { filename: "src/file.ts", status: "modified" as const, additions: 1, deletions: 0, changes: 1 }
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify([pullRequestFile]), { status: 200 })
		const fetchPullRequestFiles = createFetchPullRequestFiles(githubFetch, makeConfiguration())

		const files = await fetchPullRequestFiles()

		expect(files).toHaveLength(1)
		expect(files[0]).toEqual(pullRequestFile)
	})

	it("paginates when there are more than 100 files", async () => {
		let page = 0
		const githubFetch: GitHubFetch = async (url) => {
			page++
			if (page === 1) {
				expect(url).toContain("page=1")
				return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ filename: `file${index}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 }))), { status: 200 })
			}
			expect(url).toContain("page=2")
			return new Response(JSON.stringify([{ filename: "file100.ts", status: "added", additions: 1, deletions: 0, changes: 1 }]), { status: 200 })
		}
		const fetchPullRequestFiles = createFetchPullRequestFiles(githubFetch, makeConfiguration())

		const files = await fetchPullRequestFiles()

		expect(files).toHaveLength(101)
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const fetchPullRequestFiles = createFetchPullRequestFiles(githubFetch, makeConfiguration())

		expect(fetchPullRequestFiles()).rejects.toThrow("Failed to fetch PR files")
	})

	it("throws when response is not a valid PullRequestFile array", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify([{ bad: "data" }]), { status: 200 })
		const fetchPullRequestFiles = createFetchPullRequestFiles(githubFetch, makeConfiguration())

		expect(fetchPullRequestFiles()).rejects.toThrow("Invalid response from GitHub API")
	})
})

describe("createSubmitReview", () => {
	it("submits a review successfully", async () => {
		const githubFetch: GitHubFetch = async () => new Response(null, { status: 200 })
		const submitReview = createSubmitReview(githubFetch, makeConfiguration())

		const review: GitHubReviewPayload = { event: "COMMENT", body: "Great work", comments: [] }
		await submitReview(review)
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Error", { status: 422, statusText: "Unprocessable Entity" })
		const submitReview = createSubmitReview(githubFetch, makeConfiguration())

		const review: GitHubReviewPayload = { event: "COMMENT", body: "Great work", comments: [] }
		expect(submitReview(review)).rejects.toThrow("Failed to submit review")
	})
})

describe("createReactToComment", () => {
	it("reacts to a comment successfully", async () => {
		const githubFetch: GitHubFetch = async () => new Response(null, { status: 200 })
		const reactToComment = createReactToComment(githubFetch, makeConfiguration())

		await reactToComment(123, "-1")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Error", { status: 403, statusText: "Forbidden" })
		const reactToComment = createReactToComment(githubFetch, makeConfiguration())

		expect(reactToComment(123, "-1")).rejects.toThrow("Failed to react to comment")
	})
})

describe("createFetchPullRequestBaseCommit", () => {
	it("fetches base commit sha from GitHub API", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: "abc123def" } }), { status: 200 })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeConfiguration())

		const baseCommit = await fetchPullRequestBaseCommit()

		expect(baseCommit).toBe("abc123def")
	})

	it("throws on non-ok response", async () => {
		const githubFetch: GitHubFetch = async () => new Response("Not found", { status: 404, statusText: "Not Found" })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeConfiguration())

		expect(fetchPullRequestBaseCommit()).rejects.toThrow("Failed to fetch PR base commit")
	})

	it("throws when response is missing base.sha", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ head: { sha: "abc" } }), { status: 200 })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeConfiguration())

		expect(fetchPullRequestBaseCommit()).rejects.toThrow("Invalid PR response")
	})

	it("throws when base.sha is not a string", async () => {
		const githubFetch: GitHubFetch = async () => new Response(JSON.stringify({ base: { sha: 123 } }), { status: 200 })
		const fetchPullRequestBaseCommit = createFetchPullRequestBaseCommit(githubFetch, makeConfiguration())

		expect(fetchPullRequestBaseCommit()).rejects.toThrow("Invalid PR response")
	})
})
