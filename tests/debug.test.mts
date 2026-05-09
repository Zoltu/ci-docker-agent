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

	it("writes a prompt file for an agent", async () => {
		const writer = createDebugWriter(tempDir)
		await writer.writePrompt("TestAgent", "Hello prompt")
		const content = readFileSync(join(tempDir, "TestAgent-prompt.md"), "utf-8")
		expect(content).toBe("Hello prompt")
	})

	it("appends content chunks to an output file", async () => {
		const writer = createDebugWriter(tempDir)
		await writer.writeTrace("TestAgent", "chunk1")
		await writer.writeTrace("TestAgent", "chunk2")
		const content = readFileSync(join(tempDir, "TestAgent-trace.md"), "utf-8")
		expect(content).toBe("chunk1chunk2")
	})

	it("writes separate files for different agents", async () => {
		const writer = createDebugWriter(tempDir)
		await writer.writePrompt("Agent1", "prompt1")
		await writer.writePrompt("Agent2", "prompt2")
		await writer.writeTrace("Agent1", "out1")
		await writer.writeTrace("Agent2", "out2")

		expect(readFileSync(join(tempDir, "Agent1-prompt.md"), "utf-8")).toBe("prompt1")
		expect(readFileSync(join(tempDir, "Agent2-prompt.md"), "utf-8")).toBe("prompt2")
		expect(readFileSync(join(tempDir, "Agent1-trace.md"), "utf-8")).toBe("out1")
		expect(readFileSync(join(tempDir, "Agent2-trace.md"), "utf-8")).toBe("out2")
	})

	it("appends trace chunks to a trace file", async () => {
		const writer = createDebugWriter(tempDir)
		await writer.writeTrace("TestAgent", "step1")
		await writer.writeTrace("TestAgent", "step2")
		const content = readFileSync(join(tempDir, "TestAgent-trace.md"), "utf-8")
		expect(content).toBe("step1step2")
	})

	it("writes trace to a separate file from prompt", async () => {
		const writer = createDebugWriter(tempDir)
		await writer.writeTrace("TestAgent", "output")
		await writer.writePrompt("TestAgent", "prompt text")
		expect(readFileSync(join(tempDir, "TestAgent-trace.md"), "utf-8")).toBe("output")
		expect(readFileSync(join(tempDir, "TestAgent-prompt.md"), "utf-8")).toBe("prompt text")
	})

	it("throws if the debug directory contains non-markdown files", () => {
		writeFileSync(join(tempDir, "important-data.json"), "{}")
		expect(() => createDebugWriter(tempDir)).toThrow(/non-markdown files/)
	})

	it("throws if the debug directory contains a subdirectory", () => {
		mkdirSync(join(tempDir, "nested"))
		expect(() => createDebugWriter(tempDir)).toThrow(/non-markdown files/)
	})

	it("clears existing markdown files from a previous run", async () => {
		writeFileSync(join(tempDir, "OldAgent-prompt.md"), "old prompt")
		const writer = createDebugWriter(tempDir)
		await writer.writePrompt("NewAgent", "new prompt")
		expect(existsSync(join(tempDir, "OldAgent-prompt.md"))).toBe(false)
		expect(readFileSync(join(tempDir, "NewAgent-prompt.md"), "utf-8")).toBe("new prompt")
	})
})
