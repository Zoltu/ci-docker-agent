// A full claim carries only the number of reviewers that ran; a partial claim carries the reviewers that ran and the number the pull request could run, which is the union of those reviewers and the ones a run with no selector labels would use.
export type ReviewerCoverage =
	| { readonly kind: "full"; readonly reviewerCount: number }
	| { readonly kind: "partial"; readonly ranReviewerNames: readonly string[]; readonly possibleReviewerCount: number }
