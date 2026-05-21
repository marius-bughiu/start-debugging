---
title: "Cursor 3.4 Adds Multi-Repo Environments and Faster Dockerfile Builds for Cloud Agents"
description: "Cursor 3.4 (May 13, 2026) lets one cloud agent environment include multiple repositories, adds Dockerfile build secrets, layer-cached rebuilds that run 70% faster, and an agent-led setup step that validates credentials before the first run."
pubDate: 2026-05-21
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "docker"
---

On May 13, 2026, Cursor shipped [version 3.4](https://cursor.com/changelog), and the release is mostly about the plumbing that fleets of cloud agents need to actually do work. The headline is multi-repo environments, but the build-secret and layer-caching changes underneath are what make running many agents in parallel cheap enough to be practical. It is a direct follow-on to the parallelism work in [Cursor 3.3](/2026/05/cursor-3-3-build-in-parallel-split-prs/), aimed at teams that already split tasks across subagents and were hitting the "one repo per environment" wall.

## One environment, many repositories

Until 3.4, a cloud agent environment was scoped to a single repository. That broke down the moment a task crossed boundaries: a backend API plus its shared types package, or a Flutter app plus a Dart server, or a `.NET` solution plus a sibling infra repo. You either cloned the extra repos manually in the setup script (slow, fragile) or split the task and lost cross-repo context.

Cursor 3.4 reuses the multi-root workspace machinery and lets you list every repository the agent needs as part of the environment definition. A typical configuration now looks like this:

```json
{
  "name": "api-and-shared-types",
  "repositories": [
    { "url": "github.com/acme/api", "branch": "main" },
    { "url": "github.com/acme/shared-types", "branch": "main" }
  ],
  "dockerfile": "./infra/agent.Dockerfile"
}
```

Both repos clone into the same environment, and the agent sees them as a single workspace. Sessions reuse the environment, so spinning up a new agent against the same pair is a cache hit instead of a fresh clone.

## Build secrets and 70% faster cache hits

The Dockerfile path also got two practical fixes. The first is `--mount=type=secret` for build secrets that stay out of the running container:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:9.0
RUN --mount=type=secret,id=nuget_pat \
    dotnet nuget add source https://nuget.pkg.github.com/acme/index.json \
      --name acme --username ci \
      --password "$(cat /run/secrets/nuget_pat)" --store-password-in-clear-text
COPY . /src
WORKDIR /src
RUN dotnet restore
```

The PAT is scoped to the build step, so the agent process that runs later cannot read it. That closes the hole where private package feeds previously meant baking credentials into the image or the environment script.

The second fix is layer caching. Builds that hit the cache run 70% faster, per the release notes, because only modified layers rebuild when you edit the Dockerfile. In practice that means iterating on the `RUN apt-get install ...` line no longer invalidates a long `dotnet restore` underneath it, as long as the restore layer is above the change.

## Agent-led setup catches missing credentials before the run

When you create or update an environment, Cursor now runs a setup pass that asks clarifying questions, identifies missing credentials, and verifies the build succeeds before letting an agent use it. If the build fails, the environment falls back to a base image and surfaces the warning rather than failing silently the moment an agent tries to clone.

Each environment also keeps a version history with admin-only rollback and an audit log of who changed what. For teams already running parallelized agents at scale, those guardrails matter more than the speed wins.

See the full [Cursor changelog](https://cursor.com/changelog) for the rest of 3.4.
