# CI Agent

A container image that reviews a git diff with AI and prints the review to stdout or posts it to a GitHub pull request.

## Build

```bash
docker image build --tag='ci-agent:latest' .
```

## Usage

### Mode 1: Local Diff Analysis

Review the diff between two commits in a mounted repository and print the review to stdout.

#### Example

```bash
docker container run --rm -it --mount="type=bind,source=$(pwd),target=/workspace" --env="BASE_COMMIT=$(git rev-parse HEAD~1)" --env="HEAD_COMMIT=$(git rev-parse HEAD)" --env="AI_API_URL=https://api.ppq.ai" --env="AI_MODEL=z-ai/glm-5.1" --env="AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx" ci-agent:latest
```

#### Environment Variables

- `BASE_COMMIT` - The base commit hash (required).
- `HEAD_COMMIT` - The head commit hash (required).

This mode also needs the settings in [AI Settings](#ai-settings).

### Mode 2: GitHub PR Review

Fetch a pull request from GitHub and submit a review with AI-generated feedback.

#### Example

```bash
docker container run --rm -it --env="GITHUB_TOKEN=$GITHUB_TOKEN" --env="PR_NUMBER=$PR_NUMBER" --env="REPO=Zoltu/ci-docker-agent" --env="AI_API_URL=https://api.ppq.ai" --env="AI_MODEL=deepseek/deepseek-v4.1-flash" --env="AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx" ci-agent:latest
```

#### Environment Variables

- `GITHUB_TOKEN` - A token with `pull-requests: write` (required).
- `PR_NUMBER` - The pull request number (required).
- `REPO` - The repository in `owner/name` format (required).
- `GITHUB_API_URL` - Custom GitHub API URL (optional, defaults to `https://api.github.com`).

This mode also needs the settings in [AI Settings](#ai-settings).

### Mode 3: GitHub Action

Copy [./.github/workflows/ci-agent.yml](./.github/workflows/ci-agent.yml) into your repository's `.github/workflows/` to review every new pull request automatically.

#### Example

```bash
gh workflow run ci-agent.yml -f pr_number=123
```

#### Setup

Set the repository secret `AI_API_KEY` and the repository variables `AI_API_URL`, `AI_MODEL`, and optionally `AI_MAX_TOKENS`. The workflow declares `pull-requests: write` to submit the review and `contents: read` to check out the repository. A manual run takes `pr_number`, or `base_commit` and `head_commit`. A run uploads a `debug-traces` artifact, kept for 7 days.

## Trigger Labels

The workflow reviews every new pull request with every agent. Add `Reviewer - <Name>` labels to narrow which agents run and `Review Start` last to start the run; each name must match an agent prompt file, and a malformed or unknown name fails the run.

| Label | Purpose |
| --- | --- |
| `Review Start` | Starts a run for the selected agents. |
| `Reviewer - Architect` | Runs the `Architect` agent from `.ci-agents/Architect.md`. |
| `Reviewer - Bug Hunter` | Runs the `Bug Hunter` agent from `.ci-agents/Bug Hunter.md`. |
| `Reviewer - Default` | Runs the built-in `Default` agent from `agents/Default.md`. |
| `Reviewer - Defender` | Runs the `Defender` agent from `.ci-agents/Defender.md`. |
| `Reviewer - Security` | Runs the `Security` agent from `.ci-agents/Security.md`. |

GitHub labels are per-repository: create each label by hand in every repository that runs the workflow. A label-triggered run clears the trigger label and every selector label, so add `Review Start` again to request another review.

A `TRIGGER_LABEL` is matched against `Review Start` ignoring case, and any other label name fails the run.

## AI Settings

Every mode needs these settings:

- `AI_API_URL` - Base URL of the OpenAI-compatible API (required).
- `AI_MODEL` - Model name to use (required).
- `AI_API_KEY` - API key for authentication (optional, omit for a local model that needs no auth).
- `AI_MAX_TOKENS` - Maximum output tokens per response as a plain integer (optional, defaults to `100000`).

## Agents

An agent is a prompt that reviews the diff, and an `Aggregator` agent merges the agents' results into the final review and always runs last.

### Custom Agents

Drop a markdown file per agent in `<project root>/.ci-agents/`; the file name without `.md` is the agent name. The built-in `Default` agent stays selectable.

- `AGENTS` - Comma-separated agent names to run (optional, defaults to all user agents or `Default`; ignored on a label-triggered run).

To override the `Aggregator`, add `.ci-agents/Aggregator.md`; see [./agents/Aggregator.md](./agents/Aggregator.md) for an example that returns valid JSON.

## Output

Local diff mode prints the review to stdout:

```
## CI Agent Review

[AI-generated summary of the changes]

### Line Comments
- file.ts:42 (RIGHT): [Specific feedback]
- other.ts:10 (LEFT): [Specific feedback]
```

GitHub mode submits one review comment with the AI summary and line comments on the changed code. A partial review includes a `⚠️ **PARTIAL REVIEW` warning naming the reviewers that ran.
