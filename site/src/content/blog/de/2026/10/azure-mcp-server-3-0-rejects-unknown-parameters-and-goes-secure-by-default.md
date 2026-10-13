---
title: "Azure MCP Server 3.0 lehnt unbekannte Parameter ab und erstellt Ressourcen standardmäßig sicher"
description: "Azure MCP Server 3.0.0 erschien am 12. Oktober 2026. Tool-Aufrufe mit unbekannten Parametern schlagen jetzt fehl, Optionen wie subscription und tenant wurden aus vielen Tools entfernt, neue Storage-Konten deaktivieren die Shared-Key-Authentifizierung, und der Server spricht das zustandslose MCP-Protokoll 2026-07-28."
pubDate: 2026-10-13
tags:
  - "mcp"
  - "azure"
  - "dotnet"
  - "ai-agents"
lang: "de"
translationOf: "2026/10/azure-mcp-server-3-0-rejects-unknown-parameters-and-goes-secure-by-default"
translatedBy: "claude"
translationDate: 2026-10-13
---

[Azure MCP Server 3.0.0](https://github.com/microsoft/mcp/releases/tag/Azure.Mcp.Server-3.0.0) erschien am 12. Oktober 2026, nach 50 Beta-Builds. Im Vordergrund stehen viele neue Namespaces (`azurebackup`, `resiliency`, `sreagent`, `azureterraform`, `advisor`, `iothub`), aber der Teil, der heute eine funktionierende Konfiguration brechen kann, ist unauffälliger: Die Tool-Verträge wurden strenger, und vom Server erstellte Ressourcen sind standardmäßig abgesichert.

## Unbekannte Parameter sind jetzt ein Fehler

In 2.x ignorierte ein Tool Optionen, die es nicht verwendete, stillschweigend. 3.0 entfernt ungenutzte Parameter wie `subscription`, `resource-group`, `tenant`, `auth-method`, `user` und `sender-name` aus den Tools in fast allen Namespaces (Key Vault, Storage, SQL, Redis, Service Bus, AKS und weitere) und lehnt dann jeden Aufruf ab, der sie weiterhin übergibt. Auch benutzerdefinierte Optionen für die Wiederholungsrichtlinie sind entfallen; es gelten die Standardwerte des Azure SDK.

Das ist relevant, wenn Sie `azmcp` aus Skripten steuern oder gespeicherte Prompts und Agent-Anweisungen haben, die das Modell anweisen, immer eine Subscription mitzugeben. Ein Aufruf, der unter 2.x so funktionierte:

```bash
azmcp keyvault secret get --subscription 00000000-0000-0000-0000-000000000000 \
  --vault my-vault --secret db-password --retry-max-retries 5
```

scheitert unter 3.0 an der Validierung: `keyvault secret get` akzeptiert nur `--vault` und ein optionales `--secret`, und die globalen `--retry-*`-Optionen existieren nicht mehr. Entfernen Sie sie und prüfen Sie in der [Befehlsreferenz](https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/docs/azmcp-commands.md), was jedes Tool tatsächlich entgegennimmt. Einige Ergebnis-Payloads wurden außerdem zu benannten Objekten normalisiert (`{ servers }`, `{ results }`, `{ guidance }`), sodass Parser, die die alten Formen lesen, angepasst werden müssen.

Zwei weitere Umbenennungen sind zu beachten: `monitor healthmodels entity get` wurde zu `list` und `get`, und der Servercode wechselte von `Azure.Mcp.Core.*` zu `Microsoft.Mcp.Core.*`. Logger-Kategorien folgen den Namespaces, deshalb greift ein Eintrag `Logging:LogLevel:Azure.Mcp.Core` in Ihrer Konfiguration nicht mehr.

## Standardmäßig sichere Ressourcenerstellung

Wenn ein Agent über den Server Ressourcen erstellt, haben sich die Standardwerte geändert:

- Storage-Konten deaktivieren die Shared-Key-Authentifizierung (HTTPS, TLS 1.2 und kein anonymer Blob-Zugriff bleiben aktiv).
- Event-Hubs-Namespaces deaktivieren die lokale Authentifizierung.
- NFS-Dateifreigaben verwenden standardmäßig `RootSquash` mit verschlüsselter Übertragung.
- `compute vm create` und `compute vmss create` erfordern `--image`; die Aliase `Win2019Datacenter` und `Ubuntu2004` wurden entfernt.

Wenn nachgelagerter Code sich mit einem Kontoschlüssel oder einer damit signierten SAS verbindet, erhält er bei einem frisch erstellten Konto ein 403. Das ist beabsichtigt: Verwenden Sie Entra ID und `DefaultAzureCredential`.

Die Tools `database query` für MySQL und PostgreSQL wurden in die andere Richtung geändert. Sie sind jetzt als destruktiv markiert, filtern Anweisungen nicht mehr nach SQL-Verb und verlassen sich auf die Datenbankberechtigungen des angemeldeten Benutzers. Starten Sie den Server mit `--read-only` oder verwenden Sie einen schreibgeschützten Datenbank-Login, wenn der Agent nur lesen soll.

## Zustandsloses Protokoll und strukturierte Ausgabe

3.0 wechselt zum zustandslosen MCP-Protokoll `2026-07-28` und bleibt für Clients mit `2025-11-25` abwärtskompatibel. Falls Sie diese Revision noch nicht verfolgt haben: Was entfällt (kein `initialize`-Handshake, keine `Mcp-Session-Id`), habe ich in [stateful vs stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/) behandelt.

Tools können jetzt außerdem `outputSchema` und `structuredContent` zurückgeben, aktivierbar über ein Flag. Mit `dnx` aus .NET 10 sieht der Eintrag in `mcp.json` so aus:

```json
{
  "mcpServers": {
    "azure-mcp-server": {
      "command": "dnx",
      "args": [
        "Azure.Mcp", "--version", "3.0.0", "--yes", "--",
        "azmcp", "server", "start",
        "--read-only",
        "--structured-output-mode", "compact"
      ],
      "type": "stdio"
    }
  }
}
```

`compact` sendet kurzen Text in `content` und das vollständige Ergebnis in `structuredContent`; `duplicated` sendet das vollständige Ergebnis in beiden. Aktivieren Sie das nur, wenn Ihr Client diese Felder versteht.

## Kleinere Korrekturen, die das Upgrade lohnen

Logmeldungen und Exceptions, die nach stdout gelangten (und die JSON-RPC-Ausgabe beschädigen konnten), gehen jetzt nach stderr, Not-found-Fehler liefern 404 statt 500, und der npm-Wrapper ändert nicht mehr die `package.json` des aufrufenden Projekts, wenn er ein Plattformpaket automatisch installiert. Legen Sie `Azure.Mcp` 3.0.0 oder `@azure/mcp@3.0.0` explizit fest statt `@latest`, bis Ihre Skripte und Prompts bereinigt sind.
