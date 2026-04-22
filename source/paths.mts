export const WORKSPACE_DIR = "/github/workspace"

export const USER_AGENTS_DIR = `${WORKSPACE_DIR}/.ci-agents`

// Must stay in sync with Dockerfile COPY destination for agents/
export const BUILTIN_AGENTS_DIR = "/ci-agent/agents"
