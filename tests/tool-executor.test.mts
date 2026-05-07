import { describe, it, expect } from "bun:test"
import { createToolExecutor } from "../source/tool-executor.mts"
import { makeSpawnGit, ok, error } from "./helpers.mts"

describe("createToolExecutor", () => {
	describe("definitions", () => {
	it("includes read_file tool definition", () => {
		const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
		expect(executor.definitions.length).toBe(1)
		expect(executor.definitions[0]!.function.name).toBe("read_file")
	})

	it("describes read_file as reading from base commit", () => {
		const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
		expect(executor.definitions[0]!.function.description).toContain("base commit")
	})
	})

	describe("execute read_file", () => {
		it("returns file contents for a valid text file", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('export function hello() { return 42 }\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts"}' })
			expect(result.toolCallId).toBe("call_1")
			expect(result.content).toBe('export function hello() { return 42 }\n')
		})

		it("returns error for non-existent file", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:missing.ts", error("fatal: Path does not exist")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_2", name: "read_file", arguments: '{"path":"missing.ts"}' })
			expect(result.content).toBe("File not found: missing.ts")
		})

		it("returns error for binary files by extension", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_3", name: "read_file", arguments: '{"path":"image.png"}' })
			expect(result.content).toBe("File is binary and cannot be displayed: image.png")
		})

		it("returns error for binary content even without binary extension", async () => {
			const binaryContent = "\x00\x00\x00\x00ftypisom"
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:video.mts", ok(binaryContent)],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_4", name: "read_file", arguments: '{"path":"video.mts"}' })
			expect(result.content).toBe("File is binary and cannot be displayed: video.mts")
		})

		it("returns error for invalid JSON arguments", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_5", name: "read_file", arguments: "not json" })
			expect(result.content).toContain("Invalid JSON")
		})

		it("returns error when path is missing from arguments", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_6", name: "read_file", arguments: '{}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error when path is empty string", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_7", name: "read_file", arguments: '{"path":""}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error for unknown tool name", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_8", name: "unknown_tool", arguments: '{}' })
			expect(result.content).toBe("Unknown tool: unknown_tool")
		})

		it("reads dotfiles correctly", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:.gitignore", ok("node_modules/\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_9", name: "read_file", arguments: '{"path":".gitignore"}' })
			expect(result.content).toBe("node_modules/\n")
		})
	})
})
