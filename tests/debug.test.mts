import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createDebugWriter } from "../source/debug.mts"
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("createDebugWriter", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ci-agent-debug-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("creates the debug directory if it does not exist", () => {
		const newDir = join(tempDir, "subdir", "debug")
		expect(existsSync(newDir)).toBe(false)
		createDebugWriter(newDir)
		expect(existsSync(newDir)).toBe(true)
	})

	it("writes a prompt file for an agent", () => {
		const writer = createDebugWriter(tempDir)
		writer.writePrompt("TestAgent", "Hello prompt")
		const content = readFileSync(join(tempDir, "TestAgent-prompt.md"), "utf-8")
		expect(content).toBe("Hello prompt")
	})

	it("appends content chunks to an output file", () => {
		const writer = createDebugWriter(tempDir)
		writer.writeContent("TestAgent", "chunk1")
		writer.writeContent("TestAgent", "chunk2")
		const content = readFileSync(join(tempDir, "TestAgent-output.md"), "utf-8")
		expect(content).toBe("chunk1chunk2")
	})

	it("writes separate files for different agents", () => {
		const writer = createDebugWriter(tempDir)
		writer.writePrompt("Agent1", "prompt1")
		writer.writePrompt("Agent2", "prompt2")
		writer.writeContent("Agent1", "out1")
		writer.writeContent("Agent2", "out2")

		expect(readFileSync(join(tempDir, "Agent1-prompt.md"), "utf-8")).toBe("prompt1")
		expect(readFileSync(join(tempDir, "Agent2-prompt.md"), "utf-8")).toBe("prompt2")
		expect(readFileSync(join(tempDir, "Agent1-output.md"), "utf-8")).toBe("out1")
		expect(readFileSync(join(tempDir, "Agent2-output.md"), "utf-8")).toBe("out2")
	})

	it("appends trace chunks to a trace file", () => {
		const writer = createDebugWriter(tempDir)
		writer.writeTrace("TestAgent", "step1")
		writer.writeTrace("TestAgent", "step2")
		const content = readFileSync(join(tempDir, "TestAgent-trace.md"), "utf-8")
		expect(content).toBe("step1step2")
	})

	it("writes trace to a separate file from content", () => {
		const writer = createDebugWriter(tempDir)
		writer.writeContent("TestAgent", "output")
		writer.writeTrace("TestAgent", "thinking")
		expect(readFileSync(join(tempDir, "TestAgent-output.md"), "utf-8")).toBe("output")
		expect(readFileSync(join(tempDir, "TestAgent-trace.md"), "utf-8")).toBe("thinking")
	})

	it("throws if the debug directory contains non-markdown files", () => {
		writeFileSync(join(tempDir, "important-data.json"), "{}")
		expect(() => createDebugWriter(tempDir)).toThrow(/non-markdown files/)
	})

	it("throws if the debug directory contains a subdirectory", () => {
		mkdirSync(join(tempDir, "nested"))
		expect(() => createDebugWriter(tempDir)).toThrow(/non-markdown files/)
	})

	it("clears existing markdown files from a previous run", () => {
		writeFileSync(join(tempDir, "OldAgent-prompt.md"), "old prompt")
		const writer = createDebugWriter(tempDir)
		writer.writePrompt("NewAgent", "new prompt")
		expect(existsSync(join(tempDir, "OldAgent-prompt.md"))).toBe(false)
		expect(readFileSync(join(tempDir, "NewAgent-prompt.md"), "utf-8")).toBe("new prompt")
	})
})
