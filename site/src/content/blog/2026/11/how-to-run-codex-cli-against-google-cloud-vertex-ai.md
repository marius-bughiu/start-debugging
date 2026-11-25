---
title: "How to Run Codex CLI Against Google Cloud Vertex AI with model_provider = \"gcp\""
description: "Codex CLI 0.165.0 added a built-in gcp provider that sends Responses API traffic to Vertex AI and bills your Google Cloud project. How to set it up in ~/.codex/config.toml, authenticate with ADC or a credential file, pick a model the provider actually exposes, run it headless in CI, and avoid the gotchas: project-local config is ignored, the global location, the missing hosted tools, and the background models memories need. Codex CLI 0.167.0+."
pubDate: 2026-11-25
template: "how-to"
tags:
  - "ai-agents"
  - "llm"
  - "codex"
  - "google-cloud"
  - "vertex-ai"
---

**Short answer:** on Codex CLI 0.167.0 or later, put `model_provider = "gcp"` at the top of your user-level `~/.codex/config.toml`, add a `[model_providers.gcp]` table with `project_id` and `location` (default `global`), run `gcloud auth application-default login`, and pick a model with `/model`. Codex then calls `https://aiplatform.googleapis.com/v1/projects/<project>/locations/<location>/publishers/openai/v1` with a token from `gcloud auth application-default print-access-token`, and your Google Cloud project pays for it. The project needs the Vertex AI API, the OpenAI model enabled through Model Garden (private preview, access by request), and `roles/aiplatform.user` for whoever runs Codex.

The built-in provider landed in [Codex CLI 0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0) (released October 27, 2026, [openai/codex#56265](https://github.com/openai/codex/pull/56265)). [0.167.0](https://github.com/openai/codex/releases/tag/rust-v0.167.0) (November 6) added the interactive "Sign in another way" setup, and that is the version both [OpenAI's Vertex guide](https://learn.chatgpt.com/docs/enterprise/connect-to-vertex-ai) and [Google's Codex page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/openai/codex) list as the minimum. Everything below is written against those two releases and the provider source on `main` as of November 25, 2026. Codex was not installed on the machine this post was written on, so the configs below were checked against the docs and the Rust source, not executed against a live Vertex project.

## Why route Codex through Vertex AI at all

The default Codex setup bills either a ChatGPT plan or an OpenAI API key. For a team whose cloud spend, procurement and data-governance rules already live in Google Cloud, both are awkward: a separate vendor contract, separate keys to rotate, separate audit logs. The `gcp` provider moves the model calls onto Google Cloud IAM. Requests are authorized with the same Application Default Credentials (ADC) your `gcloud` CLI uses, quota comes from the Marketplace offer your admin accepted, and the usage shows up on the Google Cloud bill.

Before 0.165.0 you could approximate this with a custom `[model_providers.<id>]` block plus a command-backed `auth` section that shelled out to `gcloud`. Third-party guides from earlier in 2026 still describe that route and claim Vertex is not a first-class provider. That is out of date. `gcp` is now a reserved built-in ID next to `openai`, `ollama`, `lmstudio`, `amazon-bedrock` and `amazon-bedrock-runtime`, per the [advanced configuration reference](https://learn.chatgpt.com/docs/config-file/config-advanced). Because it is reserved, you cannot define your own provider with the ID `gcp`. You configure the built-in one instead.

## What has to exist in the Google Cloud project first

None of the Codex config matters if the project cannot serve the model. Google's page lists the prerequisites, and in practice they are an admin task:

1. **Private preview access.** OpenAI models on Google Cloud are in private preview as of this writing. Access is requested through the form linked from OpenAI's guide, and the feature is covered by Google's Pre-GA terms.
2. **Marketplace and Model Garden.** The admin purchases the OpenAI offer in Google Cloud Marketplace and enables each model in Model Garden. If an organization policy restricts which models can be used, the models must be allowed there too.
3. **The API.** `aiplatform.googleapis.com` must be enabled on the project.
4. **IAM.** The user or service account that runs Codex needs `roles/aiplatform.user` (Agent Platform User) on the project, or a custom role with the same permissions.

The admin-side setup can be scripted with plain `gcloud`. The Marketplace purchase and Model Garden enablement are console steps, so only the API and IAM parts are shown here:

```bash
# Google Cloud CLI, any recent version
PROJECT_ID=my-codex-project

gcloud services enable aiplatform.googleapis.com --project "$PROJECT_ID"

# Grant a developer the role Codex needs to invoke the model
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="user:dev@example.com" \
  --role="roles/aiplatform.user"
```

What the developer needs from the admin is three values: the project ID, the location the models are deployed in, and the model names that were enabled.

## The minimal config in ~/.codex/config.toml

Here is the whole thing:

```toml
# ~/.codex/config.toml  (Codex CLI 0.167.0+)
model_provider = "gcp"
model = "gpt-6.1-sol"

[model_providers.gcp]
project_id = "my-codex-project"
location = "global"
```

Two placement rules trip people up.

First, `model_provider` and `model` are top-level keys, so they must appear **before** any `[table]` header. TOML assigns every key after `[model_providers.gcp]` to that table, so a `model_provider = "gcp"` written below it becomes `model_providers.gcp.model_provider`, which Codex does not read.

Second, this has to go in the **user-level** file. Codex deliberately ignores `model_provider` and `model_providers` (along with `openai_base_url`, `notify`, `profile`, `profiles`, `otel` and a few others) in a project-local `.codex/config.toml`, and prints a startup warning when it finds them there. The rule exists so that cloning a repository cannot silently redirect your prompts, code and credentials to an endpoint the repo author picked. If you want a per-repo default, commit a note in your `AGENTS.md` telling people which profile to use, not a provider block.

Both table keys are optional. When `project_id` is missing, Codex reads `GOOGLE_CLOUD_PROJECT`. When `location` is missing, it reads `GOOGLE_CLOUD_LOCATION`, then falls back to `global`. The config value wins over the environment variable: the provider docs comment in [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs) says `project_id` "takes precedence over `GOOGLE_CLOUD_PROJECT`", and the endpoint builder in [`model-provider/src/gcp/mod.rs`](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/gcp/mod.rs) checks the table first. Google's page describes `GOOGLE_CLOUD_LOCATION` as overriding the location, which is only true when the table does not set one. If you export `GOOGLE_CLOUD_LOCATION=us-central1` and your config says `location = "global"`, Codex uses `global`.

So a config that relies entirely on the environment is valid too:

```toml
# ~/.codex/config.toml  (Codex CLI 0.167.0+)
model_provider = "gcp"
# no [model_providers.gcp] table: project and location come from the environment
```

```bash
export GOOGLE_CLOUD_PROJECT=my-codex-project
export GOOGLE_CLOUD_LOCATION=global
codex
```

## Authentication: ADC by default, a credential file when you need one

By default the provider does not hold any credential itself. For each token it runs:

```bash
gcloud auth application-default print-access-token
```

That means the Google Cloud CLI must be installed and on `PATH`, and ADC must be initialized once on the machine:

```bash
gcloud auth application-default login
```

If the admin hands you an ADC file instead (a service account key or an external-account config for workload identity federation), point Codex at it:

```toml
# ~/.codex/config.toml  (Codex CLI 0.167.0+)
model_provider = "gcp"

[model_providers.gcp]
project_id = "my-codex-project"
location = "global"
credential_file = "/Users/me/.config/gcloud/codex-sa.json"
```

Two details from the source. The path must be absolute: `validate_gcp_credential_file` rejects relative paths with `provider credential_file must be an absolute path`, so `~/...` and `./key.json` are both out. And Codex sets `GOOGLE_APPLICATION_CREDENTIALS` only in the environment of the `gcloud` auth command, not for the whole Codex process, so your shell tools and MCP servers keep whatever credentials they had. Google's page adds its own caution: prefer ADC or short-lived tokens over long-lived service account keys sitting on a laptop.

If you need a different token source entirely, the built-in provider still accepts the generic overrides under `[model_providers.gcp]`: `base_url` to change the endpoint, an `auth` table (`command`, `args`, `timeout_ms`, `refresh_interval_ms`) to replace the `gcloud` call, and `http_headers` for static headers. The command must print the token to stdout and receives no stdin.

## Or let the setup wizard write it for you

Codex 0.167.0 moved API key and cloud sign-in options under a **Sign in another way** menu. From there, **Use Google Cloud Vertex AI** prompts for the project ID, the location (Enter for `global`) and an optional credential file path (Enter for ADC), checks that it can get a token, and saves the config.

The 0.167.0 release notes say this wizard is gated on a feature flag, and on `main` the `gcp_setup_wizard` feature is marked `Stable` but `default_enabled: false`. If the menu entry does not appear in your build, enable it:

```toml
# ~/.codex/config.toml  (Codex CLI 0.167.0+)
[features]
gcp_setup_wizard = true
```

The wizard and the hand-written config produce the same result. Writing the file yourself is easier to review and to roll out with dotfiles.

## Picking a model the provider will actually show

The `gcp` provider does not query Vertex for a model list. It ships a static catalog and filters it. On `main`, the allowed slugs are `gpt-6-astra`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6.2-astra` and `gpt-6.2-sol`. Google's page documents the first four:

| Model | Google's description |
|---|---|
| `gpt-6.1-sol` | Flagship model for coding and agentic workflows |
| `gpt-6-luna` | Low latency, fast interactive help |
| `gpt-6-astra` | Highest capability, complex multi-step reasoning |
| `gpt-6.1-terra` | Balanced, high-throughput automation |

`/model` will list everything in the catalog, but a request only succeeds for models your admin enabled in Model Garden for that project and location. Since 0.165.0 a model-not-found error from the provider is a terminal failure ([#56445](https://github.com/openai/codex/pull/56445)), so a session pinned to a model that is not enabled stops instead of retrying.

The quickest end-to-end check is the one OpenAI suggests: start `codex`, run `/model`, select an enabled model, and ask for a one-line greeting. For a scripted check, use `codex exec`:

```bash
# Codex CLI 0.167.0+
codex exec -m gpt-6.1-sol "Reply with the single word: ok"
```

## Keep Vertex and OpenAI side by side with profiles

Many developers want Vertex for work repos and their own ChatGPT login elsewhere. Profiles handle that without editing the file each time. Profiles live in the user-level file (they are on the project-local ignore list too):

```toml
# ~/.codex/config.toml  (Codex CLI 0.167.0+)
model = "gpt-6.1-sol"   # default: normal OpenAI sign-in

[profiles.vertex]
model_provider = "gcp"
model = "gpt-6.1-sol"

[profiles.vertex-fast]
model_provider = "gcp"
model = "gpt-6-luna"

[model_providers.gcp]
project_id = "my-codex-project"
location = "global"
```

```bash
codex --profile vertex
codex exec --profile vertex-fast "Summarize the diff in HEAD~1"
```

Since 0.167.0, saved chats stay visible after you switch providers ([#58202](https://github.com/openai/codex/pull/58202)), so moving between profiles no longer hides your history.

## Running it headless in CI

The same provider works for `codex exec` in a pipeline, as long as the runner can mint an ADC token. On GitHub Actions the clean way is workload identity federation through `google-github-actions/auth`, which writes an external-account credential file and exports `GOOGLE_APPLICATION_CREDENTIALS`. `gcloud auth application-default print-access-token` honors that variable, so Codex needs no `credential_file`:

```yaml
# .github/workflows/codex-review.yml  (Codex CLI 0.167.0+)
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/123/locations/global/workloadIdentityPools/gh/providers/gh
          service_account: codex-ci@my-codex-project.iam.gserviceaccount.com
      - uses: google-github-actions/setup-gcloud@v2
      - run: npm install -g @openai/codex@0.167.0
      - name: Write user-level Codex config
        run: |
          mkdir -p ~/.codex
          cat > ~/.codex/config.toml <<'EOF'
          model_provider = "gcp"
          model = "gpt-6.1-terra"
          [model_providers.gcp]
          project_id = "my-codex-project"
          location = "global"
          EOF
      - run: codex exec "Review the changes in this PR for obvious bugs"
```

Note that the config is written to `~/.codex/config.toml` on the runner, not committed as `.codex/config.toml` in the repo, for the reason covered above. The service account needs `roles/aiplatform.user`. If the agent will run shell commands on an untrusted PR, apply the same isolation you would for any agent with tool access; running it in a throwaway environment is covered in [how to run a coding agent in a disposable VM or container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/).

## What does not work on the Vertex provider

The provider declares its capabilities in code, and several features you may rely on with an OpenAI login are switched off:

- **Hosted web search** is disabled (`web_search: false`, `external_web_access: false`). Google's page also lists hosted file search as unsupported during the preview. If your workflow depends on the agent browsing docs, give it a local MCP server for that instead. [Local MCP servers](/2026/09/what-is-the-model-context-protocol-and-why-every-ide-is-shipping-it/) configured in `~/.codex/config.toml` are supported.
- **Hosted Code Interpreter** is not available. Code runs locally through Codex's own shell tool, which is how most CLI use works anyway.
- **Image generation** and **reasoning summaries** are disabled, so you will not see the summarized "thinking" lines in the TUI.
- **Responses Lite and custom (freeform) tools** are off. The PR description says Vertex supports function tools, namespaces and client-side tool search but not custom tools, so the provider forces direct function-tool mode. File editing and patching still work per Google's feature table.
- **Remote compaction** is supported (V2), so long sessions can still be compacted server-side.

## Gotchas worth knowing before you roll it out

**`global` is not a data-residency setting.** OpenAI's guide notes that with `location = "global"`, Google Cloud may process requests in more than one region. If your policy requires regional processing, ask the admin for a supported regional location and set it explicitly in the table, where the environment cannot override it.

**Location and project values are validated strictly.** Both must be non-empty and contain only ASCII letters, digits and hyphens. A stray quote or trailing slash produces `model_providers.gcp.location must be non-empty and contain only ASCII letters, digits, and hyphens` (or the `GOOGLE_CLOUD_*` name if the value came from the environment). A missing project produces an error that tells you to set `model_providers.gcp.project_id` or `GOOGLE_CLOUD_PROJECT`, or to configure `base_url`.

**Background features call specific models.** The provider hard-codes which models its internal jobs use: approval review and memory extraction prefer `gpt-6-luna`, memory consolidation prefers `gpt-6.1-terra`. Codex 0.165.0 also turned memory v2 on by default for fresh profiles. The source does not say what happens when those models are not enabled in your project, but it is reasonable to expect those background passes to fail. If your admin only enabled `gpt-6.1-sol`, either ask for `gpt-6-luna` and `gpt-6.1-terra` too, or check `/memories` and turn memories off.

**`gcloud` has to be on the PATH Codex sees.** Codex shells out to it for every token. In a GUI-launched desktop app or a minimal container, `PATH` can differ from your interactive shell. If token validation fails, run `gcloud auth application-default print-access-token` yourself in the same environment first; that is also the first step in OpenAI's troubleshooting section.

**Auth success but request failure means project, location or model.** If the token step passes and the request fails, the project and location in your config do not match where the model is deployed, or the account lacks `roles/aiplatform.user`. That is the same triage order OpenAI's guide gives.

The `gcp` provider is the Codex counterpart to running Claude Code through a cloud provider's console; if your team runs both, the same "billing and IAM follow the cloud account" logic applies to [Claude Code's Bedrock service tier setting](/2026/04/claude-code-2-1-122-bedrock-service-tier/). And because provider choice lives in each developer's user-level config while the instructions live in the repo, it pays to keep the shared part in one file: see [migrating to a single AGENTS.md](/2026/09/migrate-cursorrules-claude-md-copilot-instructions-to-one-agents-md/). For how Codex stacks up against the other CLIs, [Claude Code vs Cursor vs Aider for a .NET 11 repo](/2026/06/claude-code-vs-cursor-vs-aider-for-a-dotnet-11-repo/) covers the trade-offs that do not change with the billing route.

### Sources

- [Connect Codex to Google Cloud Vertex AI](https://learn.chatgpt.com/docs/enterprise/connect-to-vertex-ai) (OpenAI)
- [Connect OpenAI Codex to Google Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/openai/codex) (Google Cloud)
- [Codex advanced configuration: model providers and project-local restrictions](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Codex CLI rust-v0.165.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.165.0) and [rust-v0.167.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.167.0)
- [openai/codex#56265: Add a built-in Google Cloud Vertex AI provider](https://github.com/openai/codex/pull/56265)
- [`codex-rs/model-provider/src/gcp/mod.rs`](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/gcp/mod.rs) on `main`
