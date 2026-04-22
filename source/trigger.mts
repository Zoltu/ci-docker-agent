export type CommentTriggerResult = string[] | "run all agents" | "no review triggered"

export function getAgentsFromComment(commentBody: string | null): CommentTriggerResult {
	if (!commentBody) return "no review triggered"

	const match = /^\/review\s*(.*)/m.exec(commentBody)
	if (!match) return "no review triggered"

	const agentNames = parseAgentList(match[1]!.trim())
	if (agentNames.length === 0) return "run all agents"

	return agentNames
}

function parseAgentList(rest: string): string[] {
	if (rest.length === 0) return []

	return rest.split(",").map(n => n.trim()).filter(n => n.length > 0)
}
