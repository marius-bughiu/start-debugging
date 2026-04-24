---
title: "Aspire 13.2 --isolated: parallele AppHost-Instanzen ohne Port-Kollisionen laufen lassen"
description: "Aspire 13.2 liefert ein --isolated-Flag aus, das jedem aspire run eigene zufällige Ports und einen eigenen Secrets Store gibt. Es entsperrt Multi-Checkout-Arbeit, Agent-Worktrees und Integrationstests, die einen lebenden AppHost brauchen."
pubDate: 2026-04-18
tags:
  - "aspire"
  - "dotnet-11"
  - "dotnet"
  - "tooling"
lang: "de"
translationOf: "2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances"
translatedBy: "claude"
translationDate: 2026-04-24
---

Zwei Kopien derselben Aspire-App gleichzeitig laufen zu lassen bedeutete schon immer mit `address already in use` zu kämpfen. Aspire 13.2, [diese Woche angekündigt](https://devblogs.microsoft.com/aspire/aspire-13-2-announcement/), fügt ein kleines, aber nützliches Flag hinzu, das den Kampf entfernt: `--isolated`. Jede Invocation bekommt eigene zufällige Ports, einen eigenen User-Secrets-Store und eine eigene Dashboard-URL, sodass zwei AppHosts Seite an Seite leben können, ohne manuelle Port-Neuzuordnung.

## Woher die Kollisionen kamen

Standardmäßig bindet `aspire run` an feste Ports: das Dashboard an 18888, OTLP an 4317/4318, und vorhersagbare Bindings für jede Ressource. Das ist in Ordnung für einen einzelnen Entwickler auf einem einzelnen Branch. Sobald Sie ein zweites Worktree hinzufügen, einen Coding Agent, der eine weitere Instanz hochdreht, oder einen Integrationstest, der einen lebenden AppHost will, kollidiert alles. Teams patchen das mit `launchSettings.json`-Tweaks oder Custom-Port-Maps, und nichts davon komponiert.

## Was `--isolated` tatsächlich ändert

`--isolated` auf `aspire run` oder `aspire start` macht zwei Dinge pro Invocation. Erstens: Jeder Port, der normalerweise an eine feste Nummer gebunden würde (Dashboard, OTLP, Ressourcen-Endpunkte), wird stattdessen an einen zufälligen freien Port gebunden. Service Discovery greift die dynamischen Werte auf, also muss die App selbst nicht wissen, was ihre Geschwister gewählt haben. Zweitens: Der User-Secrets-Backing-Store wird durch eine Instance-ID gekeyt, die einzigartig für den Run ist, sodass Connection Strings und API-Keys nicht zwischen parallelen AppHosts lecken.

Ein typischer Zwei-Branch-Workflow sieht jetzt so aus:

```bash
# Terminal 1 - feature branch worktree
cd ~/src/my-app-feature
aspire run --isolated

# Terminal 2 - bug fix worktree
cd ~/src/my-app-bugfix
aspire run --isolated
```

Beide Prozesse kommen hoch, beide Dashboards sind auf verschiedenen URLs erreichbar, und keiner weiß oder kümmert sich um den anderen. Einen herunterzufahren stört die Port-Reservierungen des anderen nicht.

## Warum das über "mehrere Terminals" hinaus zählt

Der interessantere Konsument ist Tooling. [Detached Mode](https://devblogs.microsoft.com/aspire/aspire-detached-mode-and-process-management/) lässt einen Coding Agent einen AppHost mit `--detach` starten und das Terminal zurückbekommen. Kombiniert mit `--isolated` kann derselbe Agent N AppHosts über N Git-Worktrees parallel hochdrehen, HTTP-Probes oder Integrationstests gegen jeden laufen lassen und sie abreißen, alles ohne manuelle Port-Buchhaltung. Das ist das Muster, das die Background Agents von VS Code schon nutzen, wenn sie Worktrees für exploratorische Arbeit erstellen.

Integrationstest-Suites bekommen den gleichen Nutzen. Früher brauchte das Laufen des AppHosts aus `dotnet test` in CI, während ein Entwickler die App lokal offen hatte, Environment-Overrides. Mit `--isolated` kann das Test-Fixture einfach machen:

```csharp
[Fact]
public async Task ApiReturnsHealthy()
{
    var apphost = await DistributedApplicationTestingBuilder
        .CreateAsync<Projects.MyApp_AppHost>(["--isolated"]);

    await using var app = await apphost.BuildAsync();
    await app.StartAsync();

    var client = app.CreateHttpClient("api");
    var response = await client.GetAsync("/health");

    response.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

Keine statische Port-Map, kein Aufräumen zwischen Test-Runs, keine "habe ich die App laufen gelassen?"-Überraschungen.

## Paarung mit --detach und aspire wait

Der volle Agent-freundliche Loop in 13.2 sieht aus wie `aspire run --isolated --detach`, um im Hintergrund zu starten, `aspire wait api --status healthy --timeout 120`, um zu blockieren, bis die Ressource oben ist, und `aspire resource api restart`, um Teile zu zyklieren, ohne den ganzen Graphen abzureißen. `--isolated` ist das Stück, das diese Loops über N Kopien hinweg komponierbar macht.

Für die vollständige Liste der CLI-Erweiterungen von 13.2 siehe die [Isolated-Mode-Dokumentation](https://devblogs.microsoft.com/aspire/aspire-isolated-mode-parallel-development/).
