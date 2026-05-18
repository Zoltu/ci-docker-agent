import { describe, it, expect } from "bun:test"
import { readSseStream, type SseEvent, type Fetch } from "../source/sse.mts"
import { createMockFetch } from "./helpers.mts"

function createChunkedMockFetch(chunks: string[]): Fetch {
	return async () => {
		const encoder = new TextEncoder()
		let index = 0
		const stream = new ReadableStream({
			pull(controller) {
				if (index >= chunks.length) {
					controller.close()
					return
				}
				controller.enqueue(encoder.encode(chunks[index]))
				index++
			}
		})
		return new Response(stream, { status: 200 })
	}
}

async function collectEvents(stream: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
	const events: SseEvent[] = []
	for await (const event of stream) {
		events.push(event)
	}
	return events
}

describe("readSseStream", () => {
	it("yields single data event", async () => {
		const fetch = createMockFetch("data: hello\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([{ event: "message", data: "hello" }])
	})

	it("yields multiple events", async () => {
		const fetch = createMockFetch("data: first\n\ndata: second\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([
			{ event: "message", data: "first" },
			{ event: "message", data: "second" },
		])
	})

	it("multi-line data event", async () => {
		const fetch = createMockFetch("data: line1\ndata: line2\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([{ event: "message", data: "line1\nline2" }])
	})

	it("named event", async () => {
		const fetch = createMockFetch('event: ping\ndata: {"time":"12:00"}\n\n')
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([{ event: "ping", data: '{"time":"12:00"}' }])
	})

	it("default event is message", async () => {
		const fetch = createMockFetch("data: hello\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events[0]).toEqual({ event: "message", data: "hello" })
	})

	it("comment lines are ignored", async () => {
		const fetch = createMockFetch(": this is a comment\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([])
	})

	it("unknown fields are ignored", async () => {
		const fetch = createMockFetch("foo: bar\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([])
	})

	it("events with no data are not yielded", async () => {
		const fetch = createMockFetch("event: ping\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([])
	})

	it("space stripping after colon", async () => {
		const fetch = createMockFetch("data:  hello\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([{ event: "message", data: " hello" }])
	})

	it("no space after colon", async () => {
		const fetch = createMockFetch("data:hello\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([{ event: "message", data: "hello" }])
	})

	it("POST request when body is provided", async () => {
		let capturedMethod: string | undefined
		let capturedBody: BodyInit | null | undefined
		const fetch: Fetch = async (_url, init) => {
			capturedMethod = init?.method
			capturedBody = init?.body
			return new Response(new ReadableStream({ start(c) { c.close() } }), { status: 200 })
		}
		const stream = readSseStream({ fetch }, "https://example.com/events", { body: "test body" })
		await collectEvents(stream)
		expect(capturedMethod).toBe("POST")
		if (typeof capturedBody !== "string") throw new Error("Expected string body")
		expect(capturedBody).toBe("test body")
	})

	it("GET request when no body", async () => {
		let capturedMethod: string | undefined
		const fetch: Fetch = async (_url, init) => {
			capturedMethod = init?.method
			return new Response(new ReadableStream({ start(c) { c.close() } }), { status: 200 })
		}
		const stream = readSseStream({ fetch }, "https://example.com/events")
		await collectEvents(stream)
		expect(capturedMethod).toBe("GET")
	})

	it("headers are passed through", async () => {
		let capturedInit: RequestInit | undefined
		const fetch: Fetch = async (_url, init) => {
			capturedInit = init
			return new Response(new ReadableStream({ start(c) { c.close() } }), { status: 200 })
		}
		const stream = readSseStream({ fetch }, "https://example.com/events", {
			headers: { "Authorization": "Bearer token123" },
		})
		await collectEvents(stream)
		const headers = capturedInit?.headers
		if (!headers) throw new Error("Expected headers")
		expect(new Headers(headers).get("Authorization")).toBe("Bearer token123")
	})

	it("signal is passed through", async () => {
		const controller = new AbortController()
		let capturedSignal: AbortSignal | null | undefined
		const fetch: Fetch = async (_url, init) => {
			capturedSignal = init?.signal
			return new Response(new ReadableStream({ start(c) { c.close() } }), { status: 200 })
		}
		const stream = readSseStream({ fetch }, "https://example.com/events", {
			signal: controller.signal,
		})
		await collectEvents(stream)
		if (!capturedSignal) throw new Error("Expected signal")
		expect(capturedSignal).toBe(controller.signal)
	})

	it("throws on non-OK status", async () => {
		const fetch: Fetch = async () => {
			return new Response("Access denied", { status: 403, statusText: "Forbidden" })
		}
		const stream = readSseStream({ fetch }, "https://example.com/events")
		expect(collectEvents(stream)).rejects.toThrow(/HTTP 403 Forbidden[\s\S]*Access denied/)
	})

	it("throws on null response body", async () => {
		const fetch: Fetch = async () => {
			return new Response(null, { status: 200 })
		}
		const stream = readSseStream({ fetch }, "https://example.com/events")
		expect(collectEvents(stream)).rejects.toThrow("Response body is null")
	})

	it("chunk boundary handling", async () => {
		const fetch = createChunkedMockFetch(["data: hel", "lo\n\ndata: world\n\n"])
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([
			{ event: "message", data: "hello" },
			{ event: "message", data: "world" },
		])
	})

	it("partial line at end of chunk", async () => {
		const fetch = createChunkedMockFetch(["data: hello", "\n\ndata: world\n\n"])
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([
			{ event: "message", data: "hello" },
			{ event: "message", data: "world" },
		])
	})

	it("stream ending without trailing blank lines discards incomplete event", async () => {
		const fetch = createMockFetch("data: hello")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([])
	})

	it("stream ending with trailing blank lines", async () => {
		const fetch = createMockFetch("data: hello\n\n")
		const stream = readSseStream({ fetch }, "https://example.com/events")
		const events = await collectEvents(stream)
		expect(events).toEqual([{ event: "message", data: "hello" }])
	})

	it("reader cleanup on early break", async () => {
		let cancelled = false
		const fetch: Fetch = async () => {
			const encoder = new TextEncoder()
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("data: first\n\n"))
				},
				pull() {},
				cancel() {
					cancelled = true
				}
			})
			return new Response(stream, { status: 200 })
		}
		const sseStream = readSseStream({ fetch }, "https://example.com/events")
		const events: SseEvent[] = []
		for await (const event of sseStream) {
			events.push(event)
			break
		}
		expect(events).toEqual([{ event: "message", data: "first" }])
		expect(cancelled).toBe(true)
	})

	describe("line ending variants", () => {
		it("CRLF line endings", async () => {
			const fetch = createMockFetch("data: hello\r\n\r\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})

		it("CR-only line endings", async () => {
			const fetch = createMockFetch("data: hello\r\r")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})

		it("mixed line endings", async () => {
			const fetch = createMockFetch("data: first\r\n\r\ndata: second\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "message", data: "first" },
				{ event: "message", data: "second" },
			])
		})

		it("CRLF at chunk boundary", async () => {
			const fetch = createChunkedMockFetch(["data: hello\r", "\n\ndata: world\n\n"])
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "message", data: "hello" },
				{ event: "message", data: "world" },
			])
		})

		it("standalone CR at chunk boundary", async () => {
			const fetch = createChunkedMockFetch(["data: hello\r", "data: world\n\n"])
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello\nworld" }])
		})
	})

	describe("BOM handling", () => {
		it("strips leading UTF-8 BOM", async () => {
			const fetch = createMockFetch("\uFEFFdata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})

		it("does not strip BOM in middle of stream", async () => {
			const fetch = createMockFetch("data: hello\uFEFFworld\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello\uFEFFworld" }])
		})

		it("strips BOM across chunk boundary", async () => {
			const fetch = createChunkedMockFetch(["\uFEFF", "data: hello\n\n"])
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})
	})

	describe("data field variants", () => {
		it("bare data keyword with no colon produces empty string value", async () => {
			const fetch = createMockFetch("data\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "" }])
		})

		it("data: with colon but no value produces empty string", async () => {
			const fetch = createMockFetch("data:\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "" }])
		})

		it("data: with space only produces empty string", async () => {
			const fetch = createMockFetch("data: \n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "" }])
		})

		it("colon in data value is preserved", async () => {
			const fetch = createMockFetch("data: time: 12:00\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "time: 12:00" }])
		})

		it("spec example: data fields with empty values", async () => {
			const fetch = createMockFetch("data\n\ndata\ndata\n\ndata:\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "message", data: "" },
				{ event: "message", data: "\n" },
				{ event: "message", data: "" },
			])
		})
	})

	describe("event field variants", () => {
		it("multiple event fields in same block: last one wins", async () => {
			const fetch = createMockFetch("event: first\nevent: second\ndata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "second", data: "hello" }])
		})

		it("event type resets to message after named event", async () => {
			const fetch = createMockFetch("event: custom\ndata: first\n\ndata: second\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "custom", data: "first" },
				{ event: "message", data: "second" },
			])
		})

		it("bare event keyword with no colon resets to message", async () => {
			const fetch = createMockFetch("event: custom\ndata: first\n\nevent\ndata: second\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "custom", data: "first" },
				{ event: "message", data: "second" },
			])
		})

		it("event field with value message is preserved", async () => {
			const fetch = createMockFetch("event: message\ndata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})
	})

	describe("ignored fields", () => {
		it("id field is parsed without error", async () => {
			const fetch = createMockFetch("id: 42\ndata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})

		it("retry field is parsed without error", async () => {
			const fetch = createMockFetch("retry: 5000\ndata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})

		it("id field with empty value is parsed without error", async () => {
			const fetch = createMockFetch("id\ndata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})
	})

	describe("stream structure variants", () => {
		it("empty stream yields no events", async () => {
			const fetch = createMockFetch("")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([])
		})

		it("leading blank line does not produce events", async () => {
			const fetch = createMockFetch("\n\ndata: hello\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "hello" }])
		})

		it("comments between data fields in same block are ignored", async () => {
			const fetch = createMockFetch("data: line1\n: a comment\ndata: line2\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([{ event: "message", data: "line1\nline2" }])
		})

		it("comment-only block yields no events", async () => {
			const fetch = createMockFetch(": keep-alive\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([])
		})

		it("spec example: test stream with id and event fields", async () => {
			const fetch = createMockFetch(": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "message", data: "first event" },
				{ event: "message", data: "second event" },
				{ event: "message", data: " third event" },
			])
		})

		it("spec example: identical events from space handling", async () => {
			const fetch = createMockFetch("data:test\n\ndata: test\n\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([
				{ event: "message", data: "test" },
				{ event: "message", data: "test" },
			])
		})

		it("CR-only stream ending without trailing blank line discards incomplete event", async () => {
			const fetch = createMockFetch("data: hello\r")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([])
		})

		it("CRLF stream ending without trailing blank line discards incomplete event", async () => {
			const fetch = createMockFetch("data: hello\r\n")
			const stream = readSseStream({ fetch }, "https://example.com/events")
			const events = await collectEvents(stream)
			expect(events).toEqual([])
		})
	})
})
