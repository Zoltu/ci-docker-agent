import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EXISTING_CHECK_RUN_JOB_NAME } from "../source/orchestrator.mts"
import { BUILTIN_AGENTS_DIRECTORY, DEBUG_DIRECTORY, getWorkspaceDirectory } from "../source/paths.mts"

const PROJECT_ROOT = join(import.meta.dir, "..")

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
		const dockerfile = readFileSync(join(PROJECT_ROOT, "Dockerfile"), "utf-8")
		expect(dockerfile).toContain(`COPY --from=builder /ci-agent/agents/ ${BUILTIN_AGENTS_DIRECTORY}`)
		expect(dockerfile).toContain(`COPY --from=builder /ci-agent/source/ /ci-agent/source/`)
		expect(dockerfile).toContain(`VOLUME ${DEBUG_DIRECTORY}`)
		expect(dockerfile).toContain(`WORKDIR ${getWorkspaceDirectory({})}`)
	})

	it("workflow job id matches the EXISTING_CHECK_RUN_JOB_NAME constant", () => {
		const workflow = readFileSync(join(PROJECT_ROOT, ".github", "workflows", "ci-agent.yml"), "utf-8")
		// Match the job id line; the trailing colon disambiguates from comment mentions and the constant name itself.
		const jobIdPattern = new RegExp(`^\\s*${EXISTING_CHECK_RUN_JOB_NAME}:\\s*$`, "m")
		expect(workflow).toMatch(jobIdPattern)
	})

	it("workflow passes AI_MAX_TOKENS through to the agent", () => {
		const workflow = readFileSync(join(PROJECT_ROOT, ".github", "workflows", "ci-agent.yml"), "utf-8")
		// A bare substring check would still pass on a moved or mis-indented line, so bind the assertion to the Run CI Agent step's env: block and its exact indentation.
		const stepStart = workflow.indexOf("      - name: Run CI Agent\n")
		expect(stepStart).toBeGreaterThan(-1)
		const nextStepStart = workflow.indexOf("\n      - name: ", stepStart)
		const stepBlock = workflow.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart)
		const envStart = stepBlock.indexOf("        env:\n")
		expect(envStart).toBeGreaterThan(-1)
		const envBlock = stepBlock.slice(envStart)
		expect(envBlock).toContain("\n          AI_MAX_TOKENS: ${{ vars.AI_MAX_TOKENS }}\n")
		const readme = readFileSync(join(PROJECT_ROOT, "README.md"), "utf-8")
		expect(readme).toContain("\n          AI_MAX_TOKENS: ${{ vars.AI_MAX_TOKENS }}\n")
	})
})
