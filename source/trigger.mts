const TRIGGER_COMMANDS = ["/ci", "/check", "/test"] as const

export function shouldRunCI(eventType: string, commentBody: string | null): boolean {
	if (eventType === "pull_request_target") {
		return true
	}

	if (eventType === "issue_comment" && commentBody) {
		return TRIGGER_COMMANDS.some(command => commentBody.includes(command))
	}

	// For local-diff mode, always run
	if (eventType === "unknown") {
		return true
	}

	return false
}
