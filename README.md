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
- A GitHub access token with `pull-requests: write`, which is the only permission this mode uses: it reads the pull request metadata and diff and submits one review
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
- A `GITHUB_TOKEN` with `pull-requests: write` to submit the review and remove the trigger label and every selector label, and `contents: read` to check out the repository and fetch the base commit; the removals happen before any agent runs, so a token without `pull-requests: write` fails a labeled run and leaves the labels applied

#### Secrets and Variables

Setup a GitHub repository/organization secret for `AI_API_KEY`.

Setup a GitHub repository/organization variable for `AI_API_URL`, `AI_MODEL`, and optionally `AI_MAX_TOKENS`.

### Trigger Labels (GitHub Mode)

A new pull request is reviewed automatically with every agent, because the shipped workflow does not pass `AGENTS`. Labels are only needed to change that selection for a single run or to request another review of the same pull request. A custom workflow that passes `AGENTS` uses that selection for the automatic run and ignores labels there.

| Label | Purpose |
| --- | --- |
| `Review Start` | Starts a run for the selected agents, and the run removes the trigger label under its listed spelling, the spelling the pull request carries, plus every `Reviewer - ` label; see [Selection Rules](#selection-rules). |
| `Reviewer - Architect` | Selects the `Architect` agent from `.ci-agents/Architect.md` for the run. |
| `Reviewer - Bug Hunter` | Selects the `Bug Hunter` agent from `.ci-agents/Bug Hunter.md` for the run. |
| `Reviewer - Default` | Selects the built-in `Default` agent from `agents/Default.md` for the run. |
| `Reviewer - Defender` | Selects the `Defender` agent from `.ci-agents/Defender.md` for the run. |
| `Reviewer - Security` | Selects the `Security` agent from `.ci-agents/Security.md` for the run. |

#### Selection Rules

- Apply the `Reviewer - *` labels first, then add `Review Start`.
- To request a re-review, add `Review Start` again: a successful label-triggered run has already removed it, so the add is the whole step. Remove it first only when it is still on the pull request, which is what a run that removed no label leaves behind. Consuming the selector labels is what keeps a one-off subset run one-off: a leftover selector narrows the next label-triggered run to the agents it names, so a run that leaves out a reviewer a bare run would use reports the narrowing in its partial-review warning, and removal is what lets a label-triggered run review with every agent again. Automatic runs ignore labels entirely, so leftover selectors do not affect them.
- A `Reviewer - All` label costs one failed run rather than a manual cleanup, because it names no agent unless the repository ships a prompt called `All`: the run removes it and then fails selection.
- A pull request opened with `Review Start` already applied starts only the automatic `opened` run, because GitHub is expected to emit no `labeled` event for a label the pull request was created with.
- Which labels a run removes depends on how it started. A run that started from the trigger label begins removing them only after reading the pull request metadata and confirming the label is on the pull request, and does so before it selects agents, validates their selector labels, or runs any agent. It removes the trigger label first, under its listed spelling, which may differ from `Review Start` in case. It then removes every label that carries the exact `Reviewer - ` prefix. A failed removal request ends the run without submitting a review. A run that fails after removing every one of those labels leaves the trigger label and every selector label off; such failures include an unknown selector label, a near-miss selector label, a `Reviewer - Aggregator` label, a diff or model failure, and a rejected review.
- A run that removes no label leaves every label where it was:
	- A run that did not start from the trigger label, which is a newly opened pull request or a manual run, leaves every label applied.
	- A run whose metadata read fails, or whose first removal request is rejected by GitHub, fails and leaves every label applied.
	- A run whose metadata read lists no label matching `Review Start` ignoring case leaves every label applied and fails with a message naming the configured `TRIGGER_LABEL` value; add the label to start a run.
- Because the removals run one label at a time and stop at the failing one, a failure after the first delete leaves the trigger label off and every label from the failing one onward still applied; adding the trigger label back then reviews with only the agents those leftover selectors name, which is a full review when those selectors cover every reviewer a bare run would use, and a partial review whose warning reports the narrowing otherwise. The trigger label is already off in that case, so the remedy is to remove the leftover `Reviewer - ` labels first and add the trigger label back only afterwards.
- Only a label matching `Review Start` ignoring case starts a run; a `Reviewer - *` label applied on its own does nothing.
- A label selects an agent only when it starts with the exact `Reviewer - ` prefix, and every label outside the trigger label, a selector, and a botched selector attempt is ignored, so the run reviews with every agent when no label is a selector and none is a botched selector attempt; a label such as `bug`, `documentation`, `needs-review`, or `review pending` therefore changes nothing.
- A botched selector attempt fails the run as a configuration error, and the run never falls back to every agent. Ignoring case, a label that is neither the trigger label nor a selector is a botched selector attempt when it begins with `reviewer`, as in `reviewer - Security`, `Reviewers - Security`, `Reviewer- Security`, `Reviewer -Security`, and `reviewer-pending`, or when it begins with `review` followed by optional spaces and a hyphen, as in `Review - Security` and `review-needed`. The message names the offending label and the required spelling: `Reviewer - <Name>`, with a capital `R`, a spaced hyphen, and `<Name>` matching an agent prompt file name exactly and case-sensitively.
- A near-miss spelling is not removed, because removal keys on the exact prefix, so it keeps failing every label-triggered run it is present on until it is corrected or deleted by hand.
- The agent name that follows the prefix is matched exactly and case-sensitively, including spaces and capitalization; the aggregator name is the one exception and is matched case-insensitively.
- A well-formed selector whose agent name matches no agent prompt file, in `.ci-agents/` or among the built-in agents, fails the run as a configuration error, and the message states that a label's agent name is matched case-sensitively while listing the available agent names.
- A selector naming the aggregator in any capitalization, such as `Reviewer - Aggregator` or `Reviewer - aggregator`, fails the run as a configuration error, because the aggregator always runs last automatically, including in a repository that overrides `.ci-agents/Aggregator.md`.
- Label-triggered runs ignore the `AGENTS` environment variable.

#### Per-Repository Setup

GitHub labels are per-repository, so every repository that runs the workflow needs its own copy, created by hand: `Review Start` plus one `Reviewer - <Name>` label per selectable agent, the five in the table above.
The name that follows the prefix selects an agent from either prompt location, a markdown file in the repository's own `.ci-agents/` directory or one of the built-in agents, so `Reviewer - Default` selects the built-in `Default` agent even in a repository with no `.ci-agents/` directory at all.
Do not create a `Reviewer - Aggregator` label; [Selection Rules](#selection-rules) states why it fails, including for a repository that overrides `.ci-agents/Aggregator.md`, and what the failed run leaves behind.
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

A run with no agent selection uses the repository's own prompts instead of the built-in `Default` agent, which stays selectable: naming it in `AGENTS` or with a `Reviewer - Default` label runs it, alone or alongside user prompts.
Agent prompt file names are matched case-insensitively, in `.ci-agents/` and among the built-in agents alike, so two files whose names differ only by case name one agent and only one of them would ever run.
Such a repository fails the run as a configuration error instead, naming both files: `Duplicate agent prompt file names: "<a>" and "<b>"`. Rename or delete one of them.

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

No notice appears in the console review output.

### GitHub PR Mode

A review is submitted to the pull request with:
- A notice below the `## CI Agent Review` heading and above the AI summary, stating which reviewers ran: a plain line when every reviewer ran, or a bold warning naming the reviewers that ran when only a subset did
- For a subset review, the same warning repeated after the AI summary, because a long review scrolls the first one out of view
- An overall comment containing the AI summary
- Line-specific comments on relevant code changes

The notice's own strings call each agent that ran a reviewer; the two words name the same thing.
A full review reads `Reviewers: All 4 reviewers ran.`, and a run with a single reviewer reads `Reviewers: All 1 reviewer ran.`
A partial review reads ``⚠️ **PARTIAL REVIEW — 2 of 4 reviewers ran: `Security`, `Architect`. This is not a full review.**``, and a run that selects one of the two prompts a repository ships, and no other, reads ``⚠️ **PARTIAL REVIEW — 1 of 2 reviewers ran: `Security`. This is not a full review.**``.
The notice follows these rules for its numbers and names:
- The number before `of` is how many reviewers ran, and it matches the names after the colon when there are any.
- The number after `of` is how many reviewers the pull request could run: the reviewers a run with no selector labels would use, plus any selected reviewer outside that set, so it is always above the number before it in a partial review and no partial review reads as complete coverage.
- A partial review whose selection ran no reviewer has no names to list, so it drops the colon and reads `0 of 2 reviewers ran` in a repository with two prompts; the gap the previous point describes also makes its noun `reviewers` even when the number after `of` is one.
- The names after the colon are every reviewer that ran, in selection order.

`All` means the run covered every reviewer a run with no selector labels would use, so applying every selector label explicitly also reads as a full review, and a selector that adds a reviewer on top of them also leaves nothing out, with its count still covering every reviewer that ran.
The `All` in the notice is unrelated to the `Reviewer - All` label; see [Selection Rules](#selection-rules) for what that label does.

The workflow run itself owns the check status; the agent submits a review only.

## GitHub Actions Integration

See `.github/workflows/ci-agent.yml` for the workflow configuration.

The workflow triggers on:
- `pull_request_target` events of type `opened` and `labeled`
- `workflow_dispatch` event (manual trigger of the workflow)

A `labeled` run starts only when the applied label is `Review Start` ignoring case, and the workflow passes that applied label to the container as `TRIGGER_LABEL`, which is empty for `opened` and manual runs.
A `TRIGGER_LABEL` is matched against `Review Start` ignoring case, and any other label name fails the run instead of reviewing the pull request.
