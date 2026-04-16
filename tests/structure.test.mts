import { describe, it, expect } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const PROJECT_ROOT = join(import.meta.dir, "..")

describe("build integrity", () => {
	it("has a builtin Aggregator agent", () => {
		const aggregatorPath = join(PROJECT_ROOT, "agents", "Aggregator.md")
		expect(existsSync(aggregatorPath)).toBe(true)
	})
})