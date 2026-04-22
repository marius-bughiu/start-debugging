---
title: "Azure MCP Server Ships Inside Visual Studio 2022 17.14.30, No Extension Required"
description: "Visual Studio 2022 17.14.30 bundles the Azure MCP Server into the Azure development workload. Copilot Chat can hit 230+ Azure tools across 45 services without installing a thing."
pubDate: 2026-04-22
tags:
  - "visual-studio"
  - "azure"
  - "mcp"
  - "github-copilot"
---

The April 15, 2026 [Visual Studio blog post](https://devblogs.microsoft.com/visualstudio/azure-mcp-tools-now-ship-built-into-visual-studio-2022-no-extension-required/) buried a quiet but significant change: starting with Visual Studio 2022 version 17.14.30, the Azure MCP Server is part of the Azure development workload. No marketplace extension, no manual `mcp.json`, no per-machine onboarding. If you have the workload installed and you sign in to both GitHub and Azure, Copilot Chat can already see over 230 Azure tools across 45 services.

## Why bake it in

Until 17.14.30, getting the Azure MCP Server in front of Copilot Chat in VS 2022 meant a separate install, a per-user JSON config, and a reauth dance every time the npx-launched server lost its token. Bundling the server with the workload removes the install step and ties auth to the IDE's existing Azure account picker, so the same login that drives Cloud Explorer drives the MCP tools.

It also brings VS 2022 to parity with VS 2026, which has shipped Azure MCP integration since November 2025.

## Turning it on

The server ships with the workload but is disabled by default. To light it up:

1. Update Visual Studio 2022 to 17.14.30 or higher (Help, Check for Updates).
2. Open the Visual Studio Installer and confirm the Azure development workload is installed.
3. Sign in to your GitHub account so Copilot is active, then sign in to your Azure account from the account picker on the title bar.
4. Open Copilot Chat, click the wrench icon labelled "Select tools," and toggle "Azure MCP Server" on.

After that the server starts on demand the first time Copilot picks an Azure tool. You can verify it from a chat prompt:

```text
> #azmcp list resource groups in subscription Production
```

Copilot will route through the bundled server and return the live list, scoped to the account you signed in with. The same wrench dialog shows individual tools so you can disable noisy ones (for example, the cost ones) without disabling the whole server.

## What you actually get

The bundled server exposes the same tool surface documented at [aka.ms/azmcp/docs](https://aka.ms/azmcp/docs), grouped into four buckets:

- **Learn**: ask service-shape questions ("what tier of Azure SQL supports private link with a serverless replica") without leaving the IDE.
- **Design and develop**: get config snippets and SDK calls grounded in the resources in your subscription, not generic samples.
- **Deploy**: provision resource groups, Bicep deployments, and container apps from chat.
- **Troubleshoot**: pull Application Insights queries, App Service log streams, and AKS pod status into the conversation.

A chat like "the staging app service is returning 502, pull the last hour of failures and tell me what changed" now executes end to end with no copy paste between portal tabs.

## When the standalone server still makes sense

The bundled build follows VS servicing cadence, which lags the upstream `Azure.Mcp.Server` release. If you need a tool that landed last week, register the standalone server alongside the bundled one in `mcp.json` and Copilot will merge the tool lists. For everyone else, deleting that config file is now the right move.
