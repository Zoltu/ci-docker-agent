FROM oven/bun:1.3.12-debian@sha256:fb9a3c2030bcb05a687c466ebc5d98af4eb0c58bae2c142d9913d100e0d88148

WORKDIR /github/workspace

COPY ci-agent/ /github/workspace/ci-agent/

ENTRYPOINT ["bun", "/github/workspace/ci-agent/source/index.mts"]
