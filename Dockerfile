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
# so git must not refuse them as "dubious ownership". Git can trust a narrower
# scope: an exact path, or a directory with "/*" appended to trust every
# repository below it. The mount root still differs per CI and per self-hosted
# runner (/__w/<n>/s, /builds/<group>/<project>, the Bitbucket clone dir, an
# arbitrary Jenkins workspace), so one static prefix list cannot cover them.
# The container is ephemeral, runs one repository and holds no credentials;
# prefer narrower entries if your pipeline pins the workspace path.
RUN git config --system --add safe.directory '*' \
 && useradd --create-home --uid 10001 --shell /bin/sh cra \
 && mkdir -p /workspace \
 && chown cra:cra /workspace

USER cra
WORKDIR /workspace
ENTRYPOINT ["cra"]
