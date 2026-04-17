import { describe, it, expect } from "bun:test"
import { isPrFile, isPrFileArray } from "../source/github.mts"

describe("isPrFile", () => {
	it("returns true for a valid PrFile object", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(true)
	})

	it("returns true for a PrFile with patch", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
			patch: "@@ -1 +1 @@\n-old\n+new",
		})).toBe(true)
	})

	it("returns false when patch is not a string", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
			patch: 123,
		})).toBe(false)
	})

	it("returns false for null", () => {
		expect(isPrFile(null)).toBe(false)
	})

	it("returns false for a string", () => {
		expect(isPrFile("not an object")).toBe(false)
	})

	it("returns false when filename is missing", () => {
		expect(isPrFile({
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when filename is not a string", () => {
		expect(isPrFile({
			filename: 123,
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when status is missing", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when additions is not a number", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "modified",
			additions: "5",
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})

	it("returns false when deletions is not a number", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: "2",
			changes: 7,
		})).toBe(false)
	})

	it("returns false when changes is not a number", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "modified",
			additions: 5,
			deletions: 2,
			changes: "7",
		})).toBe(false)
	})

	it("returns false for an empty object", () => {
		expect(isPrFile({})).toBe(false)
	})

	it("returns false for an unknown status value", () => {
		expect(isPrFile({
			filename: "src/file.ts",
			status: "deleted",
			additions: 5,
			deletions: 2,
			changes: 7,
		})).toBe(false)
	})
})

describe("isPrFileArray", () => {
	it("returns true for an array of valid PrFile objects", () => {
		expect(isPrFileArray([
			{ filename: "a.ts", status: "added", additions: 1, deletions: 0, changes: 1 },
			{ filename: "b.ts", status: "modified", additions: 2, deletions: 1, changes: 3 },
		])).toBe(true)
	})

	it("returns true for an empty array", () => {
		expect(isPrFileArray([])).toBe(true)
	})

	it("returns false if one element is invalid", () => {
		expect(isPrFileArray([
			{ filename: "a.ts", status: "added", additions: 1, deletions: 0, changes: 1 },
			{ filename: 123, status: "added", additions: 1, deletions: 0, changes: 1 },
		])).toBe(false)
	})

	it("returns false for a non-array", () => {
		expect(isPrFileArray("not an array")).toBe(false)
	})

	it("returns false for null", () => {
		expect(isPrFileArray(null)).toBe(false)
	})
})
