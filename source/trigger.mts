const TRIGGER_COMMAND = "/review" as const

export interface TriggerResult {
	shouldRun: boolean
	agentNames: string[]
}

export function shouldRunCI(eventType: string, commentBody: string | null): TriggerResult {
	if (eventType === "pull_request_target" || eventType === "workflow_dispatch") {
		return { shouldRun: true, agentNames: [] }
	}

	if (eventType === "issue_comment" && commentBody) {
		if (commentBody.includes(TRIGGER_COMMAND)) {
			// Extract agent names from the comment
			// Format: /review agent1, agent2
			const agentNames = extractAgentNames(commentBody)
			return { shouldRun: true, agentNames }
		}
	}

	// For local-diff mode, always run
	if (eventType === "unknown") {
		return { shouldRun: true, agentNames: [] }
	}

	return { shouldRun: false, agentNames: [] }
}

export function extractAgentNames(commentBody: string): string[] {
	const afterCommand = commentBody.split(TRIGGER_COMMAND)[1]
	if (!afterCommand) {
		return []
	}

	const rest = afterCommand.split("\n")[0]!.trim()
	if (rest.length === 0) {
		return []
	}

	return rest.split(",").map(n => n.trim()).filter(n => n.length > 0)
}
