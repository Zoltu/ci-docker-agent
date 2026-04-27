import { describe, it, expect } from "bun:test"
import { parseIgnorePatterns, isPathIgnored } from "../source/ignore-patterns.mts"

describe("parseIgnorePatterns", () => {
	it("returns non-comment, non-empty lines", () => {
		const content = "node_modules\n# this is a comment\n*.log\n\ndist/\n"
		const result = parseIgnorePatterns(content)

		expect(result).toEqual(["node_modules", "*.log", "dist/"])
	})

	it("trims whitespace from each line", () => {
		const content = "  node_modules  \n  *.log  "
		const result = parseIgnorePatterns(content)

		expect(result).toEqual(["node_modules", "*.log"])
	})

	it("returns empty array for empty input", () => {
		const result = parseIgnorePatterns("")

		expect(result).toEqual([])
	})

	it("returns empty array for comment-only input", () => {
		const result = parseIgnorePatterns("# comment 1\n# comment 2")

		expect(result).toEqual([])
	})

	it("strips inline comments", () => {
		const result = parseIgnorePatterns("node_modules # this is a comment")

		expect(result).toEqual(["node_modules"])
	})

	it("handles escaped hashes", () => {
		const result = parseIgnorePatterns("file\\#name")

		expect(result).toEqual(["file#name"])
	})
})

describe("isPathIgnored", () => {
	it("matches literal filename anywhere", () => {
		expect(isPathIgnored("node_modules", ["node_modules"])).toBe(true)
		expect(isPathIgnored("a/node_modules", ["node_modules"])).toBe(true)
		expect(isPathIgnored("a/b/node_modules", ["node_modules"])).toBe(true)
	})

	it("does not match unrelated paths", () => {
		expect(isPathIgnored("src/index.ts", ["node_modules"])).toBe(false)
	})

	it("matches wildcard patterns", () => {
		expect(isPathIgnored("debug.log", ["*.log"])).toBe(true)
		expect(isPathIgnored("a/debug.log", ["*.log"])).toBe(true)
		expect(isPathIgnored("src/index.ts", ["*.log"])).toBe(false)
	})

	it("matches anchored patterns only at root", () => {
		expect(isPathIgnored("src", ["/src"])).toBe(true)
		expect(isPathIgnored("a/src", ["/src"])).toBe(false)
	})

	it("matches patterns with slash relative to root", () => {
		expect(isPathIgnored("src/test.ts", ["src/test.ts"])).toBe(true)
		expect(isPathIgnored("a/src/test.ts", ["src/test.ts"])).toBe(false)
	})

	it("matches **/ prefix at any depth", () => {
		expect(isPathIgnored("node_modules", ["**/node_modules"])).toBe(true)
		expect(isPathIgnored("a/node_modules", ["**/node_modules"])).toBe(true)
		expect(isPathIgnored("a/b/node_modules", ["**/node_modules"])).toBe(true)
	})

	it("matches **/ with slash at any depth", () => {
		expect(isPathIgnored("src/test.ts", ["**/src/test.ts"])).toBe(true)
		expect(isPathIgnored("a/src/test.ts", ["**/src/test.ts"])).toBe(true)
		expect(isPathIgnored("a/b/src/test.ts", ["**/src/test.ts"])).toBe(true)
	})

	it("supports negation with !", () => {
		expect(isPathIgnored("a.log", ["*.log", "!important.log"])).toBe(true)
		expect(isPathIgnored("important.log", ["*.log", "!important.log"])).toBe(false)
	})

	it("ignores directory-only patterns for files", () => {
		expect(isPathIgnored("node_modules", ["node_modules/"])).toBe(false)
		expect(isPathIgnored("node_modules/package.json", ["node_modules/"])).toBe(false)
	})

	it("matches ? wildcard", () => {
		expect(isPathIgnored("a.log", ["?.log"])).toBe(true)
		expect(isPathIgnored("ab.log", ["?.log"])).toBe(false)
	})

	it("handles multiple patterns", () => {
		const patterns = ["node_modules", "*.log", ".env", "dist/"]
		expect(isPathIgnored("node_modules", patterns)).toBe(true)
		expect(isPathIgnored("error.log", patterns)).toBe(true)
		expect(isPathIgnored(".env", patterns)).toBe(true)
		expect(isPathIgnored("src/index.ts", patterns)).toBe(false)
	})

	it("matches standalone double-star", () => {
		expect(isPathIgnored("anything", ["**"])).toBe(true)
		expect(isPathIgnored("a/b/c", ["**"])).toBe(true)
	})

	it("matches character classes", () => {
		expect(isPathIgnored("file1.txt", ["file[123].txt"])).toBe(true)
		expect(isPathIgnored("file4.txt", ["file[123].txt"])).toBe(false)
	})
})
