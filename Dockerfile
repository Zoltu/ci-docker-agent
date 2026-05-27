### Builder
FROM oven/bun:1.3.12-debian@sha256:fb9a3c2030bcb05a687c466ebc5d98af4eb0c58bae2c142d9913d100e0d88148 AS builder

# Enable Debian snapshot repository for reproducible builds
RUN <<EOF
	sed -i 's|^URIs:|# URIs:|' /etc/apt/sources.list.d/debian.sources
	sed -i 's|^# http://snapshot|URIs: http://snapshot|' /etc/apt/sources.list.d/debian.sources
EOF

# install dependencies, making sure debian package history hasn't been tampered with
RUN <<-EOF
	set -e
	apt-get update -o Acquire::Check-Valid-Until=false
	echo "471db8082190a3cfd344b0d08ffadcb2769abdbc0f75ea2ee1e1b937dd9e9d29  /var/lib/apt/lists/snapshot.debian.org_archive_debian-security_20260406T000000Z_dists_trixie-security_InRelease
	ce2a89c36c0590c968f690bcdcdf06df8767efdcc9ffbe0b5a7cf63623902b81  /var/lib/apt/lists/snapshot.debian.org_archive_debian_20260406T000000Z_dists_trixie-updates_InRelease
	7592e4ccb4658a58bfe485d3356b3c983bf8ccff7fca1f6091e4d4296284ed18  /var/lib/apt/lists/snapshot.debian.org_archive_debian_20260406T000000Z_dists_trixie_InRelease" | sha256sum -c
	apt-get install -y --no-install-recommends git
	rm -rf /var/lib/apt/lists/*
EOF

WORKDIR /ci-agent

COPY package.json /ci-agent/package.json
COPY tsconfig.json /ci-agent/tsconfig.json
COPY bun.lock /ci-agent/bun.lock
RUN bun run setup

COPY agents/ /ci-agent/agents/
COPY source/ /ci-agent/source/
COPY tests/ /ci-agent/tests/

# Seed a git history so diff tests have commits to work with
RUN <<EOF
	set -e
	git init
	git config user.email "docker@builder.local"
	git config user.name "Builder"
	git add .
	git commit -m "first"
	echo "dummy" > /ci-agent/.docker-dummy
	git add .
	git commit -m "second"
EOF

RUN bun run typecheck
RUN bun test


### Final
FROM oven/bun:1.3.12-debian@sha256:fb9a3c2030bcb05a687c466ebc5d98af4eb0c58bae2c142d9913d100e0d88148

# Enable Debian snapshot repository for reproducible builds
RUN <<EOF
	sed -i 's|^URIs:|# URIs:|' /etc/apt/sources.list.d/debian.sources
	sed -i 's|^# http://snapshot|URIs: http://snapshot|' /etc/apt/sources.list.d/debian.sources
EOF

# install dependencies, making sure debian package history hasn't been tampered with
RUN <<EOF
	set -e
	apt-get update -o Acquire::Check-Valid-Until=false
	echo "471db8082190a3cfd344b0d08ffadcb2769abdbc0f75ea2ee1e1b937dd9e9d29  /var/lib/apt/lists/snapshot.debian.org_archive_debian-security_20260406T000000Z_dists_trixie-security_InRelease
	ce2a89c36c0590c968f690bcdcdf06df8767efdcc9ffbe0b5a7cf63623902b81  /var/lib/apt/lists/snapshot.debian.org_archive_debian_20260406T000000Z_dists_trixie-updates_InRelease
	7592e4ccb4658a58bfe485d3356b3c983bf8ccff7fca1f6091e4d4296284ed18  /var/lib/apt/lists/snapshot.debian.org_archive_debian_20260406T000000Z_dists_trixie_InRelease" | sha256sum -c
	apt-get install -y --no-install-recommends git ca-certificates
	rm -rf /var/lib/apt/lists/*
EOF

# Configure git to trust the workspace directory (for bun user)
RUN git config --global --add safe.directory /github/workspace

# Must stay in sync with source/paths.mts WORKSPACE_DIRECTORY
WORKDIR /github/workspace

# Must stay in sync with source/paths.mts BUILTIN_AGENTS_DIRECTORY
COPY --from=builder /ci-agent/agents/ /ci-agent/agents/
COPY --from=builder /ci-agent/source/ /ci-agent/source/

# Must stay in sync with source/paths.mts DEBUG_DIRECTORY
VOLUME /debug

ENTRYPOINT ["bun", "/ci-agent/source/index.mts"]
