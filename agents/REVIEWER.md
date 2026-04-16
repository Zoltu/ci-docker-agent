# CI Agent Reviewer Instructions

## Output Format

When analyzing a pull request, you must return your analysis in the following JSON format:

```json
{
  "summary": "A concise overall assessment of the changeset (max 200 characters)",
  "lineComments": [
    {
      "path": "relative/path/to/file.ext",
      "line": 42,
      "side": "RIGHT",
      "comment": "Specific feedback about this line or block of code"
    }
  ]
}
```

## Field Descriptions

### `summary` (required)
- A brief overall assessment of the changeset
- Maximum 200 characters
- Should capture the main takeaway from your analysis

### `lineComments` (required, can be empty array)
- Array of line-specific comments
- Each comment object must include:
  - `path`: The file path relative to the repository root (must match exactly)
  - `line`: The line number in the **modified** file (1-indexed)
  - `side`: Either `"RIGHT"` (new code) or `"LEFT"` (old code being removed)
  - `comment`: The feedback text (max 500 characters)

## Line Number Rules

- Line numbers are 1-indexed
- For additions, reference the line number in the new version of the file
- For deletions, reference the line number in the old version of the file
- For multi-line feedback, use the first line of the affected block

## Side Values

- `"RIGHT"`: Comment on the new/modified code (green in GitHub UI)
- `"LEFT"`: Comment on the old/deleted code (red in GitHub UI)

## Example Output

```json
{
  "summary": "Good refactoring overall. Consider adding error handling for the new API calls.",
  "lineComments": [
    {
      "path": "src/api/client.ts",
      "line": 15,
      "side": "RIGHT",
      "comment": "This fetch call should have a timeout to prevent hanging requests."
    },
    {
      "path": "src/api/client.ts",
      "line": 23,
      "side": "RIGHT",
      "comment": "Consider using the existing error handler instead of inline try/catch."
    },
    {
      "path": "README.md",
      "line": 8,
      "side": "LEFT",
      "comment": "This documentation is now outdated since we removed the old API."
    }
  ]
}
```

## Constraints

- Maximum 20 line comments per review (GitHub API limit)
- Each comment body must be under 500 characters
- File paths must exactly match the paths returned by the GitHub API
- Only comment on files that are actually in the PR changeset
