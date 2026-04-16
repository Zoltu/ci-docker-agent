import type { PRFile } from "./github-types.mts"
import type { AIReviewResult } from "./review.mts"

export interface AIClient {
	analyze(files: PRFile[]): Promise<AIReviewResult>
}

export function createPlaceholderAIClient(): AIClient {
	return {
		async analyze(files: PRFile[]): Promise<AIReviewResult> {
			console.log(`Analyzing ${files.length} files...`)
			return {
				summary: "AI analysis placeholder - no actual analysis performed yet.",
				lineComments: [],
			}
		},
	}
}
