import { describe, expect, it } from "bun:test"
import { classifyFileByExtension, isContentText } from "../source/text-detection.mts"

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

	it("classifies unknown extension as ambiguous", () => {
		expect(classifyFileByExtension("data.xyz")).toBe("ambiguous")
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

describe("integration: classifyFileByExtension with isContentText fallback", () => {
	it("accepts ambiguous .mts file with TypeScript content", () => {
		expect(classifyFileByExtension("module.mts")).toBe("ambiguous")
		expect(isContentText("import { foo } from './bar'\nexport function hello() { return 42 }\n")).toBe(true)
	})

	it("rejects ambiguous .mts file with binary content", () => {
		expect(classifyFileByExtension("video.mts")).toBe("ambiguous")
		const binaryContent = "\x00\x00\x00\x00ftypisom"
		expect(isContentText(binaryContent)).toBe(false)
	})

	it("accepts unknown extension file with text content", () => {
		expect(classifyFileByExtension("config.xyz")).toBe("ambiguous")
		expect(isContentText("server.host = localhost\nserver.port = 8080\n")).toBe(true)
	})

	it("rejects unknown extension file with high-entropy binary content", () => {
		expect(classifyFileByExtension("data.xyz")).toBe("ambiguous")
		expect(isContentText("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F")).toBe(false)
	})

	it("accepts ambiguous .mts with real-world TypeScript source", () => {
		expect(classifyFileByExtension("source/ai.mts")).toBe("ambiguous")
		expect(isContentText("import type { LineComment } from './github-types.mts'\nexport type CallApi = (prompt: string) => Promise<string>\n")).toBe(true)
	})

	it("does not misclassify text content of known-binary extensions as text", () => {
		expect(classifyFileByExtension("logo.png")).toBe("binary")
	})

	it("accepts ambiguous .mts with UTF-8 source containing special characters", () => {
		expect(classifyFileByExtension("i18n.mts")).toBe("ambiguous")
		expect(isContentText("const messages = { ja: 'こんにちは', fr: 'Bonjour' }\n")).toBe(true)
	})

	it("rejects unknown extension null-byte file", () => {
		expect(classifyFileByExtension("dump.heapsnapshot")).toBe("ambiguous")
		const manyNulls = "\x00".repeat(500)
		expect(isContentText(manyNulls)).toBe(false)
	})
})
