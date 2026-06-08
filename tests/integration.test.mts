import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
})
