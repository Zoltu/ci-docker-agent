import { describe, it, expect } from "bun:test"
import { createTools } from "../source/tool-executor.mts"
import type { Tool } from "../source/agent-loop.mts"
import { makeSpawnGit, ok, error } from "./helpers.mts"

const NUL = "\u0000"

function getTool(tools: Tool[], name: string): Tool {
	const tool = tools.find(t => t.name === name)
	if (!tool) throw new Error(`Tool ${name} not found`)
	return tool
}

describe("createTools", () => {
	describe("tool definitions", () => {
		it("includes read_file tool", () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = tools.find(t => t.name === "read_file")
			if (!readFile) throw new Error("read_file not found")
			expect(readFile.name).toBe("read_file")
		})

		it("includes search_files tool", () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const searchFiles = tools.find(t => t.name === "search_files")
			if (!searchFiles) throw new Error("search_files not found")
			expect(searchFiles.name).toBe("search_files")
		})

		it("describes read_file as reading from base commit", () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			if (!readFile.description) throw new Error("No description")
			expect(readFile.description).toContain("base commit")
		})

		it("describes search_files as searching the base commit", () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			if (!searchFiles.description) throw new Error("No description")
			expect(searchFiles.description).toContain("base commit")
		})
	})

	describe("read_file execute", () => {
		it("returns full file contents when no line range specified", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts"}')
			expect(result).toBe('line1\nline2\nline3\n')
		})

		it("returns file contents with start_line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts","start_line":2}')
			expect(result).toBe('Lines 2-3 of src/index.ts:\nline2\nline3')
		})

		it("returns file contents with start_line and end_line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\nline4\nline5\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts","start_line":2,"end_line":4}')
			expect(result).toBe('Lines 2-4 of src/index.ts:\nline2\nline3\nline4')
		})

		it("returns single line when start_line equals end_line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts","start_line":2,"end_line":2}')
			expect(result).toBe('Lines 2-2 of src/index.ts:\nline2')
		})

		it("returns from start_line to end of file when end_line exceeds file length", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts","start_line":2,"end_line":100}')
			expect(result).toBe('Lines 2-3 of src/index.ts:\nline2\nline3')
		})

		it("returns error when start_line is past end of file", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts","start_line":10}')
			expect(result).toContain("has 2 lines")
			expect(result).toContain("start_line 10 is past the end")
		})

		it("returns from line 1 to end_line when only end_line specified", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:src/index.ts", ok('line1\nline2\nline3\nline4\n')],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"src/index.ts","end_line":2}')
			expect(result).toBe('Lines 1-2 of src/index.ts:\nline1\nline2')
		})

		it("returns error for non-existent file", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:missing.ts", error("fatal: Path does not exist")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"missing.ts"}')
			expect(result).toBe("File not found: missing.ts")
		})

		it("returns error for binary files by extension", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"image.png"}')
			expect(result).toBe("File is binary and cannot be displayed: image.png")
		})

		it("returns error for binary content even without binary extension", async () => {
			const binaryContent = "\x00\x00\x00\x00ftypisom"
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:video.mts", ok(binaryContent)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"video.mts"}')
			expect(result).toBe("File is binary and cannot be displayed: video.mts")
		})

		it("returns error for invalid JSON arguments", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute("not json")
			expect(result).toContain("Invalid JSON")
		})

		it("returns error when path is missing from arguments", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when path is empty string", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":""}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when start_line is zero", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"file.ts","start_line":0}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when start_line is negative", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"file.ts","start_line":-1}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when start_line is not an integer", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"file.ts","start_line":1.5}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when end_line is less than start_line", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"file.ts","start_line":5,"end_line":3}')
			expect(result).toContain("Invalid arguments")
		})

		it("reads dotfiles correctly", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:.gitignore", ok("node_modules/\n")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":".gitignore"}')
			expect(result).toBe("node_modules/\n")
		})

		it("handles single line file with line range", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:single.txt", ok("only line\n")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"single.txt","start_line":1}')
			expect(result).toBe('Lines 1-1 of single.txt:\nonly line')
		})

		it("handles empty file with line range", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["show abc123:empty.txt", ok("")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const readFile = getTool(tools, "read_file")
			const result = await readFile.execute('{"path":"empty.txt","start_line":1}')
			expect(result).toContain("has 0 lines")
		})
	})

	describe("search_files execute", () => {
		it("returns matching file paths, line numbers, and content", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:src/index.ts${NUL}10${NUL}TODO: fix this\nabc123:src/util.ts${NUL}5${NUL}TODO: refactor\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("src/index.ts:10:TODO: fix this\nsrc/util.ts:5:TODO: refactor")
		})

		it("returns no matches message when git grep exits with 1", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e nonexistent abc123", error("")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"nonexistent"}')
			expect(result).toBe("No matches found.")
		})

		it("includes path parameter when provided", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123 -- src/", ok(`abc123:src/main.ts${NUL}1${NUL}TODO: implement\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO","path":"src/"}')
			expect(result).toBe("src/main.ts:1:TODO: implement")
		})

		it("omits path parameter when path is empty string", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:src/main.ts${NUL}1${NUL}TODO: implement\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO","path":""}')
			expect(result).toBe("src/main.ts:1:TODO: implement")
		})

		it("returns error for invalid JSON arguments", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute("not json")
			expect(result).toContain("Invalid JSON")
		})

		it("returns error when pattern is missing from arguments", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when pattern is empty string", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":""}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns error when path is not a string", async () => {
			const tools = createTools({ spawnGit: makeSpawnGit(new Map()) }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO","path":123}')
			expect(result).toContain("Invalid arguments")
		})

		it("returns search failed message when git grep exits with error", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e [invalid abc123", { stdout: "", stderr: "fatal: invalid regex", exitCode: 128, signalCode: null }],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"[invalid"}')
			expect(result).toContain("Search failed")
		})

		it("truncates results when more than 50 matches", async () => {
			const lines = Array.from({ length: 60 }, (_, i) => `abc123:file.ts${NUL}${i + 1}${NUL}match content`).join("\n")
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e match abc123", ok(lines + "\n")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"match"}')
			expect(result).toContain("Showing 50 of 60 matches")
		})

		it("handles single match", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e unique abc123", ok(`abc123:config.json${NUL}7${NUL}unique_value\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"unique"}')
			expect(result).toBe("config.json:7:unique_value")
		})

		it("handles colons in matched content", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e key abc123", ok(`abc123:config.ts${NUL}3${NUL}const key: string = 'value'\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"key"}')
			expect(result).toBe("config.ts:3:const key: string = 'value'")
		})

		it("strips the tree-ish prefix from git grep output for a full-length base SHA", async () => {
			const fullSha = "0283c9542b982059b075745b00f8df9e7e55e07b"
			const spawnGit = makeSpawnGit(new Map([
				[`grep -n -E -I -z --color=never -e TODO ${fullSha}`, ok(`${fullSha}:src/index.ts${NUL}42${NUL}TODO: real output\n`)],
			]))
			const tools = createTools({ spawnGit }, fullSha)
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("src/index.ts:42:TODO: real output")
		})

		it("strips a non-sha tree-ish prefix such as HEAD", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO HEAD", ok(`HEAD:src/index.ts${NUL}8${NUL}TODO: from HEAD\n`)],
			]))
			const tools = createTools({ spawnGit }, "HEAD")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("src/index.ts:8:TODO: from HEAD")
		})

		it("returns no matches message for empty stdout with exit code 0", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok("")],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("No matches found.")
		})

		it("handles colons in file paths", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:we:ird.txt${NUL}10${NUL}matched\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("we:ird.txt:10:matched")
		})

		it("handles a file path containing a newline", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:we\nird.txt${NUL}10${NUL}matched\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("we\nird.txt:10:matched")
		})

		it("handles an empty matched line", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:file.ts${NUL}5${NUL}\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("file.ts:5:")
		})

		it("handles multiple records where a later path contains a newline", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:a.txt${NUL}1${NUL}first\nabc123:we\nird.txt${NUL}2${NUL}second\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			const result = await searchFiles.execute('{"pattern":"TODO"}')
			expect(result).toBe("a.txt:1:first\nwe\nird.txt:2:second")
		})

		it("throws when a git grep record is missing the tree-ish prefix", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`src/index.ts${NUL}10${NUL}content\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			expect(searchFiles.execute('{"pattern":"TODO"}')).rejects.toThrow('missing "abc123:" prefix')
		})

		it("throws when a git grep record is missing the content separator", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:src/index.ts${NUL}10\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			expect(searchFiles.execute('{"pattern":"TODO"}')).rejects.toThrow("content separator")
		})

		it("throws when a git grep record is missing the line-number separator", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:src/index.ts\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			expect(searchFiles.execute('{"pattern":"TODO"}')).rejects.toThrow("line-number separator")
		})

		it("throws when git grep content contains a NUL", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:file.ts${NUL}5${NUL}a${NUL}b\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			expect(searchFiles.execute('{"pattern":"TODO"}')).rejects.toThrow("NUL")
		})

		it("throws when a git grep record has a non-integer line number", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:src/index.ts${NUL}abc${NUL}content\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			expect(searchFiles.execute('{"pattern":"TODO"}')).rejects.toThrow("line number")
		})

		it("throws when a git grep record has an empty path", async () => {
			const spawnGit = makeSpawnGit(new Map([
				["grep -n -E -I -z --color=never -e TODO abc123", ok(`abc123:${NUL}10${NUL}content\n`)],
			]))
			const tools = createTools({ spawnGit }, "abc123")
			const searchFiles = getTool(tools, "search_files")
			expect(searchFiles.execute('{"pattern":"TODO"}')).rejects.toThrow("empty path")
		})
	})
})
