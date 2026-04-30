import { describe, it, expect } from "bun:test"
import { isContentText, classifyFileByExtension } from "../source/text-detection.mts"

describe("isContentText", () => {
	it("returns true for plain ASCII text", () => {
		expect(isContentText("hello world")).toBe(true)
	})

	it("returns true for empty string", () => {
		expect(isContentText("")).toBe(true)
	})

	it("returns true for UTF-8 text with multi-byte characters", () => {
		expect(isContentText("こんにちは世界 🌍")).toBe(true)
	})

	it("returns false for content with null byte", () => {
		expect(isContentText("hello\x00world")).toBe(false)
	})

	it("returns true when null byte is past the 8KB boundary", () => {
		const content = "a".repeat(8193) + "\x00"
		expect(isContentText(content)).toBe(true)
	})

	it("returns false for content with replacement character", () => {
		expect(isContentText("hello\uFFFDworld")).toBe(false)
	})

	it("returns false for content with low printable ratio", () => {
		const controlChars = Array.from({ length: 200 }, () => "\x01").join("")
		const printable = "a".repeat(50)
		expect(isContentText(controlChars + printable)).toBe(false)
	})

	it("returns true for content with high printable ratio", () => {
		const printable = "a".repeat(90)
		const control = "\t".repeat(10)
		expect(isContentText(printable + control)).toBe(true)
	})

	it("returns true for content with newlines and tabs", () => {
		expect(isContentText("line1\nline2\n\tindented\r\n")).toBe(true)
	})

	it("returns true for source code", () => {
		expect(isContentText('export function hello(): string { return "world" }\n')).toBe(true)
	})
})

describe("classifyFileByExtension", () => {
	it("classifies known text extension as text", () => {
		expect(classifyFileByExtension("src/index.ts")).toBe("text")
	})

	it("classifies known binary extension as binary", () => {
		expect(classifyFileByExtension("logo.png")).toBe("binary")
	})

	it("classifies ambiguous extension as ambiguous", () => {
		expect(classifyFileByExtension("video.mts")).toBe("ambiguous")
	})

	it("classifies unknown extension as binary", () => {
		expect(classifyFileByExtension("data.xyz")).toBe("binary")
	})

	it("classifies dotfile with known text part as text", () => {
		expect(classifyFileByExtension(".gitignore")).toBe("text")
	})

	it("classifies known text filename as text", () => {
		expect(classifyFileByExtension("Dockerfile")).toBe("text")
	})

	it("classifies no-extension file with text basename as text", () => {
		expect(classifyFileByExtension("Makefile")).toBe("text")
	})

	it("classifies JSON file as text", () => {
		expect(classifyFileByExtension("package.json")).toBe("text")
	})

	it("classifies markdown file as text", () => {
		expect(classifyFileByExtension("README.md")).toBe("text")
	})

	it("classifies zip file as binary", () => {
		expect(classifyFileByExtension("archive.zip")).toBe("binary")
	})
})
