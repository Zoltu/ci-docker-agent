export const WORKSPACE_DIRECTORY = "/github/workspace"

export const USER_AGENTS_DIRECTORY = `${WORKSPACE_DIRECTORY}/.ci-agents`

// Must stay in sync with Dockerfile COPY destination for agents/
export const BUILTIN_AGENTS_DIRECTORY = "/ci-agent/agents"
