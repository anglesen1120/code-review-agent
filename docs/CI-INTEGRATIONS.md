# CI integrations

`bin/cra.js` is the only entry point. A CI template is correct when it calls
that CLI with options this document lists and nothing else.

## What each platform gets

| Platform | Inline threads | Summary | Auto-resolve | Merge gate | Report files |
| --- | --- | --- | --- | --- | --- |
| GitHub Actions (`--platform github`) | Review threads for Critical/Warning | One upserted PR comment | Yes, with a credential allowed to resolve (classic PAT) | Branch protection: *Require conversation resolution*, plus the `code-review-agent` commit status when `--set-status` is used | SARIF (action input `sarif-file`), Markdown/JSON/Code Quality via CLI flags, step summary |
| GitLab CI (`--platform gitlab`) | MR discussions on the diff | One upserted MR note | Yes | Project setting *Merge requests → All threads must be resolved*; the job exit code reflects `--fail-on` plus fail-closed delivery/review failures | Code Quality report + SARIF/Markdown artifacts |
| Jenkins, Bitbucket, Azure (`--platform none`) | — | — | — | Job/step/build failure from `--fail-on`, and from a review that could not run (over-budget diff) (platform-native PR comments are not implemented) | SARIF, Markdown, JSON, log output |

`--platform auto` resolves to `github` when `GITHUB_ACTIONS=true`, `gitlab` when
`GITLAB_CI=true`, and `none` everywhere else. Pass an explicit value in every
template so a CI migration cannot silently change the behaviour.

## Fail-on semantics and exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Review completed and the gate (if any) passed. |
| `1` | `--fail-on` matched an issue that is still open; the analysis failed while `--fail-on` is not `none`; no thread at all could be posted on a platform adapter; existing threads could not be read; the commit status could not be delivered with `--set-status`; or the whole diff exceeded `--max-diff-bytes` and nothing was reviewed. |
| `2` | Usage or configuration error (unknown flag value, no base revision, missing platform token, unreadable event payload). |

`--fail-on none` is the default and never fails on findings. `critical` fails on
open Critical threads/findings; `warning` fails on Critical or Warning. Findings
that cannot be anchored inside a diff hunk are posted to the summary only, but
they still count towards the gate.

**Fail closed.** With `--fail-on critical` or `warning`, a failed analysis (bad
key, provider outage, unparsable model output, or an opencode process that exits
non-zero even after printing valid JSON) fails the run instead of reporting "no
issues". With `--fail-on none` the same failure exits `0` and is recorded in the
summary and the job log. Two delivery failures are always fatal: when no thread
at all could be posted, and when `--set-status` was requested and the status API
call failed — the reports are still written, then the run exits `1`.

**Partial reviews.** When the diff exceeds `--max-diff-bytes`, the files that do
not fit are skipped and named in the summary. Their existing threads stay open:
an unreviewed file is not evidence that a finding was fixed. If the **whole**
diff is over budget, nothing is posted or resolved, the summary says the diff
was not reviewed (never "no code changes"), the reviewed-SHA marker does not
advance, and the run exits `1` regardless of `--fail-on`.

## Docker image

```
ghcr.io/anglesen1120/code-review-agent:latest
```

- Node 22 + git, `opencode-ai@1.18.18` installed globally, repository copied to
  `/opt/code-review-agent`, `cra` symlinked into `PATH`.
- Non-root user `cra` (uid 10001), `ENTRYPOINT ["cra"]`, `WORKDIR /workspace`.
- `git config --system --add safe.directory '*'` so mounted workspaces owned by
  another uid are usable (see [Container permissions](#container-permissions)).
- The image carries no credentials and no consumer code; the API key is supplied
  at run time and only the provider key reaches the model process.

**Pin the image.** `:latest` is mutable, so a re-pull can silently change the
reviewer that runs with your tokens. Use a version tag or a digest in every
pipeline:

```yaml
image: ghcr.io/anglesen1120/code-review-agent:0.1.0
# or, stricter:
image: ghcr.io/anglesen1120/code-review-agent@sha256:<digest>
```

The same rule applies to a remote GitLab include: pin it to a release tag or a
commit SHA that contains the template (`ref: '<tag-or-sha>'`), never `main`. An
include is code that runs with your CI variables.

The `ENTRYPOINT` is deliberate: it makes `docker run -e CRA_API_KEY=… image
review` work with no wrapper. CI systems that start the container with their own
command must clear it — the templates below show the per-system spelling.

### Container permissions

The image's user is uid 10001, but CI runners usually clone the workspace as
their own uid (1000 on Bitbucket, the agent user on Azure, a random uid on
GitLab). The reviewer must write `cra-report.md`, SARIF and its scratch files
into that workspace, so the templates either run the container as root
(`-u 0` on Azure, `run-as-user: "0"` on Bitbucket) or let the platform pick a
writable user (GitLab, Jenkins).

Running as root here is confined to the container and the mounts the runner
gives it: the container is not privileged and the image has no other tooling.
On self-hosted runners prefer the uid that owns the clone:

```yaml
# Azure
options: '--entrypoint="" -u 1000'
# Bitbucket
run-as-user: "1000"
```

If you change the uid, keep `HOME` writable (Jenkins sets `-e HOME=/tmp`) and
point report paths at a directory that uid owns.

`safe.directory '*'` is deliberately broad. Git supports narrower trust — an
exact path, or a directory with `/*` appended to trust everything below it — but
the mount root differs per CI and per self-hosted runner (`/__w/<n>/s`,
`/builds/<group>/<project>`, the Bitbucket clone dir, an arbitrary Jenkins
workspace), so one static prefix list cannot cover them. The container is
ephemeral, runs one repository and holds no credentials; if your pipeline pins
the workspace path, list that prefix (`/builds/*`) instead of `*`.

## GitHub Actions

Use the composite action in `action.yml`; `example/.github/workflows/code-review.yml`
is a complete workflow. The action installs opencode, maps its inputs to
`CRA_*` variables and runs `cra review --platform github`.

Required repository secrets:

- `DEEPSEEK_API_KEY` (or any provider key) — passed as `api-key` → `CRA_API_KEY`.
- `CODE_REVIEW_TOKEN` — optional classic PAT for auto-resolve (see
  [`SETUP.md`](SETUP.md) and [`THREAD-LIFECYCLE.md`](THREAD-LIFECYCLE.md)).

## GitLab CI

Template: [`ci/gitlab/code-review.gitlab-ci.yml`](../ci/gitlab/code-review.gitlab-ci.yml).

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/anglesen1120/code-review-agent/<tag-or-sha>/ci/gitlab/code-review.gitlab-ci.yml'
```

or, when the file lives in another project:

```yaml
include:
  - project: 'my-group/code-review-agent'
    file: 'ci/gitlab/code-review.gitlab-ci.yml'
    ref: '<tag-or-sha>'
```

Replace `<tag-or-sha>` with a release tag or commit SHA that contains the
template (the existing `v1` tag predates it), never a moving branch: a remote
include is code that runs with your CI variables. Update it deliberately, the
same way you pin the image.

Setup:

1. Masked CI/CD variables: `CRA_API_KEY` (provider key) and `GITLAB_TOKEN`.
   `GITLAB_TOKEN` must be a project or group **access token** with role
   Developer or higher and the `api` scope, or a personal access token with
   `api`. `CI_JOB_TOKEN` cannot create or resolve merge-request discussions.
2. Set `GIT_DEPTH: 0` (the template already does): the CLI diffs
   `base...head`, which needs the merge base.
3. Enable *Settings → Merge requests → All threads must be resolved* if you
   want the inline threads to block merge. Without that setting a fully green
   pipeline can still be merged with open threads; add `--fail-on critical` to
   the script if you want the job itself to fail.
4. The template sets `allow_failure: true`. Remove it once you trust the
   reviewer on that repository.

Notes:

- The `codequality` artifact is GitLab's Code Quality report format
  (`gl-code-quality-report.json`), produced by `--codequality`.
- `gl-sast-cra.sarif` is published as a plain artifact, not as a GitLab SAST
  report: GitLab's `reports:sast` parser does not read SARIF.
- Merge-request pipelines only. The `rules` entry
  `if: $CI_PIPELINE_SOURCE == "merge_request_event"` is required: the adapter
  rejects runs without `CI_MERGE_REQUEST_IID` with exit code 2.

## Jenkins

Template: [`ci/jenkins/Jenkinsfile`](../ci/jenkins/Jenkinsfile).

Setup:

1. Create a secret text credential with id `cra-api-key`.
2. Point a multibranch pipeline at the repository; the stage is gated by
   `when { changeRequest() }`, so branch builds skip the review.
3. `CHANGE_TARGET` is the PR destination branch; the template fetches
   `origin/<target>` explicitly because multibranch clones are shallow and do
   not carry it.
4. Reports are archived from `post { always { … } }`, so they survive a failing
   gate.

`--platform none` means no PR comments. The gate is the stage result, so make
the multibranch job (and its branch source PR check) required in the repository
settings. Optional: with the Warnings NG plugin, add
`recordIssues(tools: [sarif(pattern: 'cra.sarif')])` to the `post` block to get
the findings in the Jenkins UI. It is commented out in the template because the
plugin is not installed everywhere.

## Bitbucket Pipelines

Template: [`ci/bitbucket/bitbucket-pipelines.yml`](../ci/bitbucket/bitbucket-pipelines.yml).

Setup:

1. Repository variable `CRA_API_KEY` (masked) with the provider key.
2. `clone: depth: full` is required for the merge base.
3. `pull-requests: '**'` runs the step for every PR; `--fail-on critical`
   turns open Critical findings into a failed step, which Bitbucket can require
   through branch permissions.
4. `run-as-user: "0"` is set because the Pipelines agent clones the workspace
   as its own user, so uid 10001 cannot write the reports there. On a
   self-hosted runner set it to the uid that owns the clone (usually `1000`);
   see [Container permissions](#container-permissions).
5. Artifacts: `cra-report.md`, `cra.sarif`.

The destination branch is available as `BITBUCKET_PR_DESTINATION_BRANCH`; the
CLI's base inference reads it, so the template only fetches the branch.

## Azure Pipelines

Template: [`ci/azure/azure-pipelines.yml`](../ci/azure/azure-pipelines.yml).

Setup:

1. Pipeline variable `CRA_API_KEY` (kept secret) with the provider key — the
   template forwards it to the step environment explicitly, because secret
   variables are not injected automatically.
2. **Azure Repos:** there is no YAML `pr:` trigger for Git repositories. Add a
   **Build Validation** branch policy on the target branch that runs this
   pipeline. The `pr:` block in the template only applies to GitHub/Bitbucket
   repositories hosted in Azure Pipelines.
3. `fetchDepth: 0` is required. The full history already contains
   `origin/<target>`: the target branch is read from
   `SYSTEM_PULLREQUEST_TARGETBRANCH` (`refs/heads/<branch>`) and the CLI strips
   the `refs/heads/` prefix when it infers the base. The review needs no remote
   access; if a revision is missing from the full clone, the CLI exits `2` with
   a clear message rather than diffing the wrong range (the job token is not
   available to fetch it).
4. **Private Azure Repos.** `persistCredentials: false` keeps the job token out
   of `.git/config`, and because no fetch is needed, no token is passed to
   `cra` — the step only receives `CRA_API_KEY`. Do not add a `git fetch` of the
   target branch with the job token exported: on a private repository that
   either fails or leaks the token into the review environment.
5. Azure container jobs expect an image without `ENTRYPOINT`, so the template
   clears it (`options: '--entrypoint=""'`) and runs as root (`-u 0`) to write
   into the agent-owned workspace mount. Self-hosted pools can run as the uid
   that owns the clone instead; see
   [Container permissions](#container-permissions).
6. The SARIF file is published as the `CodeAnalysisLogs` artifact, the name the
   SARIF SAST Scans Tab extension looks for; the markdown report is published
   as `code-review-report`.

## Token permissions

| CI | Variable | Permissions | Can auto-resolve |
| --- | --- | --- | --- |
| GitHub | `GITHUB_TOKEN` (default) | `contents: read`, `pull-requests: write`; `statuses: write` for `--set-status` | No |
| GitHub | Fine-grained PAT | Repository access granted; Contents read, Pull requests read/write, Issues read/write (summary comment), Statuses read/write for `--set-status` | No (HTTP 403) |
| GitHub | Classic PAT, `repo` scope | Full repository access for the token owner | Yes |
| GitLab | Project/group access token or PAT with `api` | Role Developer or higher | Yes |
| GitLab | `CI_JOB_TOKEN` | Job-scoped | No — cannot create discussions |
| Jenkins / Bitbucket / Azure | none | Only `CRA_API_KEY` is needed | — (no adapter) |

Never log a token. The CLI redacts the GitLab token from error messages and
never places a token in a URL; the child model process never receives CI tokens
at all, and the analyzer scrubs the provider key and any
`TOKEN`/`KEY`/`SECRET`/`PASSWORD` environment value from the logs it prints (see
[Security model](../README.md#security-model)).

## Environment variables

The CLI reads these variables (`bin/cra.js`, `src/analyzer.js`,
`src/platforms/*`); every one has a flag equivalent except the credential and
adapter variables:

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `CRA_PLATFORM` | `--platform` | `auto` | `auto`, `github`, `gitlab` or `none`. |
| `CRA_BASE` | `--base` | from the platform, else `origin/<target>` | Base revision of the diff. |
| `CRA_HEAD` | `--head` | from the platform, else `HEAD` | Head revision of the diff. |
| `CRA_FAIL_ON` | `--fail-on` | `none` | `none`, `critical` or `warning`. |
| `CRA_EXCLUDE` | `--exclude` | empty | Comma-separated extra pathspecs to skip. |
| `CRA_MAX_DIFF_BYTES` | `--max-diff-bytes` | `250000` | Byte budget for the diff; whole files beyond it are skipped and listed. Minimum `1000`. |
| `CRA_MODEL` | `--model` | `go/deepseek-v4.1-flash` | `provider/model` for the analyzer. |
| `CRA_BASE_URL` | `--base-url` | `https://opencode.ai/zen/go/v1` | OpenAI-compatible endpoint. |
| `CRA_API_KEY` | — | falls back to `DEEPSEEK_API_KEY` | Provider key. Missing key is an analysis failure, not a usage error. |
| `CRA_SET_STATUS` | `--set-status` | `false` | Also set the `code-review-agent` commit status. |
| `CRA_DRY_RUN` | `--dry-run` | `false` | Analyse and print the plan; write nothing to the platform. |
| `CRA_OUT_DIR` | `--out-dir` | `.review` for `analyze`, `.cra` on GitLab, `$RUNNER_TEMP/cra` when set, otherwise a private temp dir | Where `pr.diff`, `findings.json`, `existing_threads.json` and `result.json` go. The analysis snapshot is always a separate temp dir. |
| `GITHUB_TOKEN` / `CRA_GITHUB_TOKEN` | — | — | GitHub adapter credential (`GITHUB_TOKEN` wins). |
| `GITLAB_TOKEN` / `CRA_GITLAB_TOKEN` | — | — | GitLab adapter credential (`GITLAB_TOKEN` wins). |
| `BOT_LOGIN` | — | `github-actions` | Identity whose threads are managed (`github-actions[bot]` is accepted). |
| `CRA_OPENCODE_BIN` | — | `opencode` | opencode executable used by the analyzer. |
| `CRA_ANALYZE_TIMEOUT_MS` | — | `900000` | Hard timeout per analyzer attempt. |

Diff scope, budget, model and endpoint are the four cost knobs: reduce
`CRA_MAX_DIFF_BYTES`, add `CRA_EXCLUDE` patterns, or point `CRA_MODEL` at a
cheaper model. Empty diffs skip the model call entirely.
