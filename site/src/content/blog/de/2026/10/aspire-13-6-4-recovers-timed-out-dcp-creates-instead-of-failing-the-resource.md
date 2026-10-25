---
title: "Aspire 13.6.4 stellt DCP-Create-Aufrufe nach einem Timeout wieder her, statt die Ressource scheitern zu lassen"
description: "Aspire 13.6.4 verhindert, dass ein einzelner DCP-Create-Aufruf mit Timeout oder HTTP 504 eine Ressource in FailedToStart schickt, und stellt drei DcpPublisher-Timeouts bereit, die Sie auf langsamen CI-Runnern erhöhen können."
pubDate: 2026-10-25
tags:
  - "aspire"
  - "dotnet"
  - "ci"
lang: "de"
translationOf: "2026/10/aspire-13-6-4-recovers-timed-out-dcp-creates-instead-of-failing-the-resource"
translatedBy: "claude"
translationDate: 2026-10-25
---

Wenn Ihr Aspire-13.6-AppHost auf CI zufällig mit einer Ressource in `FailedToStart` scheitert, ist [Aspire 13.6.4](https://github.com/microsoft/aspire/releases/tag/v13.6.4), veröffentlicht am 24. Oktober 2026, der passende Patch. Er ändert, wie der AppHost mit der Developer Control Plane (DCP) spricht, wenn ein Create-Aufruf nicht rechtzeitig zurückkommt, und macht diese Timeouts endlich konfigurierbar.

## Ein einziger langsamer Create-Aufruf genügte, um eine Ressource zu töten

Seit 13.6.0 wurde ein einzelner `Create`-Request an den API-Server von DCP, der in ein Timeout lief oder HTTP 504 zurückgab, nicht wiederholt. Die Ressource ging direkt in `FailedToStart`, und alles, was per `WaitFor` auf sie wartete, scheiterte mit "Stopped waiting for resource ... because it failed to start." Der Bericht in [microsoft/aspire#20691](https://github.com/microsoft/aspire/issues/20691) stammt von GitHub-gehosteten `macos-15-intel`-Runnern mit 2 vCPUs, auf denen das letzte Projekt im Graphen startete, während seine Abhängigkeiten noch hochfuhren. Die Logs zeigten entweder eine Polly-`TimeoutRejectedException` nach dem 20-Sekunden-Budget des Clients oder ein `GatewayTimeout` von DCP nach etwa 34 Sekunden.

Das Heikle daran: Ein Timeout bedeutet nicht, dass der Create-Aufruf fehlgeschlagen ist. DCP hat das Objekt möglicherweise einen Moment nach dem Aufgeben des Clients angelegt, daher ist auch ein blinder Wiederholungsversuch nicht sicher.

## Erst bestätigen, dann dasselbe Objekt wiederholen

Der Fix in [#20752](https://github.com/microsoft/aspire/pull/20752) (zurückportiert in [#20868](https://github.com/microsoft/aspire/pull/20868)) behandelt einen Create-Aufruf mit Timeout, 502, 503, 504 oder 429 als mehrdeutig. Vor einem erneuten Versuch sendet der AppHost ein `GET` für dasselbe benannte Objekt. Hat DCP es bereits angelegt, wird dieses Objekt verwendet, und die Ressource startet weiter. Liefert das `GET` 404, wird der Create-Aufruf mit Jitter-Backoff wiederholt, der bei 5 Sekunden gedeckelt ist. Auch die Antwort "already exists" bei einem Wiederholungsversuch wird akzeptiert, da der frühere Versuch erst nach der Bestätigungsprüfung angekommen sein kann. Das `GET` ist wichtig, weil es die Publication-Sperre des API-Servers umgeht, hinter der ein zweites `POST` blockieren könnte.

Das eigene `HttpClientTimeout` des KubernetesClient-Pakets von 100 Sekunden ist jetzt deaktiviert, sodass es ein konfiguriertes Budget nicht mehr verkürzen und als unzusammenhängende Abbruchmeldung auftauchen kann.

## Drei Stellschrauben unter DcpPublisher

Die Budgets sind jetzt reguläre Optionen in der AppHost-Konfiguration:

| Schlüssel | Standard | Zweck |
| --- | --- | --- |
| `DcpPublisher:KubernetesApiTimeout` | 40 s | Pro API-Operation |
| `DcpPublisher:KubernetesInitializationAdditionalTimeout` | 20 s | Zusätzlich bis zur ersten erfolgreichen Operation |
| `DcpPublisher:KubernetesCreateRecoveryTimeout` | 2 min | Gesamtbudget für die Wiederherstellung eines Create-Aufrufs |

Jeder Wert muss zwischen einer Sekunde und zehn Minuten liegen, und API- und Initialisierungs-Timeout zusammen dürfen zehn Minuten nicht überschreiten, sonst schlägt die Validierung der Optionen beim Start fehl. Bestehende Watch- und Log-Streams unterliegen diesen Limits nicht.

Auf einem ressourcenknappen Runner erhöhen Sie sie in der `appsettings.json` des AppHosts:

```json
{
  "DcpPublisher": {
    "KubernetesApiTimeout": "00:01:30",
    "KubernetesInitializationAdditionalTimeout": "00:00:45",
    "KubernetesCreateRecoveryTimeout": "00:05:00"
  }
}
```

Oder Sie behalten die Standardwerte im Repository und setzen sie nur im CI-Workflow, da Umgebungsvariablen ebenfalls über `IConfiguration` gebunden werden:

```yaml
env:
  DcpPublisher__KubernetesApiTimeout: "00:01:30"
  DcpPublisher__KubernetesCreateRecoveryTimeout: "00:05:00"
```

Für das Upgrade heben Sie die Version von `Aspire.AppHost.Sdk` und der `Aspire.Hosting.*`-Pakete auf `13.6.4` an. Dasselbe Release beschränkt außerdem die CLI-Diagnoseprotokolle unter Unix auf `0600`-Dateien in einem `0700`-Verzeichnis, weil diese Logs Login-URLs des Dashboards enthalten können. Wenn Sie die 13.6-Reihe nachholen, behandelt der [Beitrag zum Dashboard-Ausführungsverlauf](/de/2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs/) die Hauptfunktion dieses Releases.
