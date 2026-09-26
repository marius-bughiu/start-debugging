---
title: "Microsoft.Extensions.AI.OpenAI 10.10.1 behebt die TypeLoadException mit OpenAI 2.14"
description: "OpenAI 2.14.0 hat GlobalMcpToolCallApprovalPolicy umbenannt und damit jeden Responses-API-Aufruf mit Tools über Microsoft.Extensions.AI.OpenAI 10.10.0 gebrochen. Version 10.10.1 wechselt auf OpenAI 2.14.0 und übernimmt auch den Fix für einen null-Reasoning-Status bei OpenAI-kompatiblen Endpunkten."
pubDate: 2026-09-26
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "openai"
  - "csharp"
lang: "de"
translationOf: "2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception"
translatedBy: "claude"
translationDate: 2026-09-26
---

`Microsoft.Extensions.AI.OpenAI` 10.10.1 ist am 25. September 2026 auf NuGet erschienen, und die [Release Notes](https://github.com/dotnet/extensions/releases/tag/v10.10.1) bestehen aus einer Zeile: "Upgrade OpenAI SDK to 2.14.0". Hinter dieser Zeile steckt ein Laufzeitabsturz. Wenn Ihre Anwendung `Microsoft.Extensions.AI.OpenAI` 10.10.0 referenziert und irgendetwas im Abhängigkeitsgraphen `OpenAI` auf 2.14.0 angehoben hat (ein Dependabot-Bump, eine direkte Referenz, ein anderes Paket), scheitert seit dem 15. September jeder Responses-API-Aufruf mit einem Tool an einer `TypeLoadException`.

## Ein umbenannter experimenteller Typ, aufgelöst zur JIT-Zeit

`OpenAI` 2.14.0 erschien am 15. September. Unter anderem wurde das experimentelle Struct `OpenAI.Responses.GlobalMcpToolCallApprovalPolicy` zu `DefaultMcpToolCallApprovalPolicy`, und die Eigenschaft `GlobalPolicy` von `McpToolCallApprovalPolicy` zu `DefaultPolicy`. Experimentelle APIs (`OPENAI001`) dürfen brechen, aber `Microsoft.Extensions.AI.OpenAI` 10.10.0 wurde gegen den alten Namen in `OpenAIResponsesChatClient.ToResponseTool` kompiliert, der Methode, die jedes `AITool` in ein Responses-Tool übersetzt.

Die nuspec von 10.10.0 deklariert `OpenAI` mit einer Mindestversion von `2.13.0`, also löst NuGet klaglos 2.14.0 auf, sobald etwas anderes danach verlangt. Beim Build schlägt nichts fehl. Der erste Aufruf mit Tools in `ChatOptions` scheitert, wenn der JIT `ToResponseTool` kompiliert:

```text
System.TypeLoadException: Could not load type 'OpenAI.Responses.GlobalMcpToolCallApprovalPolicy'
from assembly 'OpenAI, Version=2.14.0.0, Culture=neutral, PublicKeyToken=b4187f3e65366280'.
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.ToResponseTool(AITool tool, ChatOptions options, ToolSearchLookup toolSearchLookup)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.AsCreateResponseOptions(...)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.GetStreamingResponseAsync(...)
```

Ob Sie MCP nutzen, spielt keine Rolle. Die Methode referenziert den Typ, also löst auch eine einfache `AIFunction` den Fehler aus. [Issue #7760](https://github.com/dotnet/extensions/issues/7760) hat das Problem mit `Microsoft.Agents.AI.OpenAI` 1.21.0 unter .NET 10 gemeldet.

## Warum ein Verbleib bei OpenAI 2.13.0 kein sauberer Workaround war

`OpenAI` auf 2.13.0 zurückzupinnen vermeidet den Absturz, doch 2.13.0 hat einen eigenen Bug: Die Deserialisierung von `ReasoningResponseItem` ruft `ToReasoningStatus()` auf einem JSON-`null` auf. OpenAI-kompatible Backends von Drittanbietern, die ein Reasoning-Element als `"status": null` serialisieren statt es wegzulassen, reißen den gesamten SSE-Stream mit `ArgumentOutOfRangeException: Unknown ReasoningStatus value` ab. OpenAI 2.14.0 hat die null-Prüfung ergänzt. Eine Woche lang mussten Sie sich also aussuchen, welchen Bug Sie lieber hatten.

[PR #7761](https://github.com/dotnet/extensions/pull/7761) behebt beides: Er hebt auf `OpenAI` 2.14.0 an, bildet `HostedMcpServerToolAlwaysRequireApprovalMode` und `HostedMcpServerToolNeverRequireApprovalMode` auf `DefaultMcpToolCallApprovalPolicy` ab und ergänzt einen Streaming-Regressionstest für den Fall `status` null.

## Das Upgrade

Aktualisieren Sie beide Pakete gemeinsam. `Microsoft.Extensions.AI.OpenAI` 10.10.1 verlangt jetzt `OpenAI` 2.14.0. Wenn Sie 2.13.0 als Workaround gepinnt haben, entfernen Sie diesen Pin, sonst erhalten Sie einen Downgrade-Fehler `NU1605`:

```xml
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.AI.OpenAI" Version="10.10.1" />
  <PackageReference Include="OpenAI" Version="2.14.0" />
</ItemGroup>
```

Prüfen Sie anschließend, was tatsächlich aufgelöst wurde, denn Agent-Frameworks und SDK-Wrapper ziehen diese Pakete oft transitiv herein:

```bash
dotnet list package --include-transitive | grep -E "OpenAI|Extensions.AI"
```

Wenn Ihr eigener Code die MCP-Approval-Typen direkt verwendet, betrifft die Umbenennung auch Sie:

```csharp
#pragma warning disable OPENAI001
var policy = new McpToolCallApprovalPolicy(DefaultMcpToolCallApprovalPolicy.NeverRequireApproval);
var mode = policy.DefaultPolicy; // was policy.GlobalPolicy in OpenAI 2.13.0
#pragma warning restore OPENAI001
```

Die allgemeine Lehre: Eine Mindestversions-Abhängigkeit einer Bibliothek auf ein Paket mit experimentellen APIs ist faktisch ein offener Bereich für Breaking Changes. Wer einen Responses-basierten Agenten in Produktion betreibt, hätte das mit einem Smoke-Test, der nach jedem Dependency-Bump eine Anfrage mit Tool sendet, im CI statt zur Laufzeit gefunden. Was sich in dieser Release-Linie sonst geändert hat, steht im früheren Beitrag über [Microsoft.Extensions.AI 10.10 und nicht bewertete Evaluationsmetriken](/de/2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics/).
