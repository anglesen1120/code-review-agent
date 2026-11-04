# code-review-agent CLI image: `cra` on PATH, repository at /opt/code-review-agent.
# Used by the GitLab, Jenkins, Bitbucket and Azure templates in ci/.
FROM node:22-slim

ARG OPENCODE_VERSION=1.18.18

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The analyzer shells out to the opencode CLI; pin it so reviews are reproducible.
RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}"

COPY . /opt/code-review-agent
RUN chmod +x /opt/code-review-agent/bin/cra.js \
 && ln -sf /opt/code-review-agent/bin/cra.js /usr/local/bin/cra

# CI workspaces are mounted from the runner and usually belong to another uid,
# so git must not refuse them as "dubious ownership".
RUN git config --system --add safe.directory '*' \
 && useradd --create-home --uid 10001 --shell /bin/sh cra \
 && mkdir -p /workspace /builds \
 && chown cra:cra /workspace \
 && chmod 0777 /builds

USER cra
WORKDIR /workspace
ENTRYPOINT ["cra"]
