# CI Agent

A containerized CI tool that analyzes pull or git diffs, and provides feedback via AI-powered code review.

## Building

```bash
docker image build --tag='ci-agent:latest' .
```

## Usage

### Mode 1: Local Diff Analysis

Analyze the difference between two git commits locally. The output is printed to stdout.

#### Requirements
- A git repository in the mounted volume
- Two valid commit hashes (base and head)

#### Example

```bash
docker container run --rm -it --mount="type=bind,source=$(pwd),target=/github/workspace" --workdir='/github/workspace' --env="BASE_COMMIT=$(git rev-parse HEAD~1)" --env="HEAD_COMMIT=$(git rev-parse HEAD)" ci-agent:latest
```

#### Environment Variables
- `BASE_COMMIT` - The base commit hash (required)
- `HEAD_COMMIT` - The head commit hash (required)
- `AGENTS` - Comma-separated list of agent names to run (optional, defaults to all user agents or `Default`)

### Mode 2: GitHub PR Review

Fetch a pull request from GitHub and submit a review with AI-generated feedback.

#### Requirements
- A GitHub access token with `pull_requests` scope
- The repository owner/name and PR number

#### Example

```bash
docker run -it \
  -e GITHUB_TOKEN="your-github-token" \
  -e PR_NUMBER="123" \
  -e REPO="owner/repo-name" \
  ci-agent:latest
```

#### Environment Variables
- `GITHUB_TOKEN` - Your GitHub personal access token (required)
- `PR_NUMBER` - The pull request number (required)
- `REPO` - The repository in `owner/name` format (required)
- `GITHUB_API_URL` - Custom GitHub API URL (optional, defaults to `https://api.github.com`)
- `AGENTS` - Comma-separated list of agent names to run (optional, defaults to all user agents or `Default`)

### Trigger Commands (GitHub Mode)

When running in GitHub Actions, the agent can be triggered via PR comments:

- `/review` - Run all user-provided agents or Default if none exist
- `/review SecurityAgent, StyleAgent` - Run specific agents (comma-separated)

## Agents

The CI Agent uses a multi-agent architecture where each agent provides feedback in prose form, and an `Aggregator` agent consolidates the results.

### Context Window

The agent reads the entire repository at the base commit into the context window (excluding `.git/` and files matched by `.gitignore`). This is designed for well-maintained, focused repositories rather than large monorepos.

### Adding Custom Agents

To add custom agents, create markdown files in `/github/workspace/.ci-agents/`:

```
/github/workspace/.ci-agents/
├── SecurityAgent.md
├── StyleAgent.md
└── PerformanceAgent.md
```

Each markdown file should contain instructions for that agent. The filename (without `.md`) becomes the agent's name.

### Agent Resolution

Agents are resolved in the following order:
1. User-provided agents in `/github/workspace/.ci-agents/` (case-insensitive)
2. Builtin agents in `/github/workspace/agents/` (case-insensitive)

If an agent is not found, the process exits with a fatal error.

### The Aggregator Agent

The `Aggregator` agent is responsible for consolidating feedback from all other agents and producing the final output. It is always run last.

You can override the default aggregator by providing your own `Aggregator.md` file (case-insensitive) in `/github/workspace/.ci-agents/`.

### Default Agent

The `Default` agent is used only when:
- No agents are specified via environment variable or comment trigger, AND
- No user-provided agents exist in `/github/workspace/.ci-agents/`

If user-provided agents exist, they are all used by default (except `Aggregator`).

### Specifying Agents

#### Via Environment Variable

```bash
AGENTS="SecurityAgent,StyleAgent" docker run ...
```

#### Via PR Comment

```
/review SecurityAgent, StyleAgent
```

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

## AI Agent Instructions

See `agents/Aggregator.md` for detailed instructions on how the Aggregator consolidates feedback from multiple agents.
