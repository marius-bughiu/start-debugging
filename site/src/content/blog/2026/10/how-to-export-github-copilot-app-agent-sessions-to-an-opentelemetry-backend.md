---
title: "How to Export GitHub Copilot App Agent Sessions to an OpenTelemetry Backend"
description: "Send GitHub Copilot app agent traces, token metrics and events to your own OTLP collector with the telemetry block in enterprise managed settings. Covers every telemetry key, the six content-capture classes, delivery via .github-private, MDM or a root-owned file, channel precedence, a collector config with bearer auth, and the gotchas that make exports silently go nowhere."
pubDate: 2026-10-13
template: how-to
tags:
  - "github-copilot"
  - "ai-agents"
  - "opentelemetry"
  - "observability"
  - "enterprise"
---

**Short answer:** the GitHub Copilot app does not have a per-user "export telemetry" toggle. You turn OpenTelemetry on centrally, by adding a `telemetry` object to your enterprise's `managed-settings.json` with `enabled: true`, an OTLP `endpoint`, a `protocol` of `http/protobuf` (or `http/json`), and optional `headers`, `serviceName` and `resourceAttributes`. Deliver that file through server-managed settings (`copilot/managed-settings.json` in your `.github-private` repository), native MDM, or a root-owned file on each machine. The app then exports traces of each agent session (model calls, tool calls, hooks), token-usage metrics and events. Prompts, responses, tool arguments, tool output and identity are all off by default and each one is a separate switch under `telemetry.capture`. The feature [shipped on September 22, 2026](https://github.blog/changelog/2026-09-22-opentelemetry-in-the-github-copilot-app), and everything below was checked against GitHub's [enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings) as of October 13, 2026.

## Why you want agent traces and not just usage dashboards

The Copilot usage metrics in the enterprise settings tell you who used Copilot and how much. They do not tell you why a specific agent session took eleven minutes, called `grep` forty times, burned 600k input tokens and then gave up. That question only has an answer if you can open the session as a trace: one root span for the agent run, a child span for every model request, a child span for every tool execution, and the token counts attached to each.

That is what the OTel export gives you. Once it lands in the same backend as the rest of your telemetry (Grafana, Honeycomb, Datadog, Splunk, the [Aspire dashboard or Jaeger](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) if you self-host), you can answer things like "which MCP server is slowest", "which model is the agent actually running after `auto` picks one", and "did the `PreToolUse` hook deny that command or did the agent never try it".

The catch is that it is an admin feature. The [OpenTelemetry concept page](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/enterprise/opentelemetry) lists the Copilot CLI, the Copilot app, VS Code (both the local harness and Agent Host sessions) and JetBrains as clients that honor the `telemetry` block. Copilot cloud agent does not. And because a managed value always wins over local settings and `OTEL_*` environment variables, once you set it, developers cannot point it somewhere else.

## What actually gets exported

Copilot follows the OpenTelemetry GenAI semantic conventions. GitHub's [VS Code monitoring guide](https://code.visualstudio.com/docs/copilot/guides/monitoring-agents) documents the shape, and the app emits the same three signal types:

- **Traces.** An `invoke_agent` span wraps the whole agent run. Under it you get a `chat` span per model request, an `execute_tool` span per tool invocation, and an `execute_hook` span per hook run (`PreToolUse`, `Stop` and so on). Spans carry `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.tool.name`, `gen_ai.conversation.id` and `github.copilot.hook.decision`, among others.
- **Metrics.** `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` from the GenAI conventions, plus Copilot-specific counters and histograms for tool calls, agent turns and time to first token.
- **Events.** Point-in-time records such as an edit being accepted or rejected.

Treat the exact span and metric names as something you confirm against your first real trace, not as a contract. The GenAI semantic conventions are still marked experimental upstream, and the VS Code guide is the only page that enumerates them.

What is *not* exported unless you opt in: prompt text, model responses and reasoning, raw tool arguments and shell commands, tool results, raw sandbox policy paths, and anything that identifies the person or machine. The attributes that hold those (`gen_ai.input.messages`, `gen_ai.tool.call.arguments` and friends) are simply absent.

## Step 1: stand up something that receives OTLP over HTTP

The `protocol` key only accepts `http/json` and `http/protobuf`. There is no gRPC option for the app, so whatever you point it at must speak OTLP/HTTP, usually on port 4318.

For a first look, run Jaeger locally on one test machine:

```bash
# Jaeger 2.x all-in-one, OTLP/HTTP on 4318, UI on 16686
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
```

For production, put an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) in front of your backend rather than pointing every laptop at a SaaS ingest URL directly. The collector lets you hold the real backend API key server-side, give laptops a separate ingest-only token, and strip attributes you never want stored even if someone later flips a capture flag.

```yaml
# otel-collector-config.yaml
# OpenTelemetry Collector Contrib (bearertokenauth + attributes processor are contrib components)
extensions:
  bearertokenauth:
    token: "${env:COPILOT_INGEST_TOKEN}"   # what laptops send

receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        auth:
          authenticator: bearertokenauth

processors:
  batch: {}
  attributes/strip-content:
    # Defense in depth: drop content attributes even if capture is enabled upstream
    actions:
      - { key: gen_ai.input.messages, action: delete }
      - { key: gen_ai.output.messages, action: delete }
      - { key: gen_ai.tool.call.arguments, action: delete }
      - { key: gen_ai.tool.call.result, action: delete }

exporters:
  otlphttp:
    endpoint: https://otlp.your-backend.example.com
    headers:
      x-api-key: "${env:BACKEND_API_KEY}"   # never leaves the collector

service:
  extensions: [bearertokenauth]
  pipelines:
    traces:  { receivers: [otlp], processors: [attributes/strip-content, batch], exporters: [otlphttp] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [otlphttp] }
    logs:    { receivers: [otlp], processors: [attributes/strip-content, batch], exporters: [otlphttp] }
```

Terminate TLS in front of that receiver (a load balancer or the collector's own `tls` block). The managed settings reference is explicit that you should use HTTPS whenever `headers` contain credentials, and an ingest token in cleartext across a coffee-shop network is exactly the leak you were trying to avoid.

## Step 2: write the telemetry block

This is the full set of keys the reference documents, with the values I would start with:

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://otel.internal.example.com",
    "protocol": "http/protobuf",
    "serviceName": "copilot",
    "resourceAttributes": {
      "deployment.environment": "production",
      "copilot.client": "app"
    },
    "headers": {
      "Authorization": "Bearer INGEST_ONLY_TOKEN"
    },
    "capture": {
      "identity": false,
      "prompts": false,
      "responses": false,
      "toolArguments": false,
      "toolOutput": false,
      "policyDetail": false
    },
    "lockCaptureContent": true
  }
}
```

What each key does:

- **`enabled`**: the master switch. `false` turns export off on every client that honors managed settings, which is also how you kill it in an incident.
- **`endpoint`**: the base URL of your OTLP receiver. Give the base, not `/v1/traces`. OTLP/HTTP exporters append the per-signal path themselves, so `https://otel.internal.example.com/v1/traces` ends up posting to `/v1/traces/v1/traces` and every request 404s.
- **`protocol`**: `http/protobuf` or `http/json`. Prefer protobuf. Some hosted backends only accept protobuf on their OTLP/HTTP endpoints and reject JSON with a 400 (OpenObserve's Copilot guide calls this out), and you will not see that error in the app.
- **`serviceName`**: the `service.name` resource attribute. If you also run the Copilot CLI and VS Code under the same managed settings, they will all report under this name, so add a resource attribute if you want to tell them apart in queries.
- **`resourceAttributes`**: arbitrary key/values stamped on every span, metric and event.
- **`headers`**: literal HTTP headers on every export request. The reference requires `endpoint` to be set in the same object when you use this. Managed headers are applied to the exporter directly and are not passed through environment variables, so they do not leak into the shell commands and MCP servers the agent spawns.
- **`capture`**: six independent booleans, all `false` by default. More on these below.
- **`captureContent`**: the legacy all-or-nothing switch. It toggles `prompts`, `responses`, `toolArguments`, `toolOutput` and `policyDetail` together but never `identity`. An explicit `capture.*` value beats it for that class. Do not set both unless you enjoy reasoning about precedence.
- **`lockCaptureContent`**: when `true`, local settings cannot turn on a legacy content class that you left off. Set it. Without it, a developer with `COPILOT_OTEL_CAPTURE_CONTENT=true` in their shell profile can start shipping prompts to your backend on tools that still read the legacy flag.

## Step 3: deliver it to every machine

There are three channels, and the one most teams get wrong is how they combine.

**Server-managed** is the easiest. Create (or edit) `copilot/managed-settings.json` in your enterprise's `.github-private` repository. Every Copilot-licensed user in the enterprise picks it up on a supported client within about an hour, or immediately after restarting the app or signing in again. GitHub validates the file, and any problems show up under **AI controls > Agents > Copilot settings validation** with the file and JSON path. If you already govern MCP servers this way, as in [central MCP allowlists for a team](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/), the `telemetry` key goes in the same file next to `allowedMcpServers`.

**Native MDM** is for fleets you already manage with Intune, Jamf or similar. On Windows the policy lives under `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\GitHubCopilot`; on macOS it is the `com.github.copilot` managed preferences domain. Clients re-check hourly without a restart.

**File-based** is a JSON file on disk, read at startup:

```bash
# macOS
/Library/Application Support/GitHubCopilot/managed-settings.json
# Linux
/etc/github-copilot/managed-settings.json
# Windows
%ProgramFiles%\GitHubCopilot\managed-settings.json
```

The file must be owned by root (or the Windows equivalent), must not be world-writable and must not be a symlink. Treat a file that fails those checks as not deployed at all, and remember that file-based changes need an app restart.

Now the part that bites: according to the [MDM deployment changelog](https://github.blog/changelog/2026-07-08-deploy-managed-copilot-settings-via-mdm-in-vs-code-and-cli), when more than one channel provides settings, **the highest-precedence channel wins outright**, in the order native MDM, then server-managed, then file-based. The channels are not merged key by key. If your security team already pushes an MDM profile with a sandbox policy, and you add `telemetry` only to `.github-private`, the MDM profile wins on those machines and your telemetry block is never read. Put `telemetry` in whichever channel is already authoritative for a given device.

For a single-machine trial before you touch the enterprise, the file-based channel is the safe sandbox:

```bash
# macOS test machine, pointing at the local Jaeger from step 1
sudo mkdir -p "/Library/Application Support/GitHubCopilot"
sudo tee "/Library/Application Support/GitHubCopilot/managed-settings.json" >/dev/null <<'EOF'
{
  "telemetry": {
    "enabled": true,
    "endpoint": "http://localhost:4318",
    "protocol": "http/protobuf",
    "serviceName": "copilot-trial"
  }
}
EOF
sudo chown root:wheel "/Library/Application Support/GitHubCopilot/managed-settings.json"
sudo chmod 644 "/Library/Application Support/GitHubCopilot/managed-settings.json"
```

Quit and reopen the Copilot app, run one agent session that reads a file and runs a shell command, then open `http://localhost:16686`, pick the `copilot-trial` service and hit **Find Traces**. You should see one trace per session with `chat` and `execute_tool` children. Remember that this test machine only uses the file if it is not also receiving MDM or server-managed settings.

## Step 4: decide what content to capture, one class at a time

The six `capture` classes exist because "turn on content capture" used to be a single scary switch. Now you can enable exactly what a given investigation needs:

| Class | What it adds | When it is worth it |
|---|---|---|
| `identity` | `user.name` (Copilot account), `process.user.name` (OS account), `host.name` | Per-user cost or support tickets. `enduser.pseudo.id` is always present regardless. |
| `prompts` | User, system and developer prompt text, full model input | Debugging instructions files or skills that the agent ignores |
| `responses` | Assistant text and supported reasoning content | Debugging why the agent concluded something |
| `toolArguments` | Raw tool arguments, shell commands, tool schemas, MCP/plugin/hook IDs | Auditing what commands agents run |
| `toolOutput` | Tool results and execution error details | Debugging failing MCP servers |
| `policyDetail` | Unbounded policy info such as raw sandbox filesystem paths | Tuning a [local sandbox policy](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) |

Every content class can contain source code, file contents, secrets that ended up in a terminal, and home-directory paths that include usernames. `toolArguments` alone is effectively a shell history of every developer in the enterprise. My recommendation: ship with everything `false`, turn on `toolArguments` only, and only for as long as you need it, with the collector's `attributes/strip-content` processor relaxed for that one key. Structural data (span timings, tool names, token counts, hook decisions) answers most "why was this slow or expensive" questions without any content at all.

`policyDetail` deserves its own note. With it off, you still get bounded policy posture and outcomes (was the sandbox on, was the call allowed). You only lose the raw path arrays, which are mostly useful while you are writing the policy.

## Gotchas that make the export silently go nowhere

**Nothing arrives and nothing errors.** Exporters fail quietly by design. Check, in this order: is a higher-precedence channel shadowing yours; is the endpoint a base URL without a signal path; does the receiver accept the protocol you chose; does the TLS certificate chain validate on the client (a corporate MITM proxy re-signing traffic is a classic); does the bearer token match.

**Developer environment variables are ignored.** Once `telemetry` is managed, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` and the `COPILOT_OTEL_*` variables lose to the managed value. That is the point, but it surprises developers who had their own Jaeger wired up and suddenly see nothing locally. The VS Code docs recommend removing conflicting OTel environment variables from managed devices to avoid confusion.

**Cloud agent sessions are not in the export.** The `telemetry` property is not supported by Copilot cloud agent. Sessions you start from the app on a local workspace are traced; work delegated to the cloud agent is not, so do not read a quiet dashboard as "nobody is delegating".

**The token on the laptop is readable.** A file-based `managed-settings.json` has to be readable by the app running as the developer (the `chmod 644` above), and an MDM profile is inspectable by anyone with local admin. Anything in `headers` should be an ingest-only credential that can write to one collector and nothing else. Keep the real backend key on the collector.

**JetBrains and the CLI share the block, not the defaults.** The same `telemetry` object configures every supported client, but VS Code's local harness only understands `capture.identity` and the legacy `captureContent`. Fine-grained classes apply to the Copilot CLI, the app, and VS Code sessions using Agent Host. If you mix clients, check what each one actually sends before you trust that `prompts: false` means no prompts anywhere.

**Service names collide with other agents.** VS Code runs Claude agent sessions under `copilot-chat` and Claude Code subprocesses under `claude-code`. If your developers also run Claude Code with its own OTel export, use distinct `serviceName` and resource attributes so queries do not blend two agents' token usage.

## Queries worth building first

Once traces flow, three panels pay for the setup almost immediately:

1. **Token spend per model per day**: sum `gen_ai.client.token.usage` grouped by `gen_ai.response.model` and token type. This is where you see what `auto` model selection is actually choosing, which matters when you are weighing [local versus cloud models in Copilot](/2026/09/local-ollama-models-vs-cloud-models-in-github-copilot/).
2. **Slowest tools**: p95 duration of `execute_tool` spans grouped by `gen_ai.tool.name`. A slow MCP server shows up here long before anyone files a ticket.
3. **Hook denials**: count of `execute_hook` spans where `github.copilot.hook.decision` is a deny, grouped by hook. If this is zero for weeks, your hooks may not be wired to the events you think.

If you are building something on the [Copilot SDK](/2026/10/what-is-the-github-copilot-sdk-and-what-can-you-build-with-it/) instead of using the app, it has its own OpenTelemetry instrumentation with W3C trace context propagation, so your service's spans and the agent's spans can share one trace. The app export is for the case where the agent is the product your developers use every day and you want the same visibility you already have for everything else they ship.

## Sources

- [OpenTelemetry in the GitHub Copilot app](https://github.blog/changelog/2026-09-22-opentelemetry-in-the-github-copilot-app), GitHub changelog, September 22, 2026
- [Enterprise-managed OpenTelemetry export for VS Code and CLI](https://github.blog/changelog/2026-07-08-enterprise-managed-opentelemetry-export-for-vs-code-and-cli/), GitHub changelog, July 8, 2026
- [Deploy managed Copilot settings via MDM in VS Code and CLI](https://github.blog/changelog/2026-07-08-deploy-managed-copilot-settings-via-mdm-in-vs-code-and-cli), GitHub changelog, July 8, 2026
- [Enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings), GitHub Docs
- [OpenTelemetry for agent monitoring](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/enterprise/opentelemetry), GitHub Docs
- [Configure enterprise managed settings](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/configure-enterprise-managed-settings), GitHub Docs
- [Monitor agent usage with OpenTelemetry](https://code.visualstudio.com/docs/copilot/guides/monitoring-agents), VS Code docs
