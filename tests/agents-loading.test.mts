import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { loadAgents, loadAggregator } from "../source/agents.mts"
import type { AgentDirs } from "../source/agents.mts"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { existsSync } from "node:fs"

const TMP_ROOT = join(import.meta.dir, "__tmp_agent_dirs__")

function tmpDir(name: string): string {
	return join(TMP_ROOT, name)
}

async function createDir(dir: string): Promise<void> {
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true })
	}
}

async function createAgentFile(dir: string, name: string, content: string): Promise<void> {
	await createDir(dir)
	await writeFile(join(dir, `${name}.md`), content)
}

async function cleanupTmp(): Promise<void> {
	if (existsSync(TMP_ROOT)) {
		await rm(TMP_ROOT, { recursive: true, force: true })
	}
}

describe("loadAgents", () => {
	beforeEach(cleanupTmp)
	afterEach(cleanupTmp)

	it("returns Default when no agent names specified and no user agents exist", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("empty_user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createDir(dirs.userAgentsDir)
		await createAgentFile(dirs.builtinAgentsDir, "Default", "Default agent prompt")
		await createAgentFile(dirs.builtinAgentsDir, "Aggregator", "Aggregator prompt")

		const result = await loadAgents([], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
		expect(result.unresolvedNames).toEqual([])
	})

	it("returns all user agents when no agent names specified and user agents exist", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "SecurityAgent", "Security prompt")
		await createAgentFile(dirs.userAgentsDir, "StyleAgent", "Style prompt")
		await createAgentFile(dirs.builtinAgentsDir, "Default", "Default prompt")

		const result = await loadAgents([], dirs)

		expect(result.agents).toHaveLength(2)
		expect(result.agents.map(a => a.name)).toEqual(["SecurityAgent", "StyleAgent"])
	})

	it("resolves named agents from user directory first", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "SecurityAgent", "User security prompt")
		await createAgentFile(dirs.builtinAgentsDir, "SecurityAgent", "Builtin security prompt")

		const result = await loadAgents(["SecurityAgent"], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("User security prompt")
	})

	it("resolves named agents from builtin directory when not in user directory", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("empty_user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createDir(dirs.userAgentsDir)
		await createAgentFile(dirs.builtinAgentsDir, "Default", "Default prompt")

		const result = await loadAgents(["Default"], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.prompt).toBe("Default prompt")
	})

	it("reports unresolved agent names", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("empty_user"),
			builtinAgentsDir: tmpDir("empty_builtins"),
		}
		await createDir(dirs.userAgentsDir)
		await createDir(dirs.builtinAgentsDir)

		const result = await loadAgents(["NonExistent"], dirs)

		expect(result.agents).toHaveLength(0)
		expect(result.unresolvedNames).toEqual(["NonExistent"])
	})

	it("reports only unresolved names while still returning resolved agents", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("empty_builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "SecurityAgent", "Security prompt")
		await createDir(dirs.builtinAgentsDir)

		const result = await loadAgents(["SecurityAgent", "NonExistent"], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
		expect(result.unresolvedNames).toEqual(["NonExistent"])
	})

	it("filters out Aggregator from user agents", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "Aggregator", "User aggregator")
		await createAgentFile(dirs.userAgentsDir, "SecurityAgent", "Security prompt")
		await createDir(dirs.builtinAgentsDir)

		const result = await loadAgents([], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
	})

	it("filters out Aggregator from builtin agents", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("empty_user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createDir(dirs.userAgentsDir)
		await createAgentFile(dirs.builtinAgentsDir, "Aggregator", "Builtin aggregator")
		await createAgentFile(dirs.builtinAgentsDir, "Default", "Default prompt")

		const result = await loadAgents([], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("Default")
	})

	it("reports Default as unresolved when directories do not exist and no names specified", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("nonexistent_user"),
			builtinAgentsDir: tmpDir("nonexistent_builtins"),
		}

		const result = await loadAgents([], dirs)

		expect(result.agents).toEqual([])
		expect(result.unresolvedNames).toEqual(["Default"])
	})

	it("resolves agent names case-insensitively", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "SecurityAgent", "Security prompt")
		await createDir(dirs.builtinAgentsDir)

		const result = await loadAgents(["securityagent"], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
		expect(result.unresolvedNames).toEqual([])
	})

	it("only loads .md files", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("empty_builtins"),
		}
		await createDir(dirs.builtinAgentsDir)
		await createAgentFile(dirs.userAgentsDir, "SecurityAgent", "Security prompt")
		await writeFile(join(dirs.userAgentsDir, "notes.txt"), "Not an agent")

		const result = await loadAgents([], dirs)

		expect(result.agents).toHaveLength(1)
		expect(result.agents[0]!.name).toBe("SecurityAgent")
	})
})

describe("loadAggregator", () => {
	beforeEach(cleanupTmp)
	afterEach(cleanupTmp)

	it("returns user aggregator when it exists", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "Aggregator", "User aggregator")
		await createAgentFile(dirs.builtinAgentsDir, "Aggregator", "Builtin aggregator")

		const aggregator = await loadAggregator(dirs)

		expect(aggregator).not.toBeNull()
		expect(aggregator!.prompt).toBe("User aggregator")
	})

	it("returns builtin aggregator when no user aggregator exists", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("empty_user"),
			builtinAgentsDir: tmpDir("builtins"),
		}
		await createDir(dirs.userAgentsDir)
		await createAgentFile(dirs.builtinAgentsDir, "Aggregator", "Builtin aggregator")

		const aggregator = await loadAggregator(dirs)

		expect(aggregator).not.toBeNull()
		expect(aggregator!.prompt).toBe("Builtin aggregator")
	})

	it("returns null when no aggregator exists anywhere", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("empty_user"),
			builtinAgentsDir: tmpDir("empty_builtins"),
		}
		await createDir(dirs.userAgentsDir)
		await createDir(dirs.builtinAgentsDir)

		const aggregator = await loadAggregator(dirs)

		expect(aggregator).toBeNull()
	})

	it("matches aggregator case-insensitively", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("user"),
			builtinAgentsDir: tmpDir("empty_builtins"),
		}
		await createAgentFile(dirs.userAgentsDir, "aggregator", "Lowercase aggregator")
		await createDir(dirs.builtinAgentsDir)

		const aggregator = await loadAggregator(dirs)

		expect(aggregator).not.toBeNull()
		expect(aggregator!.name).toBe("aggregator")
	})

	it("returns null when directories do not exist", async () => {
		const dirs: AgentDirs = {
			userAgentsDir: tmpDir("nonexistent_user"),
			builtinAgentsDir: tmpDir("nonexistent_builtins"),
		}

		const aggregator = await loadAggregator(dirs)

		expect(aggregator).toBeNull()
	})
})
