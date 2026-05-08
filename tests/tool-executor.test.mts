import { describe, it, expect } from "bun:test"
import { createToolExecutor } from "../source/tool-executor.mts"
import { makeSpawnGit, ok, error } from "./helpers.mts"

describe("createToolExecutor", () => {
	describe("definitions", () => {
	it("includes read_file tool definition", () => {
		const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
		expect(executor.definitions.some(d => d.function.name === "read_file")).toBe(true)
	})

	it("includes search_files tool definition", () => {
		const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
		expect(executor.definitions.some(d => d.function.name === "search_files")).toBe(true)
	})

	it("describes read_file as reading from base commit", () => {
		const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
		const readFile = executor.definitions.find(d => d.function.name === "read_file")
		expect(readFile!.function.description).toContain("base commit")
	})

	it("describes search_files as searching the base commit", () => {
		const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
		const searchFiles = executor.definitions.find(d => d.function.name === "search_files")
		expect(searchFiles!.function.description).toContain("base commit")
	})
	})

	describe("execute read_file", () => {
		it("returns full file contents when no line range specified", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts"}' })
			expect(result.toolCallId).toBe("call_1")
			expect(result.content).toBe('line1\nline2\nline3\n')
		})

		it("returns file contents with start_line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts","start_line":2}' })
			expect(result.content).toBe('Lines 2-3 of src/index.ts:\nline2\nline3')
		})

		it("returns file contents with start_line and end_line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\nline4\nline5\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts","start_line":2,"end_line":4}' })
			expect(result.content).toBe('Lines 2-4 of src/index.ts:\nline2\nline3\nline4')
		})

		it("returns single line when start_line equals end_line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts","start_line":2,"end_line":2}' })
			expect(result.content).toBe('Lines 2-2 of src/index.ts:\nline2')
		})

		it("returns from start_line to end of file when end_line exceeds file length", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts","start_line":2,"end_line":100}' })
			expect(result.content).toBe('Lines 2-3 of src/index.ts:\nline2\nline3')
		})

		it("returns error when start_line is past end of file", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts","start_line":10}' })
			expect(result.content).toContain("has 2 lines")
			expect(result.content).toContain("start_line 10 is past the end")
		})

		it("returns from line 1 to end_line when only end_line specified", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\nline4\n')],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"src/index.ts","end_line":2}' })
			expect(result.content).toBe('Lines 1-2 of src/index.ts:\nline1\nline2')
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

		it("returns error when start_line is zero", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_8", name: "read_file", arguments: '{"path":"file.ts","start_line":0}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error when start_line is negative", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_8", name: "read_file", arguments: '{"path":"file.ts","start_line":-1}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error when start_line is not an integer", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_8", name: "read_file", arguments: '{"path":"file.ts","start_line":1.5}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error when end_line is less than start_line", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_8", name: "read_file", arguments: '{"path":"file.ts","start_line":5,"end_line":3}' })
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

		it("handles single line file with line range", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:single.txt", ok("only line\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"single.txt","start_line":1}' })
			expect(result.content).toBe('Lines 1-1 of single.txt:\nonly line')
		})

		it("handles empty file with line range", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:empty.txt", ok("")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_1", name: "read_file", arguments: '{"path":"empty.txt","start_line":1}' })
			expect(result.content).toContain("has 0 lines")
		})
	})

	describe("execute search_files", () => {
		it("returns matching file paths, line numbers, and content", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e TODO abc123", ok("src/index.ts:10:TODO: fix this\nsrc/util.ts:5:TODO: refactor\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_10", name: "search_files", arguments: '{"pattern":"TODO"}' })
			expect(result.toolCallId).toBe("call_10")
			expect(result.content).toBe("src/index.ts:10:TODO: fix this\nsrc/util.ts:5:TODO: refactor")
		})

		it("returns no matches message when git grep exits with 1", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e nonexistent abc123", error("")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_11", name: "search_files", arguments: '{"pattern":"nonexistent"}' })
			expect(result.content).toBe("No matches found.")
		})

		it("includes path parameter when provided", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e TODO abc123 -- src/", ok("src/main.ts:1:TODO: implement\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_12", name: "search_files", arguments: '{"pattern":"TODO","path":"src/"}' })
			expect(result.content).toBe("src/main.ts:1:TODO: implement")
		})

		it("omits path parameter when path is empty string", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e TODO abc123", ok("src/main.ts:1:TODO: implement\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_13", name: "search_files", arguments: '{"pattern":"TODO","path":""}' })
			expect(result.content).toBe("src/main.ts:1:TODO: implement")
		})

		it("returns error for invalid JSON arguments", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_14", name: "search_files", arguments: "not json" })
			expect(result.content).toContain("Invalid JSON")
		})

		it("returns error when pattern is missing from arguments", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_15", name: "search_files", arguments: '{}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error when pattern is empty string", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_16", name: "search_files", arguments: '{"pattern":""}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns error when path is not a string", async () => {
			const executor = createToolExecutor({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const result = await executor.execute({ id: "call_17", name: "search_files", arguments: '{"pattern":"TODO","path":123}' })
			expect(result.content).toContain("Invalid arguments")
		})

		it("returns search failed message when git grep exits with error", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e [invalid abc123", { stdout: "", stderr: "fatal: invalid regex", exitCode: 128, signalCode: null }],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_18", name: "search_files", arguments: '{"pattern":"[invalid"}' })
			expect(result.content).toContain("Search failed")
		})

		it("truncates results when more than 50 matches", async () => {
			const lines = Array.from({ length: 60 }, (_, i) => `file.ts:${i + 1}:match content`).join("\n")
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e match abc123", ok(lines + "\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_19", name: "search_files", arguments: '{"pattern":"match"}' })
			expect(result.content).toContain("Showing 50 of 60 matches")
		})

		it("handles single match", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e unique abc123", ok("config.json:7:unique_value\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_20", name: "search_files", arguments: '{"pattern":"unique"}' })
			expect(result.content).toBe("config.json:7:unique_value")
		})

		it("handles colons in matched content", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -e key abc123", ok("config.ts:3:const key: string = 'value'\n")],
			]))
			const executor = createToolExecutor({ spawnGit }, "abc123")
			const result = await executor.execute({ id: "call_21", name: "search_files", arguments: '{"pattern":"key"}' })
			expect(result.content).toBe("config.ts:3:const key: string = 'value'")
		})
	})
})
