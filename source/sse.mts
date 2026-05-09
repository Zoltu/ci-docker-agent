export interface SseEvent {
	event: string
	data: string
}

export interface SseRequestOptions {
	headers?: Record<string, string>
	body?: string
	signal?: AbortSignal
}

export type Fetch = (url: string, options: RequestInit) => Promise<Response>

// Intentionally does not implement retries as that adds a lot of complexity and isn't necessary for our needs at the moment
export async function* readSseStream(dependencies: { fetch: Fetch }, url: string, options?: SseRequestOptions): AsyncGenerator<SseEvent> {
	const method = options?.body ? "POST" : "GET"
	const response = await dependencies.fetch(url, { method, ...options })

	if (!response.ok) {
		const responseBody = await response.text().catch(() => "")
		throw new Error(`HTTP ${response.status} ${response.statusText}${responseBody ? `\n${responseBody}` : ""}`)
	}

	if (!response.body) throw new Error("Response body is null")

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	let dataList: string[] = []
	let eventName = ""
	let hasStrippedBom = false

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				if (buffer.length > 0) {
					buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
					const lines = buffer.split("\n")
					lines.pop()
					for (const line of lines) {
						const event = processLine(line)
						if (event) yield event
					}
				}
				return
			}
			buffer += decoder.decode(value, { stream: true })
			if (!hasStrippedBom) {
				if (buffer.startsWith("\uFEFF")) {
					buffer = buffer.slice(1)
				}
				hasStrippedBom = true
			}
			buffer = buffer.replace(/\r\n/g, "\n")
			if (buffer.endsWith("\r")) {
				buffer = buffer.slice(0, -1).replace(/\r/g, "\n") + "\r"
			} else {
				buffer = buffer.replace(/\r/g, "\n")
			}
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) {
				const event = processLine(line)
				if (event) yield event
			}
		}
	} finally {
		await reader.cancel()
		reader.releaseLock()
	}

	function processLine(line: string): SseEvent | null {
		const parsed = parseSseLine(line)
		switch (parsed.type) {
			case "blank":
				return flushEvent()
			case "data":
				dataList.push(parsed.value)
				return null
			case "event":
				eventName = parsed.value
				return null
			default:
				return null
		}
	}

	function flushEvent(): SseEvent | null {
		if (dataList.length === 0) {
			eventName = ""
			return null
		}
		const event: SseEvent = { event: eventName || "message", data: dataList.join("\n") }
		dataList = []
		eventName = ""
		return event
	}
}

type ParsedSseLine =
	| { type: "data"; value: string }
	| { type: "event"; value: string }
	| { type: "id"; value: string }
	| { type: "retry"; value: string }
	| { type: "comment" }
	| { type: "blank" }
	| { type: "ignore" }

function parseSseLine(line: string): ParsedSseLine {
	if (line === "") return { type: "blank" }
	if (line.startsWith(":")) return { type: "comment" }
	const colonIndex = line.indexOf(":")
	if (colonIndex < 0) {
		if (line === "data") return { type: "data", value: "" }
		if (line === "event") return { type: "event", value: "" }
		if (line === "id") return { type: "id", value: "" }
		if (line === "retry") return { type: "retry", value: "" }
		return { type: "ignore" }
	}
	const fieldName = line.slice(0, colonIndex)
	const value = parseFieldValue(line.slice(colonIndex + 1))
	if (fieldName === "data") return { type: "data", value }
	if (fieldName === "event") return { type: "event", value }
	if (fieldName === "id") return { type: "id", value }
	if (fieldName === "retry") return { type: "retry", value }
	return { type: "ignore" }
}

function parseFieldValue(text: string): string {
	if (text.startsWith(" ")) return text.slice(1)
	return text
}
