# CI Agent

A containerized CI tool that analyzes pull or git diffs, and provides feedback via AI-powered code review.

## Building

```bash
cd ci-agent
docker build -t ci-agent:latest ..
```

## Usage

### Mode 1: Local Diff Analysis

Analyze the difference between two git commits locally. The output is printed to stdout.

**Requirements:**
- A git repository in the mounted volume
- Two valid commit hashes (base and head)

**Example:**

```bash
# Get commit hashes
BASE=$(git rev-parse HEAD~1)
HEAD=$(git rev-parse HEAD)

# Run the container
docker run -it \
  -v "$(pwd)":/github/workspace \
  -w /github/workspace \
  -e BASE_COMMIT="$BASE" \
  -e HEAD_COMMIT="$HEAD" \
  ci-agent:latest
```

**Environment Variables:**
- `BASE_COMMIT` - The base commit hash (required)
- `HEAD_COMMIT` - The head commit hash (required)

### Mode 2: GitHub PR Review

Fetch a pull request from GitHub and submit a review with AI-generated feedback.

**Requirements:**
- A GitHub access token with `pull_requests` scope
- The repository owner/name and PR number

**Example:**

```bash
docker run -it \
  -e GITHUB_TOKEN="your-github-token" \
  -e PR_NUMBER="123" \
  -e REPO="owner/repository-name" \
  ci-agent:latest
```

**Environment Variables:**
- `GITHUB_TOKEN` - Your GitHub personal access token (required)
- `PR_NUMBER` - The pull request number (required)
- `REPO` - The repository in `owner/name` format (required)
- `GITHUB_API_URL` - Custom GitHub API URL (optional, defaults to `https://api.github.com`)

### Trigger Commands (GitHub Mode)

When running in GitHub Actions, the agent can be triggered via PR comments with these commands:
- `/ci` - Run CI analysis
- `/check` - Run CI analysis
- `/test` - Run CI analysis

## Output

### Local Diff Mode

Output is printed to stdout in a human-readable format:

```
## CI Agent Review

[AI-generated summary of the changes]

### Line Comments
- file.ts:42 (RIGHT): [Specific feedback]
- other.ts:10 (LEFT): [Specific feedback]

### Files Analyzed
- file.ts (modified): +10 -5
- other.ts (added): +20 -0
```

### GitHub PR Mode

A review is submitted to the pull request with:
- An overall comment containing the AI summary
- Line-specific comments on relevant code changes

## GitHub Actions Integration

See `.github/workflows/ci-agent.yml` for the workflow configuration.

The workflow triggers on:
- `pull_request_target` events (opened, synchronize, reopened)
- `issue_comment` events (when trigger commands are detected)
- Manual `workflow_dispatch`

## AI Reviewer Instructions

See `REVIEWER.md` for detailed instructions on how the AI should format its output.
