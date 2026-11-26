# CI Agent

A container image that reviews a git diff with AI and prints it to stdout or posts it to a pull request.

## Build

Build the image for Modes 1 and 2:

```bash
docker image build --tag='ci-agent:latest' .
```

## Usage

### Mode 1: Local Diff Analysis

Review the diff between two commits in a mounted repository and print it to stdout.

#### Example

```bash
docker container run --rm --mount="type=bind,source=$(pwd),target=/workspace" --env="BASE_COMMIT=$(git rev-parse HEAD~1)" --env="HEAD_COMMIT=$(git rev-parse HEAD)" --env="AI_API_URL=https://api.ppq.ai" --env="AI_MODEL=z-ai/glm-5.1" --env="AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx" ci-agent:latest
```

Mount the repository at `/workspace`, or set `GITHUB_WORKSPACE` to your mount target.

#### Environment Variables

- `BASE_COMMIT` - The base commit hash (required).
- `HEAD_COMMIT` - The head commit hash (required).

This mode also needs [AI Settings](#ai-settings).

### Mode 2: GitHub PR Review

Review a pull request from a clone of that pull request's repository and post the review to it.

#### Example

Replace the placeholders and the example `REPO` value.

```bash
docker container run --rm --mount="type=bind,source=$(pwd),target=/workspace" --env="GITHUB_TOKEN=<token>" --env="PR_NUMBER=<number>" --env="REPO=Zoltu/ci-docker-agent" --env="AI_API_URL=https://api.ppq.ai" --env="AI_MODEL=deepseek/deepseek-v4.1-flash" --env="AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx" ci-agent:latest
```

#### Environment Variables

- `GITHUB_TOKEN` - A token with `pull-requests: write` (required).
- `PR_NUMBER` - The pull request number (required).
- `REPO` - The `owner/name` repository under review (required).
- `GITHUB_API_URL` - GitHub API URL (optional, defaults to `https://api.github.com`).

This mode also needs [AI Settings](#ai-settings).

### Mode 3: GitHub Action

Review every new pull request automatically and post the review.

#### Setup

- Copy [./.github/workflows/ci-agent.yml](./.github/workflows/ci-agent.yml) into `.github/workflows/` on the default branch.
- Use `ghcr.io/zoltu/ci-docker-agent:latest`, published by [./.github/workflows/publish.yml](./.github/workflows/publish.yml), or change `container.image` to use your own build.
- Set the repository secret `AI_API_KEY` and variables `AI_API_URL`, `AI_MODEL`, and optionally `AI_MAX_TOKENS`; the workflow declares `contents: read` and `pull-requests: write`.
- For your own agents, create the [trigger labels](#trigger-labels) and the [custom agent files](#custom-agents).

Every run uploads a `debug-traces` artifact to the run page for seven days.

## Trigger Labels

Create `Review Start` in your repository's labels, then add it to a pull request to start a review with every reviewer.
To review with only some, add the matching `Reviewer - <Name>` labels first, then add `Review Start`; the run removes both, so add `Review Start` again to review again.
The label names follow your `.ci-agents/` prompt files, so they differ between repositories, and a label naming no agent fails the run.

A `TRIGGER_LABEL` is matched against `Review Start` ignoring case, and any other label name fails the run instead of reviewing the pull request.

## AI Settings

- `AI_API_URL` - Base URL of a streaming OpenAI-compatible API that reports token usage and supports tool calls; `/chat/completions` is appended (required).
- `AI_MODEL` - Model name (required).
- `AI_API_KEY` - API key (optional).
- `AI_MAX_TOKENS` - Maximum output tokens as a plain integer (optional, defaults to `100000`).

## Agents

Agents are prompts that review the diff; an `Aggregator` merges their results into the review and runs last.

### Custom Agents

Create one `.ci-agents/<Name>.md` file per reviewer agent, for example with GitHub's `Add file` button, which creates the `.ci-agents/` folder along with the file; the file name without `.md` is the agent name.
Commit them to the branch your pull requests target.
Without `.ci-agents/`, the built-in `Default` is the only reviewer.

In Mode 3, choose agents with the [trigger labels](#trigger-labels).
For Modes 1 and 2, choose them explicitly:

- `AGENTS` - Comma-separated agent names to run (optional, defaults to every agent in `.ci-agents/`).

To override the `Aggregator`, add `.ci-agents/Aggregator.md`; [./agents/Aggregator.md](./agents/Aggregator.md) shows a JSON-returning example.

## Output

Mode 1 prints the review to stdout:

```
## CI Agent Review

[AI-generated summary of the changes]

### Line Comments
- file.ts:42 (RIGHT): [Specific feedback]
```

Modes 2 and 3 post the summary and line comments as a single review to the pull request, never approving or blocking it.
A partial pull request review carries this warning below its `## CI Agent Review` heading:

```
⚠️ **PARTIAL REVIEW — 1 of 4 reviewers ran: `Security`. This is not a full review.**
```
