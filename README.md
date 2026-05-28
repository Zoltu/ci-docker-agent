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
docker container run --rm -it --mount="type=bind,source=$(pwd),target=/workspace" --env="BASE_COMMIT=$(git rev-parse HEAD~1)" --env="HEAD_COMMIT=$(git rev-parse HEAD)" --env="AI_API_URL=https://api.ppq.ai" --env="AI_MODEL=z-ai/glm-5.1" --env="AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx" ci-agent:latest
```

#### Environment Variables
- `BASE_COMMIT` - The base commit hash (required)
- `HEAD_COMMIT` - The head commit hash (required)
- `AI_API_URL` - Base URL of the OpenAI-compatible API (required, e.g. `https://api.openai.com/v1`)
- `AI_MODEL` - Model name to use (required, e.g. `gpt-4`)
- `AI_API_KEY` - API key for authentication (optional, omit for local models that don't require auth)
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
- `AI_API_URL` - Base URL of the OpenAI-compatible API (required, e.g. `https://api.openai.com/v1`)
- `AI_MODEL` - Model name to use (required, e.g. `gpt-4`)
- `AI_API_KEY` - API key for authentication (optional, omit for local models that don't require auth)
- `AGENTS` - Comma-separated list of agent names to run (optional, defaults to all user agents or `Default`)
- `GITHUB_API_URL` - Custom GitHub API URL (optional, defaults to `https://api.github.com`)

### Mode 3: GitHub Action

See [./.github/workflows/ci-agent.yml](./.github/workflows/ci-agent.yml) for an example.

#### Secrets and Variables

Setup a GitHub repository/organization secret for `AI_API_KEY`.

Setup a GitHub repository/organization variable for `AI_API_URL` and `AI_MODEL`.

Everything else should "just work".

### Trigger Commands (GitHub Mode)

When running in GitHub Actions, the agent can be triggered via PR comments:

- `/review` - Run all user-provided agents or Default if none exist
- `/review SecurityAgent, StyleAgent` - Run specific agents (comma-separated)

## Agents

The CI Agent uses a multi-agent architecture where each agent provides feedback in prose form, and an `Aggregator` agent consolidates the results.  By default, a single generic agent is used, but users can provide their own agent prompts in their project.

### Adding Custom Agents

To add custom agents, create markdown files in `<project root>/.ci-agents/`:

```
<project root>/.ci-agents/
├── Security.md
├── Style Master.md
└── Performance.md
```

Each markdown file should contain instructions for that agent.
The filename (without `.md`) becomes the agent's name.

### Context Window

The agent reads the entire diff into the context window.
It then reads files from the base commit as needed.
This is designed for well-maintained and focused repositories with reasonable sized PRs rather than large monorepos.

### Agent Resolution

If the user provides any agents, the built-in `Default` agent will not be used.

### The Aggregator Agent

The `Aggregator` agent is responsible for consolidating feedback from all other agents and producing the final output. It is always run last.

You can override the default aggregator by providing your own `Aggregator.md` file (case-insensitive) in `/workspace/.ci-agents/`.
If you choose to override the `Aggregator` agent, you must ensure that your agent always returns valid JSON for GitHub reviews.
See [./agents/Aggregator.md](./agents/Aggregator.md) for an example of one way to achieve this.

### Specifying Agents

#### Via Environment Variable

```bash
docker container run -e AGENTS="Security, Style Master" ...
```

#### Via PR Comment

```
/review Security, Style Master
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
```

### GitHub PR Mode

A review is submitted to the pull request with:
- An overall comment containing the AI summary
- Line-specific comments on relevant code changes

## GitHub Actions Integration

See `.github/workflows/ci-agent.yml` for the workflow configuration.

The workflow triggers on:
- `pull_request_target` events
- `issue_comment` events (when trigger commands are detected)
- Manual `workflow_dispatch`
