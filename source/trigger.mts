export interface TriggerResult {
	shouldRun: boolean
	agentNames: string[]
}

export function shouldRunCI(eventType: string, commentBody: string | null): TriggerResult {
	if (eventType === "pull_request_target" || eventType === "workflow_dispatch") {
		return { shouldRun: true, agentNames: [] }
	}

	if (eventType === "issue_comment" && commentBody) {
		const match = /^\/review\s*(.*)/m.exec(commentBody)
		if (match) {
			const agentNames = parseAgentList(match[1]!.trim())
			return { shouldRun: true, agentNames }
		}
	}

	if (eventType === "unknown") {
		return { shouldRun: true, agentNames: [] }
	}

	return { shouldRun: false, agentNames: [] }
}

function parseAgentList(rest: string): string[] {
	if (rest.length === 0) {
		return []
	}

	return rest.split(",").map(n => n.trim()).filter(n => n.length > 0)
}


