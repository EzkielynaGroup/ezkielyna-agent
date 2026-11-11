# Build from the repository root with:
#   docker build -f bench/docker/Dockerfile -t ezk-bench2 .
#   docker build -f bench/docker/Dockerfile --build-arg OPENCODE_UPSTREAM_SHA256=<sha256 of the tar.gz> -t ezk-bench2 .
FROM golang:1.24-bookworm

# Upstream OpenCode for the `--agent upstream` arm: the tag this fork is based on. The archive is the one upstream's own
# `install` script fetches (git show v1.19.3:install: https://github.com/anomalyco/opencode/releases/download/v<ver>/
# opencode-linux-x64.tar.gz, binary `opencode` at the archive root; the installer verifies no checksum, so none is
# published with the release). Pin OPENCODE_UPSTREAM_SHA256 after the first download so later builds fail on a
# changed asset; an empty value only prints a warning.
ARG OPENCODE_UPSTREAM_VERSION=1.19.3
ARG OPENCODE_UPSTREAM_SHA256=

ENV PATH="/opt/bun/bin:/usr/local/bin:${PATH}" \
    BUN_INSTALL=/opt/bun

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git iptables python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_UPSTREAM_VERSION}/opencode-linux-x64.tar.gz" \
      -o /tmp/opencode-upstream.tar.gz \
  && if [ -n "$OPENCODE_UPSTREAM_SHA256" ]; then echo "$OPENCODE_UPSTREAM_SHA256  /tmp/opencode-upstream.tar.gz" | sha256sum -c -; \
     else echo "WARNING: OPENCODE_UPSTREAM_SHA256 not set; upstream archive not verified" >&2; fi \
  && mkdir -p /tmp/opencode-upstream \
  && tar -xzf /tmp/opencode-upstream.tar.gz -C /tmp/opencode-upstream \
  && install -m 0755 /tmp/opencode-upstream/opencode /usr/local/bin/opencode \
  && rm -rf /tmp/opencode-upstream /tmp/opencode-upstream.tar.gz \
  && OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 /usr/local/bin/opencode --version

RUN curl -fsSL https://bun.sh/install | bash \
  && install -m 0755 /opt/bun/bin/bun /usr/local/bin/bun

# The released CLI tarball is copied into the build context by scripts/vps_bench.sh (release/<ver>/files, the same signed
# artifact testers download) together with its SHA256 line from SHA256SUMS; downloading it from ezkielyna.store inside the
# build kept failing mid-transfer on the VPS. The image build never receives a user key.
COPY bench/docker/ezkielyna-cli.tar.gz /tmp/ezkielyna-cli.tar.gz
COPY bench/docker/ezkielyna-cli.sha256 /tmp/ezkielyna-cli.sha256
RUN cd /tmp && sed 's# .*# /tmp/ezkielyna-cli.tar.gz#' ezkielyna-cli.sha256 | sha256sum -c - \
  && mkdir -p /tmp/ezk-cli && tar -xzf /tmp/ezkielyna-cli.tar.gz -C /tmp/ezk-cli \
  && candidate="$(find /tmp/ezk-cli -type f -name ezkielyna -print -quit)" \
  && test -n "$candidate" \
  && install -m 0755 "$candidate" /usr/local/bin/ezkielyna \
  && rm -rf /tmp/ezk-cli /tmp/ezkielyna-cli.tar.gz /tmp/ezkielyna-cli.sha256

WORKDIR /workspace
COPY bench ./bench
COPY packages/core/src/ezk/pricing.ts ./packages/core/src/ezk/pricing.ts
COPY packages/core/src/ezk/pricing-static.ts ./packages/core/src/ezk/pricing-static.ts
# the --dry-run mock gateway (bench/lib/mock-gateway.ts imports it): lets the VPS image check the harness without a key
COPY packages/core/test/ezk/mock-gateway.ts ./packages/core/test/ezk/mock-gateway.ts
RUN chmod -R a-w /workspace/bench/tasks \
  && chmod 0555 /workspace/bench/docker/entrypoint.sh \
  && useradd --system --uid 10001 --home-dir /nonexistent --no-create-home bench

ENTRYPOINT ["/workspace/bench/docker/entrypoint.sh"]
