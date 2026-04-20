export const FILE_STATUSES = ["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"] as const
export type FileStatus = typeof FILE_STATUSES[number]

export interface PrFile {
	filename: string
	status: FileStatus
	additions: number
	deletions: number
	changes: number
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
}
