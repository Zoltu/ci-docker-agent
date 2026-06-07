export function getWorkspaceDirectory(environment: Record<string, string | undefined>): string {
	return environment.GITHUB_WORKSPACE ?? "/workspace"
}

// Must stay in sync with Dockerfile COPY destination for agents/
export const BUILTIN_AGENTS_DIRECTORY = "/ci-agent/agents"

// Must stay in sync with Dockerfile VOLUME
export const DEBUG_DIRECTORY = "/debug"
