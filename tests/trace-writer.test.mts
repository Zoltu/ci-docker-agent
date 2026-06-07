import { describe, expect, it } from "bun:test"
import { createTraceWriter } from "../source/trace-writer.mts"
import type { DebugWriter } from "../source/debug.mts"

function captureWriter(agentName = "TestAgent"): { writer: ReturnType<typeof createTraceWriter>; chunks: string[]; agentNames: string[] } {
	const chunks: string[] = []
	const agentNames: string[] = []
	const debugWriter: DebugWriter = {
		writePrompt: async () => {},
		writeTrace: async (name, text) => {
			chunks.push(text)
			agentNames.push(name)
		},
	}
	return { writer: createTraceWriter(debugWriter, agentName), chunks, agentNames }
}

async function capture(setup: (writer: ReturnType<typeof createTraceWriter>) => Promise<void>): Promise<{ text: string; agentNames: string[] }> {
	const { writer, chunks, agentNames } = captureWriter()
	await setup(writer)
	return { text: chunks.join(""), agentNames }
}

describe("createTraceWriter", () => {
	describe("delta", () => {
		it("emits a Reasoning header and the reasoning text for a single reasoning delta", async () => {
			const { text } = await capture(async w => {
				await w.delta("reasoning text", undefined)
			})
			expect(text).toBe("# Reasoning\n\nreasoning text")
		})

		it("emits a Content header and the content text for a single content delta", async () => {
			const { text } = await capture(async w => {
				await w.delta(undefined, "content text")
			})
			expect(text).toBe("# Content\n\ncontent text")
		})

		it("emits reasoning then content with a separator when both arrive in the same call", async () => {
			const { text } = await capture(async w => {
				await w.delta("r", "c")
			})
			expect(text).toBe("# Reasoning\n\nr\n\n# Content\n\nc")
		})

		it("concatenates successive reasoning deltas under a single header", async () => {
			const { text } = await capture(async w => {
				await w.delta("hello ", undefined)
				await w.delta("world", undefined)
			})
			expect(text).toBe("# Reasoning\n\nhello world")
		})

		it("concatenates successive content deltas under a single header", async () => {
			const { text } = await capture(async w => {
				await w.delta(undefined, "hello ")
				await w.delta(undefined, "world")
			})
			expect(text).toBe("# Content\n\nhello world")
		})

		it("closes reasoning and reopens it on a reasoning->content->reasoning sequence", async () => {
			const { text } = await capture(async w => {
				await w.delta("r1", undefined)
				await w.delta(undefined, "c")
				await w.delta("r2", undefined)
			})
			expect(text).toBe("# Reasoning\n\nr1\n\n# Content\n\nc\n\n# Reasoning\n\nr2")
		})

		it("closes content and reopens it on a content->reasoning->content sequence", async () => {
			const { text } = await capture(async w => {
				await w.delta(undefined, "c1")
				await w.delta("r", undefined)
				await w.delta(undefined, "c2")
			})
			expect(text).toBe("# Content\n\nc1\n\n# Reasoning\n\nr\n\n# Content\n\nc2")
		})

		it("emits nothing when both reasoning and content are undefined", async () => {
			const { text } = await capture(async w => {
				await w.delta(undefined, undefined)
			})
			expect(text).toBe("")
		})

		it("emits nothing when both reasoning and content are empty strings", async () => {
			const { text } = await capture(async w => {
				await w.delta("", "")
			})
			expect(text).toBe("")
		})

		it("emits only the reasoning side when content is undefined and reasoning is non-empty", async () => {
			const { text } = await capture(async w => {
				await w.delta("r", "")
			})
			expect(text).toBe("# Reasoning\n\nr")
		})
	})

	describe("toolCall", () => {
		it("emits a tool call block with the name and arguments", async () => {
			const { text } = await capture(async w => {
				await w.toolCall("read_file", '{"path":"a.ts"}')
			})
			expect(text).toBe('# Tool Call: read_file\n\n{"path":"a.ts"}\n\n')
		})

		it("emits a tool call block even when a section is open, without closing the section", async () => {
			const { text } = await capture(async w => {
				await w.delta("r", undefined)
				await w.toolCall("search", "args")
			})
			expect(text).toBe('# Reasoning\n\nr# Tool Call: search\n\nargs\n\n')
		})
	})

	describe("toolResult", () => {
		it("emits a tool result block with the name and result", async () => {
			const { text } = await capture(async w => {
				await w.toolResult("read_file", "file contents")
			})
			expect(text).toBe('# Tool Result: read_file\n\nfile contents\n\n')
		})
	})

	describe("completion", () => {
		it("emits the finish_reason comment when finishReason is provided", async () => {
			const { text } = await capture(async w => {
				await w.completion("stop")
			})
			expect(text).toBe('<!-- finish_reason: stop -->\n')
		})

		it("emits no output when finishReason is undefined and no section is open", async () => {
			const { text } = await capture(async w => {
				await w.completion(undefined)
			})
			expect(text).toBe("")
		})

		it("closes the open section with a blank line before the finish_reason comment", async () => {
			const { text } = await capture(async w => {
				await w.delta("r", undefined)
				await w.completion("stop")
			})
			expect(text).toBe('# Reasoning\n\nr\n\n<!-- finish_reason: stop -->\n')
		})

		it("closes the open content section before the finish_reason comment", async () => {
			const { text } = await capture(async w => {
				await w.delta(undefined, "c")
				await w.completion("stop")
			})
			expect(text).toBe('# Content\n\nc\n\n<!-- finish_reason: stop -->\n')
		})

		it("emits only the finish_reason comment (no leading blank line) when called after toolCall", async () => {
			const { text } = await capture(async w => {
				await w.toolCall("read_file", "args")
				await w.completion("stop")
			})
			expect(text).toBe('# Tool Call: read_file\n\nargs\n\n<!-- finish_reason: stop -->\n')
		})

		it("emits only the close when finishReason is undefined and a section is open", async () => {
			const { text } = await capture(async w => {
				await w.delta("r", undefined)
				await w.completion(undefined)
			})
			expect(text).toBe('# Reasoning\n\nr\n\n')
		})

		it("emits only the close (no double blank line) when both sections are open and finishReason is undefined", async () => {
			const { text } = await capture(async w => {
				await w.delta("r1", undefined)
				await w.delta(undefined, "c1")
				await w.completion(undefined)
			})
			expect(text).toBe('# Reasoning\n\nr1\n\n# Content\n\nc1\n\n')
		})
	})

	describe("end-to-end", () => {
		it("produces the expected markdown for a realistic event sequence", async () => {
			const { text } = await capture(async w => {
				await w.delta("Let me think", undefined)
				await w.delta(undefined, "The answer is 42")
				await w.toolCall("read_file", '{"path":"a.ts"}')
				await w.toolResult("read_file", "file contents")
				await w.completion("stop")
			})
			expect(text).toBe(
				'# Reasoning\n\nLet me think' +
				'\n\n# Content\n\nThe answer is 42' +
				'# Tool Call: read_file\n\n{"path":"a.ts"}\n\n' +
				'# Tool Result: read_file\n\nfile contents\n\n' +
				'\n\n' +
				'<!-- finish_reason: stop -->\n',
			)
		})
	})

	describe("agentName", () => {
		it("forwards the agentName to every writeTrace call", async () => {
			const { writer, agentNames } = captureWriter("CustomAgent")
			await writer.delta("r", undefined)
			await writer.toolCall("f", "a")
			await writer.toolResult("f", "r")
			await writer.completion("stop")
			expect(agentNames).toEqual(["CustomAgent", "CustomAgent", "CustomAgent", "CustomAgent", "CustomAgent", "CustomAgent"])
		})
	})
})
