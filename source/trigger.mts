const TRIGGER_COMMAND = "/review" as const

export interface TriggerResult {
	shouldRun: boolean
	agentNames: string[]
}

export function shouldRunCI(eventType: string, commentBody: string | null): TriggerResult {
	if (eventType === "pull_request_target") {
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

function extractAgentNames(commentBody: string): string[] {
	const agentNames: string[] = []

	// Find agent names after trigger command: /review agent1, agent2
	const commandMatch = commentBody.match(new RegExp(`${TRIGGER_COMMAND}\\s+(.+)$`, "m"))
	if (commandMatch?.[1]) {
		// Get the rest of the line after the command
		const rest = commandMatch[1].trim()
		// Split by comma and trim whitespace
		const names = rest.split(",").map(n => n.trim()).filter(n => n.length > 0)
		agentNames.push(...names)
	}

	return agentNames
}
