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
- `AI_MAX_TOKENS` - Maximum number of output tokens to request from the model per response as a plain positive integer with no commas or units, e.g. `250000` rather than `250,000` or `250k` (optional, defaults to `100000`; raise for large or complex repositories and long reasoning runs)
- `AGENTS` - Comma-separated list of agent names to run (optional, defaults to all user agents or `Default`)

### Mode 2: GitHub PR Review

Fetch a pull request from GitHub and submit a review with AI-generated feedback.

#### Requirements
- A GitHub access token with `pull-requests: write`, which is the only permission this mode uses: it reads the pull request metadata and diff and submits one review, and it never touches the issues endpoint; only the label-triggered run in Mode 3 removes a label, so the Mode 3 list below also grants `issues: write` for that call
- The repository owner/name and PR number

#### Example

```bash
docker container run --rm -it --env="GITHUB_TOKEN=$GITHUB_TOKEN" --env="PR_NUMBER=$PR_NUMBER" --env="REPO=Zoltu/ci-docker-agent" --env="AI_API_URL=https://api.ppq.ai" --env="AI_MODEL=deepseek/deepseek-v4.1-flash" --env="AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx" ci-agent:latest
```

#### Environment Variables
- `GITHUB_TOKEN` - Your GitHub personal access token (required)
- `PR_NUMBER` - The pull request number (required)
- `REPO` - The repository in `owner/name` format (required)
- `AI_API_URL` - Base URL of the OpenAI-compatible API (required, e.g. `https://api.openai.com/v1`)
- `AI_MODEL` - Model name to use (required, e.g. `gpt-4`)
- `AI_API_KEY` - API key for authentication (optional, omit for local models that don't require auth)
- `AI_MAX_TOKENS` - Maximum number of output tokens to request from the model per response as a plain positive integer with no commas or units, e.g. `250000` rather than `250,000` or `250k` (optional, defaults to `100000`; raise for large or complex repositories and long reasoning runs)
- `AGENTS` - Comma-separated list of agent names to run (optional, defaults to all user agents or `Default`)
- `GITHUB_API_URL` - Custom GitHub API URL (optional, defaults to `https://api.github.com`)

### Mode 3: GitHub Action

See [./.github/workflows/ci-agent.yml](./.github/workflows/ci-agent.yml) for an example.

#### Requirements
- A `GITHUB_TOKEN` with `pull-requests: write` to submit the review and `issues: write` to remove the `Review Start` label from the pull request, which is the permission pair the workflow grants for those two calls because GitHub serves pull request labels through the issues endpoint; without the label permission a labeled run fails with the `Review Start` label still applied and before any agent runs

#### Secrets and Variables

Setup a GitHub repository/organization secret for `AI_API_KEY`.

Setup a GitHub repository/organization variable for `AI_API_URL`, `AI_MODEL`, and optionally `AI_MAX_TOKENS`.

### Trigger Labels (GitHub Mode)

A new pull request is reviewed automatically with every agent, so labels are only needed to choose a subset of agents or to request another review of the same pull request.

| Label | Purpose |
| --- | --- |
| `Review Start` | Starts a run for the selected `Reviewer - *` labels, or for every agent when none are present. A label-triggered run removes this label; see [Selection Rules](#selection-rules) for the cases that leave it applied. |
| `Reviewer - Architect` | Selects the `Architect` agent from `.ci-agents/Architect.md` for the run. |
| `Reviewer - Bug Hunter` | Selects the `Bug Hunter` agent from `.ci-agents/Bug Hunter.md` for the run. |
| `Reviewer - Defender` | Selects the `Defender` agent from `.ci-agents/Defender.md` for the run. |
| `Reviewer - Security` | Selects the `Security` agent from `.ci-agents/Security.md` for the run. |

#### Selection Rules

- Apply the `Reviewer - *` labels first, then add `Review Start`.
- To request a re-review, remove the `Review Start` label and add it again: GitHub emits no `labeled` event for a label that is already applied, so adding a label that is still on the pull request starts nothing.
- Only a run that started from the `Review Start` label removes it, and it does so after reading the pull request metadata and confirming the label is on the pull request, before it selects agents, validates their selector labels, or runs any agent. A run that fails after that point, which includes an unknown selector label, a `Reviewer - Aggregator` label, a diff or model failure, and a rejected review, ends with the label off.
- The label stays applied in every other case, so a run that ends with it still on the pull request needs it removed by hand before it can start another run:
  - A run that reviews a pull request without a trigger label, which is a newly opened pull request or a manual run, never removes a label.
  - A run that fails before the removal or cannot complete it, which is a failed metadata fetch or a removal request that fails, such as with a token that lacks `issues: write`.
  - A `TRIGGER_LABEL` that differs from `Review Start` only in case never reaches the removal, because it fails configuration parsing before any GitHub request.
- A metadata read that lists no `Review Start` label leaves nothing to remove, because the label is not applied, and the run reports it as missing; add the label to start a run.
- Only `Review Start` starts a run; a `Reviewer - *` label applied on its own does nothing.
- Only labels that start with the exact `Reviewer - ` prefix are selectors; every other label is ignored, including a mistyped prefix such as `reviewer - Security`, `Reviewers - Security`, or `Reviewer- Security`. Ignored labels change nothing: a run with no valid selector label reviews with every agent. The run logs each ignored selector-like label.
- The agent name that follows the prefix is matched exactly and case-sensitively, including spaces and capitalization; the aggregator name is the one exception and is matched case-insensitively.
- A well-formed selector whose agent name matches no agent prompt file, in `.ci-agents/` or among the built-in agents, fails the run as a configuration error, and the message states that a label's agent name is matched case-sensitively while listing the available agent names.
- A selector naming the aggregator in any capitalization, such as `Reviewer - Aggregator` or `Reviewer - aggregator`, fails the run as a configuration error, because the aggregator always runs last automatically.
- Label-triggered runs ignore the `AGENTS` environment variable.

#### Per-Repository Setup

GitHub labels are per-repository, so every repository that runs the workflow needs its own copy, created by hand: `Review Start` plus one `Reviewer - <Name>` label per selectable agent, the four in the table above plus the built-in `Default`.
The name that follows the prefix selects an agent from either prompt location, a markdown file in the repository's own `.ci-agents/` directory or one of the built-in agents, so `Reviewer - Default` selects the built-in `Default` agent even in a repository with no `.ci-agents` directory at all.
Do not create a `Reviewer - Aggregator` label: the aggregator always runs last automatically, so a selector naming it fails every label-triggered run it is present on, including in a repository that overrides `.ci-agents/Aggregator.md`.
A selector whose agent name matches no agent in either location fails the run; see [Selection Rules](#selection-rules) for the message it reports.

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
See [./agents/Aggregator.md](./agents/Aggregator.md) for an example of one way to achieve that.

### Specifying Agents

Labels select agents for labeled runs; see [Trigger Labels (GitHub Mode)](#trigger-labels-github-mode).

#### Via Environment Variable

```bash
docker container run -e AGENTS="Security, Style Master" ...
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

The workflow run itself owns the check status; the agent submits a review only.

## GitHub Actions Integration

See `.github/workflows/ci-agent.yml` for the workflow configuration.

The workflow triggers on:
- `pull_request_target` events of type `opened` and `labeled`
- `workflow_dispatch` event (manual trigger of the workflow)

A `labeled` run starts only for the `Review Start` label, and the workflow passes the applied label to the container as `TRIGGER_LABEL`, which is empty for `opened` and manual runs.
A `TRIGGER_LABEL` set to anything other than exactly `Review Start` fails the run instead of reviewing the pull request.
GitHub compares that label name with `==` case-insensitively, so a label that differs from `Review Start` only in case passes the workflow gate and is then rejected in code: the run fails closed and no agents run.
