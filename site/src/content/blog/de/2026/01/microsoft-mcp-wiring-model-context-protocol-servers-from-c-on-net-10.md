---
title: "Microsoft `mcp`: Model Context Protocol-Server aus C# auf .NET 10 verdrahten"
description: "So verdrahten Sie Model Context Protocol (MCP)-Server in C# auf .NET 10 mit microsoft/mcp. Behandelt Tool-Verträge, Eingabevalidierung, Auth, Observability und produktionstaugliche Muster."
pubDate: 2026-01-10
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "mcp"
  - "ai-agents"
lang: "de"
translationOf: "2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
Das heutige GitHub Trending (C#, täglich) enthält **`microsoft/mcp`**, Microsofts Repository für das Model Context Protocol (MCP). Wenn Sie interne Werkzeuge auf **.NET 10** bauen und eine saubere Grenze zwischen einem LLM-Client und Ihren realen Systemen (Dateien, Tickets, Datenbanken, CI) haben wollen, ist MCP die Form, die Sie im Auge behalten sollten.

Quelle: [microsoft/mcp](https://github.com/microsoft/mcp)

## Die nützliche Verschiebung: Werkzeuge werden ein Vertrag, kein ad-hoc-Kleber

Die meisten "KI-Integrationen" beginnen als ad-hoc-Klebercode: Prompt-Vorlagen, ein paar HTTP-Aufrufe und ein wachsender Haufen "noch ein Tool". Sobald Sie Zuverlässigkeit, Auditing oder eine lokale Entwickler-Story brauchen, wollen Sie einen Vertrag:

-   eine auffindbare Menge an Werkzeugen,
-   typisierte Ein- und Ausgaben,
-   vorhersehbarer Transport,
-   Logs, über die Sie nachdenken können.

Genau darauf zielt MCP: eine Protokollgrenze, damit Client und Server unabhängig voneinander weiterentwickelt werden können.

## Die Form eines winzigen MCP-Servers in C# (was Sie tatsächlich implementieren werden)

Die genaue API-Oberfläche hängt davon ab, welche C#-MCP-Bibliothek Sie wählen (und es ist noch früh). Die Server-Form ist jedoch stabil: Werkzeuge definieren, Eingaben validieren, ausführen, strukturierte Ausgabe zurückgeben.

Hier ist ein minimales Beispiel im C#-14-Stil für .NET 10, das den "Vertrag zuerst"-Ansatz zeigt. Behandeln Sie es als Vorlage für die Form Ihrer Handler.

```cs
using System.Text.Json;

public static class CiTools
{
    public static string GetBuildStatus(JsonElement args)
    {
        if (!args.TryGetProperty("pipeline", out var pipelineProp) || pipelineProp.ValueKind != JsonValueKind.String)
            throw new ArgumentException("Missing required string argument: pipeline");

        var pipeline = pipelineProp.GetString()!;

        // Replace with your real implementation (Azure DevOps, GitHub, Jenkins).
        var status = new
        {
            pipeline,
            state = "green",
            lastRunUtc = DateTimeOffset.UtcNow.AddMinutes(-7),
        };

        return JsonSerializer.Serialize(status);
    }
}
```

Die wichtigen Teile sind nicht die Details des JSON-Parsens. Die wichtigen Teile sind:

-   **Explizite Eingabevalidierung**: MCP macht es leicht zu vergessen, dass Sie eine API bauen. Behandeln Sie sie wie eine.
-   **Kein impliziter Umgebungszustand**: übergeben Sie Abhängigkeiten, loggen Sie alles.
-   **Strukturierte Ergebnisse**: liefern Sie stabile Formen, nicht Strings, die unmöglich zu diffen sind.

## Wo das in einer echten .NET-10-Codebasis landet

Wenn Sie MCP in der Produktion einsetzen, kümmern Sie sich um dieselben Dinge wie bei jedem anderen Dienst:

-   **Auth**: der Server muss die Identität durchsetzen, nicht der Client.
-   **Geringste Rechte**: Werkzeuge sollten die kleinstmögliche Oberfläche freigeben.
-   **Observability**: Request-IDs, Tool-Aufruf-Logs und Fehlermetriken.
-   **Determinismus**: Werkzeuge sollten sicher mehrfach aufrufbar sein und wo möglich idempotent.

Wenn Sie diese Woche nur eine Sache machen: klonen Sie das Repository, überfliegen Sie die Protokoll-Dokumentation und entwerfen Sie eine Liste von 5 Werkzeugen, die Sie heute als "Prompt-Kleber" implementieren. Diese Liste reicht meist aus, um eine richtige MCP-Grenze zu rechtfertigen.

Ressource: [microsoft/mcp](https://github.com/microsoft/mcp)
