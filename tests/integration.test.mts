import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EXISTING_CHECK_RUN_JOB_NAME } from "../source/orchestrator.mts"
import { BUILTIN_AGENTS_DIRECTORY, DEBUG_DIRECTORY, getWorkspaceDirectory } from "../source/paths.mts"

const PROJECT_ROOT = join(import.meta.dir, "..")
const LOCAL_DIFF_MODE_HEADING = "### Mode 1: Local Diff Analysis"
const GITHUB_PR_MODE_HEADING = "### Mode 2: GitHub PR Review"
const ENVIRONMENT_VARIABLE_REFERENCE = /environment\.([A-Z][A-Z0-9_]*)/g
const DOCUMENTED_VARIABLE_BULLET = /^- `([A-Z][A-Z0-9_]*)` - /gm

// COMMENT_BODY arrives from the triggering comment event through the workflow's env: block, so it is never set by whoever runs the container and README does not present it as configuration.
const WORKFLOW_INJECTED_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set(["COMMENT_BODY"])

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

	it("workflow job id matches the EXISTING_CHECK_RUN_JOB_NAME constant", () => {
		const workflow = readProjectFile(".github", "workflows", "ci-agent.yml")
		// Match the job id line; the trailing colon disambiguates from comment mentions and the constant name itself.
		const jobIdPattern = new RegExp(`^\\s*${EXISTING_CHECK_RUN_JOB_NAME}:\\s*$`, "m")
		expect(workflow).toMatch(jobIdPattern)
	})

	it("documents every environment variable source/configuration.mts reads", () => {
		const readme = readProjectFile("README.md")
		const undocumented = [...readConfigurationEnvironmentVariableNames()]
			.filter(name => !WORKFLOW_INJECTED_ENVIRONMENT_VARIABLES.has(name))
			.filter(name => !readme.includes(`- \`${name}\` - `))
		expect(undocumented).toEqual([])
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

	it("workflow passes AI_MAX_TOKENS through to the agent", () => {
		const workflow = readProjectFile(".github", "workflows", "ci-agent.yml")
		// A bare substring check would still pass on a moved or mis-indented line, so bind the assertion to the Run CI Agent step's env: block and its exact indentation.
		const stepStart = workflow.indexOf("      - name: Run CI Agent\n")
		expect(stepStart).toBeGreaterThan(-1)
		const nextStepStart = workflow.indexOf("\n      - name: ", stepStart)
		const stepBlock = workflow.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart)
		const envStart = stepBlock.indexOf("        env:\n")
		expect(envStart).toBeGreaterThan(-1)
		const envBlock = stepBlock.slice(envStart)
		expect(envBlock).toContain("\n          AI_MAX_TOKENS: ${{ vars.AI_MAX_TOKENS }}\n")
	})
})
