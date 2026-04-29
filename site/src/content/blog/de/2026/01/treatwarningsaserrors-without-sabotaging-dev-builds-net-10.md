---
title: "TreatWarningsAsErrors, ohne die Dev-Builds zu sabotieren (.NET 10)"
description: "Wie Sie TreatWarningsAsErrors in Release-Builds und CI durchsetzen, während Debug für lokale Entwicklung in .NET 10 flexibel bleibt - mit Directory.Build.props."
pubDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Wenn Sie `TreatWarningsAsErrors` schon einmal auf `true` gestellt und es sofort bereut haben, sind Sie nicht allein. Ein kürzlicher r/dotnet-Thread, der gerade die Runde macht, schlägt eine einfache Anpassung vor: Erzwingen Sie warnungsfreien Code in Release (und CI), halten Sie aber Debug für lokales Erkunden flexibel: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

## Nur-Release-Erzwingung ist eine Policy, kein Schalter

Worum es Ihnen wirklich geht, ist ein Workflow:

-   Entwickler können lokal frei experimentieren, ohne mit Analyzer-Rauschen zu kämpfen.
-   Pull Requests schlagen fehl, wenn sich neue Warnungen einschleichen.
-   Sie haben weiterhin einen Pfad, um die Strenge mit der Zeit anzuziehen.

In .NET-10-Repositories ist die sauberste Stelle, das zu zentralisieren, `Directory.Build.props`. Damit gilt die Regel für jedes Projekt, auch für Test-Projekte, ohne Copy-Paste.

Hier ein minimales Muster:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

Das passt zu dem, was die meisten CI-Pipelines ohnehin bauen (Release). Baut Ihre CI Debug, stellen Sie sie zuerst auf Release um. So entspricht die Latte "warnungsfrei" den Binaries, die Sie ausliefern.

## Strikt sein heißt nicht blind sein

Zwei Stellschrauben zählen, sobald Sie den großen Schalter umlegen:

-   `WarningsAsErrors`: nur bestimmte Warnungs-IDs eskalieren.
-   `NoWarn`: bestimmte Warnungs-IDs unterdrücken (idealerweise mit Kommentar und Tracking-Link).

Beispiel, um eine Warnung zu verschärfen und den Rest als Warnung zu lassen:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsAsErrors>$(WarningsAsErrors);CS8602</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

Und wenn Sie einen lauten Analyzer in einem Projekt vorübergehend stummschalten müssen:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <NoWarn>$(NoWarn);CA2007</NoWarn>
  </PropertyGroup>
</Project>
```

Wenn Sie Roslyn-Analyzer einsetzen (in modernen .NET-10-Solutions üblich), ziehen Sie auch `.editorconfig` für die Severity-Steuerung in Betracht, weil sie auffindbar ist und die Policy nah am Code hält:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.CA2007.severity = warning
```

## Der praktische Gewinn für PRs

Der eigentliche Gewinn ist berechenbares PR-Feedback. Entwickler lernen schnell, dass Warnungen keine "Zukunftsarbeit" sind, sondern Teil der Definition of Done für Release. Debug bleibt schnell und nachsichtig, Release bleibt strikt und auslieferungsbereit.

Wenn Sie den ursprünglichen Auslöser dieses Musters (und den winzigen Snippet, der die Diskussion gestartet hat) sehen wollen, schauen Sie hier in den Thread: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)
