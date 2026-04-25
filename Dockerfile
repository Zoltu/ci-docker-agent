### Builder
FROM oven/bun:1.3.12-debian@sha256:fb9a3c2030bcb05a687c466ebc5d98af4eb0c58bae2c142d9913d100e0d88148 AS builder

WORKDIR /ci-agent

COPY package.json /ci-agent/package.json
COPY tsconfig.json /ci-agent/tsconfig.json
COPY bun.lock /ci-agent/bun.lock
RUN bun run setup

COPY agents/ /ci-agent/agents/
COPY source/ /ci-agent/source/
COPY tests/ /ci-agent/tests/
RUN bun test


### Final
FROM oven/bun:1.3.12-debian@sha256:fb9a3c2030bcb05a687c466ebc5d98af4eb0c58bae2c142d9913d100e0d88148

# Enable Debian snapshot repository for reproducible builds
RUN <<EOF
	sed -i 's|^URIs:|# URIs:|' /etc/apt/sources.list.d/debian.sources
	sed -i 's|^# http://snapshot|URIs: http://snapshot|' /etc/apt/sources.list.d/debian.sources
EOF

RUN <<EOF
	set -e
	apt-get update -o Acquire::Check-Valid-Until=false
	apt-get install -y --no-install-recommends git=1:2.47.3-0+deb13u1
	rm -rf /var/lib/apt/lists/*
EOF

# Configure git to trust the workspace directory (for bun user)
RUN git config --global --add safe.directory /github/workspace

# Must stay in sync with source/paths.mts WORKSPACE_DIRECTORY
WORKDIR /github/workspace

# Must stay in sync with source/paths.mts BUILTIN_AGENTS_DIR
COPY --from=builder /ci-agent/agents/ /ci-agent/agents/
COPY --from=builder /ci-agent/source/ /ci-agent/source/

ENTRYPOINT ["bun", "/ci-agent/source/index.mts"]
