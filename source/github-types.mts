// GitHub API types for PR reviews

export interface PrFile {
	filename: string
	status: string
	additions: number
	deletions: number
	changes: number
	blob_url: string
	raw_url: string
	contents_url: string
	patch?: string
}

export interface LineComment {
	path: string
	line: number
	side: "LEFT" | "RIGHT"
	body: string
}

export interface GitHubReviewPayload {
	event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"
	body: string
	comments: LineComment[]
}

export interface GitHubConfig {
	token: string
	apiUrl: string
	repo: string
	prNumber: number
}
