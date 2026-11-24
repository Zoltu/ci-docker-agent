import { describe, it, expect } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { selectableAgentNames, type Agent } from "../source/agents.mts"
import { REVIEW_START_LABEL, REVIEWER_LABEL_PREFIX } from "../source/labels.mts"
import { BUILTIN_AGENTS_DIRECTORY, DEBUG_DIRECTORY, getWorkspaceDirectory } from "../source/paths.mts"

const PROJECT_ROOT = join(import.meta.dir, "..")
// TRIGGER_LABEL is workflow plumbing rather than user configuration: the workflow sets it from the applied label, and the README describes it in prose instead of as an environment-variable bullet.
const WORKFLOW_INJECTED_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set(["TRIGGER_LABEL"])
const LOCAL_DIFF_MODE_HEADING = "### Mode 1: Local Diff Analysis"
const GITHUB_PR_MODE_HEADING = "### Mode 2: GitHub PR Review"
const ENVIRONMENT_VARIABLE_REFERENCE = /environment\.([A-Z][A-Z0-9_]*)/g
const DOCUMENTED_VARIABLE_BULLET = /^- `([A-Z][A-Z0-9_]*)` - /gm
const REVIEWER_LABEL_ROW = /^\| `Reviewer - ([^`]+)` \|/gm
const WORKFLOW_COMMENT_LINE = /^\s*#/
const TYPESCRIPT_COMMENT_LINE = /^\s*\/\//
const WORKFLOW_REF_DECLARATION = /(?:^|[{,])\s*(?:"|')?ref(?:"|')?\s*:/m
const WORKFLOW_PERMISSION_ENTRY = /^ {2}([a-z-]+):\s*(\S+)\s*$/
const WORKFLOW_JOB_DECLARATION = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/
const WORKFLOW_JOB_PERMISSIONS_KEY = /^ {4}permissions:/
const CHECKOUT_ACTION_PREFIX = "actions/checkout@"
const STEP_USES_LINE = /^ {8,}uses:\s*(.+)$/
const STEP_USES_TRAILING_COMMENT = /\s+#.*$/
// A block scalar header is `|` or `>` followed by an optional chomping indicator and an optional indentation indicator in either order, so `|-`, `|+`, `|2`, `>-2` all open one.
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?[1-9]?[+-]?$/
// GitHub resolves these only for a pull request, so a step that names one runs against the pull request's own head instead of the checkout the workflow made.
const PULL_REQUEST_HEAD_PATTERNS: ReadonlyArray<RegExp> = [
	/\bpull_request\.head\b/,
	/\bgithub\.head_ref\b/,
	/\bgit\b[^\n]*(?:fetch|checkout|pull|switch|reset)[^\n]*(?:\bhead\b|pull\/)/,
	/\bGITHUB_EVENT_PATH\b/,
	/^\s*repository\s*:.*(?:pull_request\b|head_ref\b|head\b)/
]
// The merge ref and the merge commit hold the pull request's content merged into the base branch, so either would hand pull request code to the agent.
const PULL_REQUEST_MERGE_PATTERNS: ReadonlyArray<RegExp> = [
	/refs\/pull\//,
	/merge_commit_sha\b/,
	/\bgit\b[^\n]*(?:fetch|checkout|pull|switch|reset)[^\n]*merge\b/
]
// The event payload carries text the pull request author writes, so an expression that interpolates it into a step hands that text to the run.
const EVENT_PAYLOAD_PATTERNS: ReadonlyArray<RegExp> = [
	/\btoJSON\s*\(\s*github\.event\b/,
	/\bgithub\.event\.pull_request\.(?:title|body|head|user\.login)\b/
]

function readProjectFile(...path: ReadonlyArray<string>): string {
	return readFileSync(join(PROJECT_ROOT, ...path), "utf-8")
}

function collectEnvironmentVariableNames(source: string): ReadonlySet<string> {
	const names = new Set<string>()
	for (const reference of source.matchAll(ENVIRONMENT_VARIABLE_REFERENCE)) {
		const name = reference[1]
		if (name === undefined) continue
		names.add(name)
	}
	return names
}

function readConfigurationEnvironmentVariableNames(): ReadonlySet<string> {
	return collectEnvironmentVariableNames(readProjectFile("source", "configuration.mts"))
}

// The names come from the function that assembles GitHubConfiguration rather than from a list here, so a variable added to GitHub mode cannot be documented in the wrong mode's list.
function readGitHubConfigurationEnvironmentVariableNames(): ReadonlySet<string> {
	const configurationSource = readProjectFile("source", "configuration.mts")
	const functionStart = configurationSource.indexOf("function tryParseGitHubConfiguration(")
	if (functionStart === -1) throw new Error("source/configuration.mts no longer declares tryParseGitHubConfiguration, so this test cannot tell which environment variables belong to GitHub mode")
	const functionEnd = configurationSource.indexOf("\n}", functionStart)
	const functionBody = configurationSource.slice(functionStart, functionEnd === -1 ? undefined : functionEnd)
	return collectEnvironmentVariableNames(functionBody)
}

function readReadmeSection(heading: string): string {
	const readme = readProjectFile("README.md")
	const sectionStart = readme.indexOf(heading)
	if (sectionStart === -1) throw new Error(`README.md no longer contains the section heading "${heading}", so this test cannot tell which mode documents which environment variable`)
	// Subheadings are deeper than "### ", so the next same-level heading ends the section.
	const nextSectionStart = readme.indexOf("\n### ", sectionStart)
	return readme.slice(sectionStart, nextSectionStart === -1 ? undefined : nextSectionStart)
}

function readDocumentedVariableNames(heading: string): ReadonlySet<string> {
	const names = new Set<string>()
	for (const bullet of readReadmeSection(heading).matchAll(DOCUMENTED_VARIABLE_BULLET)) {
		const name = bullet[1]
		if (name === undefined) continue
		names.add(name)
	}
	return names
}

function readAgentNames(directory: string): ReadonlyArray<string> {
	return readdirSync(directory)
		.filter(entry => entry.toLowerCase().endsWith(".md"))
		.map(entry => entry.replace(/\.md$/i, ""))
}

// The name is all these agents need to carry, because the selectable-agent rule reads no prompt.
function readAgentsNamed(directory: string): ReadonlyArray<Agent> {
	return readAgentNames(directory).map(name => ({ name, prompt: "" }))
}

function readUserAgents(): ReadonlyArray<Agent> {
	return readAgentsNamed(join(PROJECT_ROOT, ".ci-agents"))
}

// BUILTIN_AGENTS_DIRECTORY is the in-container path, so the checked-out repository's agents directory stands in for it here.
function readBuiltinAgents(): ReadonlyArray<Agent> {
	return readAgentsNamed(join(PROJECT_ROOT, "agents"))
}

function readReviewerLabelRowAgentNames(): ReadonlyArray<string> {
	const readme = readProjectFile("README.md")
	return [...readme.matchAll(REVIEWER_LABEL_ROW)].flatMap(row => row[1] === undefined ? [] : [row[1]])
}

// The workflow cannot import a constant, so every workflow assertion below compares a literal in ci-agent.yml with the constant it has to match.
function readWorkflow(): string {
	return readProjectFile(".github", "workflows", "ci-agent.yml")
}

// A comment can name a ref or a command without declaring it, and only the remaining lines describe what GitHub executes.
function dropWorkflowCommentLines(source: string): string {
	return source.split("\n").filter(line => !WORKFLOW_COMMENT_LINE.test(line)).join("\n")
}

// A comment can mention the workspace path or GITHUB_WORKSPACE without reading it, so only the remaining lines describe what the source does.
function dropTypeScriptCommentLines(source: string): string {
	return source.split("\n").filter(line => !TYPESCRIPT_COMMENT_LINE.test(line)).join("\n")
}

interface WorkflowStep {
	readonly name: string | null
	readonly lines: ReadonlyArray<string>
}

interface WorkflowJob {
	readonly name: string
	readonly lines: ReadonlyArray<string>
}

function readStepName(lines: ReadonlyArray<string>): string | null {
	for (const line of lines) {
		const trimmed = line.startsWith("      - ") ? line.slice(8) : line.startsWith("        ") ? line.slice(8) : null
		if (trimmed === null) continue
		if (trimmed.startsWith("name:")) return trimmed.slice(5).trim()
	}
	return null
}

function readWorkflowStepLines(): ReadonlyArray<string> {
	const workflow = readWorkflow()
	const stepsHeading = "    steps:\n"
	const stepsStart = workflow.indexOf(stepsHeading)
	if (stepsStart === -1) throw new Error("ci-agent.yml has no steps: block in its job, so the step scan would examine nothing")
	const stepLines: Array<string> = []
	for (const line of workflow.slice(stepsStart + stepsHeading.length).split("\n")) {
		// A step key starts six spaces in, so a non-empty line that starts shallower ends the job's steps.
		if (line.length !== 0 && !line.startsWith("      ")) break
		stepLines.push(line)
	}
	return stepLines
}

// Every `- ` list item is a step, whether or not it carries a name, so a step written without a name: cannot slip past the provenance assertions.
// A line at any indentation other than a step's own two levels belongs to no step, so the scan fails instead of attributing its inputs to a neighbouring block.
function readWorkflowSteps(): ReadonlyArray<WorkflowStep> {
	const stepLines = readWorkflowStepLines()
	const steps: Array<WorkflowStep> = []
	let currentLines: Array<string> | null = null
	for (const line of stepLines) {
		if (line.startsWith("      - ")) {
			if (currentLines !== null) steps.push({ name: readStepName(currentLines), lines: currentLines })
			currentLines = [line]
			continue
		}
		// A blank line and a comment line carry no key, so neither can misattribute an input.
		if (line.length === 0 || WORKFLOW_COMMENT_LINE.test(line)) {
			if (currentLines !== null) currentLines.push(line)
			continue
		}
		if (!line.startsWith("        ")) throw new Error(`ci-agent.yml has a step line that no parsed step owns, so its inputs would be attributed to a neighbouring step: ${line.trim()}`)
		if (currentLines === null) throw new Error(`ci-agent.yml has a step line before the first step, so no parsed step owns it: ${line.trim()}`)
		currentLines.push(line)
	}
	if (currentLines !== null) steps.push({ name: readStepName(currentLines), lines: currentLines })
	if (steps.length === 0) throw new Error("ci-agent.yml lists no steps, so the step scan would examine nothing")
	const stepStartCount = stepLines.filter(line => line.startsWith("      - ")).length
	if (steps.length !== stepStartCount) throw new Error(`ci-agent.yml lists ${stepStartCount} steps but the parser read ${steps.length} blocks, so a step is not covered by exactly one parsed block`)
	return steps
}

function readWorkflowStepBlock(stepName: string): string {
	const matchingSteps = readWorkflowSteps().filter(step => step.name === stepName)
	if (matchingSteps.length === 0) throw new Error(`ci-agent.yml has no ${stepName} step, so the assertions bound to it would examine nothing`)
	if (matchingSteps.length > 1) throw new Error(`ci-agent.yml has ${matchingSteps.length} ${stepName} steps, so the assertions bound to it would examine more than one block`)
	const step = matchingSteps[0]
	if (step === undefined) throw new Error(`ci-agent.yml has no ${stepName} step, so the assertions bound to it would examine nothing`)
	return step.lines.join("\n")
}

interface RunStepBody {
	readonly start: number
	readonly end: number
	readonly body: string
}

function isBlockScalarIndicator(runValue: string): boolean {
	const indicator = runValue.split(/\s+/)[0]
	return indicator !== undefined && BLOCK_SCALAR_INDICATOR.test(indicator)
}

// A git command can continue onto later lines, either as a block scalar or as a plain scalar continuation, and can carry flags before the subcommand, so the run body is joined before matching.
function readRunStepBody(lines: ReadonlyArray<string>): RunStepBody | null {
	const start = lines.findIndex(line => line.startsWith("        run:"))
	if (start === -1) return null
	const runLine = lines[start]
	if (runLine === undefined) return null
	const runValue = runLine.slice("        run:".length).trim()
	// Only a line indented deeper than the run: key continues the scalar; a line at the key's own indentation starts the step's next key.
	let end = start + 1
	while (end < lines.length) {
		const line = lines[end]
		if (line === undefined) break
		if (line.length === 0) {
			end++
			continue
		}
		if (!line.startsWith("          ")) break
		end++
	}
	const continuationLines = lines.slice(start + 1, end).filter(line => line.length !== 0).map(line => line.trim())
	const firstValueLine = isBlockScalarIndicator(runValue) ? "" : runValue
	const body = [firstValueLine, ...continuationLines].filter(line => line.length !== 0).join(" ")
	return { start, end, body }
}

// A step's own lines describe what it executes, so comment lines are dropped and a multi-line run body is joined before matching.
function readStepScanLines(lines: ReadonlyArray<string>): ReadonlyArray<string> {
	const scanLines = lines.filter(line => !WORKFLOW_COMMENT_LINE.test(line))
	const run = readRunStepBody(scanLines)
	if (run === null) return scanLines
	return [...scanLines.slice(0, run.start), run.body, ...scanLines.slice(run.end)]
}

function findLinesMatching(lines: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>): ReadonlyArray<string> {
	return lines.filter(line => patterns.some(pattern => pattern.test(line)))
}

// A quoted scalar and a trailing comment are syntax, not part of the value, so both are removed before a value is compared.
function unquoteScalarValue(raw: string): string {
	const trimmed = raw.trim()
	const quote = trimmed.charAt(0)
	if (quote === "\"" || quote === "'") {
		const closingIndex = trimmed.indexOf(quote, 1)
		if (closingIndex !== -1) return trimmed.slice(1, closingIndex)
	}
	const commentIndex = trimmed.search(/\s#/)
	return commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex).trim()
}

function readUsesActionName(line: string): string | null {
	const match = STEP_USES_LINE.exec(line)
	const rawValue = match?.[1]
	if (rawValue === undefined) return null
	const trimmed = rawValue.trim()
	const quoted = trimmed.startsWith("\"") || trimmed.startsWith("'")
	return unquoteScalarValue(quoted ? trimmed : trimmed.replace(STEP_USES_TRAILING_COMMENT, ""))
}

function isCheckoutUsesLine(line: string): boolean {
	const actionName = readUsesActionName(line)
	return actionName !== null && actionName.startsWith(CHECKOUT_ACTION_PREFIX)
}

function readRunCiAgentStepEnvironmentBlock(): string {
	const stepBlock = readWorkflowStepBlock("Run CI Agent")
	const environmentStart = stepBlock.indexOf("        env:\n")
	if (environmentStart === -1) throw new Error("ci-agent.yml Run CI Agent step has no env: block, so no environment variable reaches the container")
	return stepBlock.slice(environmentStart)
}

function readWorkflowPermissionsBlock(): string {
	const workflow = readWorkflow()
	const permissionsStart = workflow.indexOf("\npermissions:\n")
	if (permissionsStart === -1) throw new Error("ci-agent.yml has no permissions block, so the workflow cannot grant the scope that removing the trigger label needs")
	const permissionsEnd = workflow.indexOf("\njobs:", permissionsStart)
	return workflow.slice(permissionsStart, permissionsEnd === -1 ? undefined : permissionsEnd)
}

function readWorkflowPermissionGrants(): ReadonlyArray<string> {
	const grants: Array<string> = []
	for (const line of readWorkflowPermissionsBlock().split("\n")) {
		const match = WORKFLOW_PERMISSION_ENTRY.exec(line)
		const scope = match?.[1]
		const level = match?.[2]
		if (scope === undefined || level === undefined) continue
		grants.push(`${scope}: ${level}`)
	}
	return grants
}

function readWorkflowJobLines(): ReadonlyArray<string> {
	const lines = readWorkflow().split("\n")
	const jobsHeadingIndex = lines.findIndex(line => line === "jobs:")
	if (jobsHeadingIndex === -1) throw new Error("ci-agent.yml has no jobs: block, so the permissions assertions cannot tell which jobs grant permissions")
	const jobLines: Array<string> = []
	for (const line of lines.slice(jobsHeadingIndex + 1)) {
		// A top-level key starts in column zero, so the jobs block ends at the next line that does.
		if (line.length !== 0 && !line.startsWith(" ") && !WORKFLOW_COMMENT_LINE.test(line)) break
		jobLines.push(line)
	}
	return jobLines
}

// Every job declared under jobs: is parsed, so a job declared before or after ci-agent cannot carry a permissions: key past the scan.
function readWorkflowJobs(): ReadonlyArray<WorkflowJob> {
	const jobs: Array<{ name: string; lines: Array<string> }> = []
	for (const line of readWorkflowJobLines()) {
		const jobName = WORKFLOW_JOB_DECLARATION.exec(line)?.[1]
		if (jobName !== undefined) {
			jobs.push({ name: jobName, lines: [line] })
			continue
		}
		const currentJob = jobs[jobs.length - 1]
		if (currentJob !== undefined) {
			currentJob.lines.push(line)
			continue
		}
		if (line.length === 0 || WORKFLOW_COMMENT_LINE.test(line)) continue
		throw new Error(`ci-agent.yml has a line in its jobs: block that no job owns: ${line.trim()}`)
	}
	if (jobs.length === 0) throw new Error("ci-agent.yml declares no jobs, so the permissions assertions would examine nothing")
	return jobs
}

// Comment lines are dropped because a comment can name a trigger or a permission without granting it, and only the entries themselves decide what starts a run.
function readWorkflowOnBlockEntries(): string {
	const workflow = readWorkflow()
	const onStart = workflow.indexOf("\non:\n")
	if (onStart === -1) throw new Error("ci-agent.yml has no on: block, so no event would start a run")
	const onEnd = workflow.indexOf("\npermissions:", onStart)
	return dropWorkflowCommentLines(workflow.slice(onStart, onEnd === -1 ? undefined : onEnd))
}

// Intentional divergence from AGENTS.md: integration tests are discouraged because they are slow and exercise glue that should be kept thin.
// These tests are the only place we tolerate that cost, and they are intentionally kept minimalistic.
describe("integration", () => {
	it("has a Default.md agent in the agents directory", () => {
		expect(existsSync(join(PROJECT_ROOT, "agents", "Default.md"))).toBe(true)
	})

	it("has an Aggregator.md agent in the agents directory", () => {
		expect(existsSync(join(PROJECT_ROOT, "agents", "Aggregator.md"))).toBe(true)
	})

	it("Dockerfile paths match the constants in source/paths.mts", () => {
		const dockerfile = readProjectFile("Dockerfile")
		expect(dockerfile).toContain(`COPY --from=builder /ci-agent/agents/ ${BUILTIN_AGENTS_DIRECTORY}`)
		expect(dockerfile).toContain(`COPY --from=builder /ci-agent/source/ /ci-agent/source/`)
		expect(dockerfile).toContain(`VOLUME ${DEBUG_DIRECTORY}`)
		expect(dockerfile).toContain(`WORKDIR ${getWorkspaceDirectory({})}`)
	})

	it("documents every environment variable source/configuration.mts reads", () => {
		const readme = readProjectFile("README.md")
		const variableNames = [...readConfigurationEnvironmentVariableNames()]
		// A derivation that finds nothing would make the check below pass without examining anything.
		expect(variableNames.length).toBeGreaterThan(0)
		const undocumented = variableNames.filter(name => !WORKFLOW_INJECTED_ENVIRONMENT_VARIABLES.has(name) && !readme.includes(`- \`${name}\` - `))
		expect(undocumented).toEqual([])
	})

	it("documents that only the review start label is an accepted TRIGGER_LABEL", () => {
		const readme = readProjectFile("README.md")
		// The trigger section's prose is the only place that tells a direct-container user what a set TRIGGER_LABEL must be, so it has to name the accepted value and the failure a wrong one causes.
		expect(readme).toContain(`A \`TRIGGER_LABEL\` set to anything other than exactly \`${REVIEW_START_LABEL}\` fails the run instead of reviewing the pull request.`)
	})

	it("documents GitHub mode environment variables under the GitHub PR Review list only", () => {
		const gitHubVariableNames = [...readGitHubConfigurationEnvironmentVariableNames()]
		// A derivation that finds nothing would make the checks below pass without examining anything.
		expect(gitHubVariableNames.length).toBeGreaterThan(0)
		const localDiffDocumented = readDocumentedVariableNames(LOCAL_DIFF_MODE_HEADING)
		const gitHubPrDocumented = readDocumentedVariableNames(GITHUB_PR_MODE_HEADING)
		expect(gitHubVariableNames.filter(name => !gitHubPrDocumented.has(name))).toEqual([])
		expect(gitHubVariableNames.filter(name => localDiffDocumented.has(name))).toEqual([])
	})

	it("documents a Reviewer label for every agent prompt in .ci-agents and no name outside the selectable agents", () => {
		const userAgents = readUserAgents()
		const userAgentNames = userAgents.map(agent => agent.name)
		// The label table is where a reader learns which labels to create by hand, so a missing row makes a reviewer unreachable and a row for an unselectable name guarantees a failed run.
		expect(userAgentNames.length).toBeGreaterThan(0)
		// source/agents.mts owns the aggregator exclusion and the de-duplication, so the documented labels are checked against the same rule the run applies.
		const selectableNames = selectableAgentNames(userAgents, readBuiltinAgents())
		const reviewerLabelAgentNames = readReviewerLabelRowAgentNames()
		expect(userAgentNames.filter(name => !reviewerLabelAgentNames.includes(name))).toEqual([])
		expect(reviewerLabelAgentNames.filter(name => !selectableNames.includes(name))).toEqual([])
		expect(new Set(reviewerLabelAgentNames).size).toBe(reviewerLabelAgentNames.length)
		expect(readProjectFile("README.md")).toContain(`| \`${REVIEW_START_LABEL}\` |`)
	})

	it("workflow passes AI_MAX_TOKENS through to the agent", () => {
		expect(readRunCiAgentStepEnvironmentBlock()).toContain("\n          AI_MAX_TOKENS: ${{ vars.AI_MAX_TOKENS }}\n")
	})

	// CI configuration, scripts, and prompts must come from the base branch and never from pull request content; the tests below are what fails when an edit starts following the pull request instead.
	it("keeps the named checkout step free of any ref, so the checkout comes from the base branch", () => {
		const checkoutLines = dropWorkflowCommentLines(readWorkflowStepBlock("Checkout repository")).split("\n")
		// actions/checkout follows the base branch only while it is given no ref, so any ref sends the checkout somewhere other than the base branch, whatever the ref names.
		expect(checkoutLines.filter(line => WORKFLOW_REF_DECLARATION.test(line))).toEqual([])
		// Another action at the same step name could take a different input or its own default ref, so the step has to stay the checkout of the base branch.
		expect(checkoutLines.filter(isCheckoutUsesLine).length).toBe(1)
	})

	it("keeps every workflow step away from a pull request head ref or head commit", () => {
		const steps = readWorkflowSteps()
		// Every offending line is reported with the step that carries it, so a failure points at the edit that let pull request content into the run.
		const offendingLines = steps.flatMap(step => findLinesMatching(readStepScanLines(step.lines), PULL_REQUEST_HEAD_PATTERNS).map(line => `${step.name ?? "unnamed step"}: ${line.trim()}`))
		expect(offendingLines).toEqual([])
	})

	it("keeps every workflow step away from a pull request merge ref", () => {
		const steps = readWorkflowSteps()
		const offendingLines = steps.flatMap(step => findLinesMatching(readStepScanLines(step.lines), PULL_REQUEST_MERGE_PATTERNS).map(line => `${step.name ?? "unnamed step"}: ${line.trim()}`))
		expect(offendingLines).toEqual([])
	})

	it("keeps every workflow step away from pull request text carried in the event payload", () => {
		const steps = readWorkflowSteps()
		// The payload is where the pull request title, body, and head branch arrive, so interpolating it into a step is the other way to hand authored text to the run.
		const offendingLines = steps.flatMap(step => findLinesMatching(readStepScanLines(step.lines), EVENT_PAYLOAD_PATTERNS).map(line => `${step.name ?? "unnamed step"}: ${line.trim()}`))
		expect(offendingLines).toEqual([])
	})

	it("keeps the agent step reading its prompts from the checkout workspace", () => {
		const workflow = readWorkflow()
		const checkoutStart = workflow.indexOf("      - name: Checkout repository\n")
		const agentStart = workflow.indexOf("      - name: Run CI Agent\n")
		// The prompts come from the checkout only while the agent step runs after it, against the same directory.
		expect(checkoutStart).toBeGreaterThan(-1)
		expect(agentStart).toBeGreaterThan(checkoutStart)
		const agentLines = dropWorkflowCommentLines(readWorkflowStepBlock("Run CI Agent")).split("\n")
		// source/paths.mts reads GITHUB_WORKSPACE and the step runs in the job's workspace, so either override would point the prompt read away from the checkout.
		expect(agentLines.filter(line => /^\s+working-directory:/.test(line))).toEqual([])
		expect(agentLines.filter(line => /^\s+GITHUB_WORKSPACE:/.test(line))).toEqual([])
		// The run line and the two source lines below are the code path that resolves the agent prompts from the checkout workspace instead of from pull request content.
		expect(agentLines.map(line => line.trim())).toContain("run: bun /ci-agent/source/index.mts")
		expect(dropTypeScriptCommentLines(readProjectFile("source", "index.mts"))).toContain("${workspaceDirectory}/.ci-agents")
		expect(dropTypeScriptCommentLines(readProjectFile("source", "paths.mts"))).toContain("environment.GITHUB_WORKSPACE")
	})

	it("binds the workflow trigger label environment line to the label that started the run", () => {
		// Renaming or dropping this line would send every labeled run down pull-request mode with every reviewer and nothing else would fail.
		expect(readRunCiAgentStepEnvironmentBlock()).toContain("\n          TRIGGER_LABEL: ${{ github.event.label.name }}\n")
	})

	it("binds the reviewer selector prefix to the documented labels", () => {
		const readme = readProjectFile("README.md")
		// The prefix is what makes a label a selector, so a README that documented an older prefix would leave every selector label silently inert.
		expect(readme).toContain(`| \`${REVIEWER_LABEL_PREFIX}`)
	})

	it("binds the workflow job gate to the review start label constant", () => {
		const workflow = readWorkflow()
		const gateLine = workflow.split("\n").find(line => line.includes("github.event.label.name =="))
		if (gateLine === undefined) throw new Error("ci-agent.yml has no job gate comparing github.event.label.name, so a labeled run would start for any applied label")
		expect(gateLine).toContain(`github.event.label.name == '${REVIEW_START_LABEL}'`)
	})

	it("keeps the pull-request events that start a run in the workflow triggers", () => {
		const triggerTypesLine = readWorkflowOnBlockEntries().split("\n").find(line => line.includes("types:"))
		if (triggerTypesLine === undefined) throw new Error("ci-agent.yml pull_request_target trigger lists no event types, so no pull-request event would start a run")
		// Dropping `labeled` would silently disable every label-triggered review, and dropping `opened` would stop the automatic review of a new pull request.
		expect(triggerTypesLine).toContain("opened")
		expect(triggerTypesLine).toContain("labeled")
	})

	it("limits the workflow triggers to the pull request and manual events", () => {
		// An event outside the pull request and manual triggers would start a run from something other than a pull request, so no other event belongs in the on: block.
		const issueCommentEventLines = readWorkflowOnBlockEntries().split("\n").filter(line => line.includes("issue_comment"))
		expect(issueCommentEventLines).toEqual([])
	})

	it("grants the workflow exactly the permissions its GitHub calls need and no other scope", () => {
		// An allowlist rather than a denylist: any scope beyond these three widens the token the reviewed pull request runs with, so a `contents: write`, `actions: write`, `id-token: write`, or `checks: write` entry fails here.
		expect([...readWorkflowPermissionGrants()].sort()).toEqual(["contents: read", "issues: write", "pull-requests: write"])
		const jobs = readWorkflowJobs()
		// A job-level permissions: key replaces the workflow-level grant, so a job that declares one bypasses the allowlist above whatever its own entries say.
		expect(jobs.map(job => job.name)).toContain("ci-agent")
		expect(jobs.filter(job => job.lines.some(line => WORKFLOW_JOB_PERMISSIONS_KEY.test(line))).map(job => job.name)).toEqual([])
	})
})
