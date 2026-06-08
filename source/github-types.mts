export const SIDES = ["LEFT", "RIGHT"] as const
export type Side = typeof SIDES[number]

export interface LineComment {
	path: string
	line: number
	side: Side
	body: string
}

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const
export type ReviewEvent = typeof REVIEW_EVENTS[number]

export interface GitHubReviewPayload {
	event: ReviewEvent
	body: string
	comments: LineComment[]
}

export interface GitHubConfiguration {
	token: string
	apiUrl: string
	owner: string
	repositoryName: string
	pullRequestNumber: number
}
