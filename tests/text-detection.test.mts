import { describe, expect, it } from "bun:test"
import { isBinaryExtension, isContentText } from "../source/text-detection.mts"

describe("isBinaryExtension", () => {
	it("returns true for image extensions", () => {
		expect(isBinaryExtension("logo.png")).toBe(true)
		expect(isBinaryExtension("photo.jpg")).toBe(true)
		expect(isBinaryExtension("photo.jpeg")).toBe(true)
		expect(isBinaryExtension("icon.gif")).toBe(true)
		expect(isBinaryExtension("sprite.webp")).toBe(true)
	})

	it("returns true for archive extensions", () => {
		expect(isBinaryExtension("archive.zip")).toBe(true)
		expect(isBinaryExtension("backup.tar")).toBe(true)
		expect(isBinaryExtension("package.gz")).toBe(true)
		expect(isBinaryExtension("data.7z")).toBe(true)
	})

	it("returns true for executable/binary extensions", () => {
		expect(isBinaryExtension("app.exe")).toBe(true)
		expect(isBinaryExtension("lib.dll")).toBe(true)
		expect(isBinaryExtension("lib.so")).toBe(true)
		expect(isBinaryExtension("App.class")).toBe(true)
		expect(isBinaryExtension("app.node")).toBe(true)
	})

	it("returns true for font extensions", () => {
		expect(isBinaryExtension("font.woff")).toBe(true)
		expect(isBinaryExtension("font.woff2")).toBe(true)
		expect(isBinaryExtension("font.ttf")).toBe(true)
	})

	it("returns true for document extensions", () => {
		expect(isBinaryExtension("doc.pdf")).toBe(true)
		expect(isBinaryExtension("sheet.xlsx")).toBe(true)
	})

	it("returns false for common text extensions", () => {
		expect(isBinaryExtension("index.ts")).toBe(false)
		expect(isBinaryExtension("app.js")).toBe(false)
		expect(isBinaryExtension("style.css")).toBe(false)
		expect(isBinaryExtension("README.md")).toBe(false)
		expect(isBinaryExtension("config.json")).toBe(false)
		expect(isBinaryExtension("config.yaml")).toBe(false)
		expect(isBinaryExtension("Dockerfile")).toBe(false)
		expect(isBinaryExtension("package.json")).toBe(false)
	})

	it("returns false for dotfiles", () => {
		expect(isBinaryExtension(".gitignore")).toBe(false)
		expect(isBinaryExtension(".eslintrc")).toBe(false)
	})

	it("returns false for .mts files", () => {
		expect(isBinaryExtension("module.mts")).toBe(false)
	})

	it("returns false for unknown extensions", () => {
		expect(isBinaryExtension("data.xyz")).toBe(false)
	})

	it("is case-insensitive for extensions", () => {
		expect(isBinaryExtension("logo.PNG")).toBe(true)
		expect(isBinaryExtension("archive.ZIP")).toBe(true)
	})
})

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
