export interface PrFile {
	filename: string
	status: string
	additions: number
	deletions: number
	changes: number
	// blob_url: string
	// raw_url: string
	// contents_url: string
	patch?: string
}

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

export interface GitHubConfig {
	token: string
	apiUrl: string
	repo: string
	owner: string
	repoName: string
	prNumber: number
	commentId?: number
}
