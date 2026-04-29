---
title: "System.CommandLine v2, aber mit fertiger Verdrahtung: `Albatross.CommandLine` v8"
description: "Albatross.CommandLine v8 baut auf System.CommandLine v2 auf und liefert einen Source Generator, DI-Integration und eine Hosting-Schicht, um CLI-Boilerplate in .NET 9 und .NET 10 Anwendungen zu eliminieren."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/system-commandline-v2-but-with-the-wiring-done-for-you-albatross-commandline-v8"
translatedBy: "claude"
translationDate: 2026-04-30
---
System.CommandLine v2 wurde mit einem deutlich klareren Fokus ausgeliefert: Parsing zuerst, eine vereinfachte Ausführungspipeline, weniger "magische" Verhaltensweisen. Das ist gut, aber die meisten echten CLIs landen trotzdem bei wiederholter Klempnerei: DI-Setup, Handler-Bindung, gemeinsame Optionen, Cancellation und Hosting.

`Albatross.CommandLine` v8 ist ein frischer Blick auf genau diese Lücke. Es baut auf System.CommandLine v2 auf und ergänzt einen Source Generator sowie eine Hosting-Schicht, sodass Sie Befehle deklarativ definieren und den Klebstoff-Code aus dem Weg halten können.

## Das Wertversprechen: weniger bewegliche Teile, mehr Struktur

Der Pitch des Autors ist konkret:

-   Minimale Boilerplate: Befehle mit Attributen definieren, die Verdrahtung generieren lassen
-   DI-First-Komposition: Services pro Befehl, alles injizierbar
-   Async- und Shutdown-Handling: CancellationToken und Ctrl+C von Haus aus
-   Trotzdem anpassbar: Sie können bei Bedarf direkt auf System.CommandLine-Objekte zugreifen

Diese Kombination ist der Sweet Spot für CLI-Anwendungen unter .NET 9 und .NET 10, die "langweilige" Infrastruktur wollen, ohne eine vollständige Framework-Abhängigkeit zu schlucken.

## Ein minimaler Host, der lesbar bleibt

So sieht es aus (vereinfacht aus der Ankündigung):

```cs
// Program.cs (.NET 9 or .NET 10)
using Albatross.CommandLine;
using Microsoft.Extensions.DependencyInjection;
using System.CommandLine.Parsing;

await using var host = new CommandHost("Sample CLI")
    .RegisterServices(RegisterServices)
    .AddCommands() // generated
    .Parse(args)
    .Build();

return await host.InvokeAsync();

static void RegisterServices(ParseResult result, IServiceCollection services)
{
    services.RegisterCommands(); // generated registrations

    // Your app services
    services.AddSingleton<ITimeProvider, SystemTimeProvider>();
}

public interface ITimeProvider { DateTimeOffset Now { get; } }
public sealed class SystemTimeProvider : ITimeProvider { public DateTimeOffset Now => DateTimeOffset.UtcNow; }
```

Der wichtige Punkt ist nicht "schau, ein Host". Der Punkt ist, dass der Host zu einem vorhersagbaren Einstiegspunkt wird, an dem Sie die Handler-Schicht testen und die Befehlsdefinitionen von der Service-Verdrahtung getrennt halten können.

## Wo es passt und wo nicht

Es passt gut, wenn:

-   Sie mehr als 3 bis 5 Befehle haben und sich gemeinsame Optionen zu verteilen beginnen
-   Sie DI in Ihrer CLI wollen, aber nicht für jeden Befehl Handler von Hand verdrahten möchten
-   Ihnen ein sauberer Shutdown wichtig ist, weil Ihre CLI echte Arbeit leistet (Netzwerk, Dateisystem, lange E/A)

Es lohnt sich wahrscheinlich nicht, wenn:

-   Sie ein Werkzeug mit einem einzigen Befehl ausliefern
-   Sie exotisches Parsing-Verhalten brauchen und damit rechnen, sich in den System.CommandLine-Internas aufzuhalten

Wenn Sie es schnell evaluieren wollen, sind das die besten Anlaufstellen:

-   Docs: [https://rushuiguan.github.io/commandline/](https://rushuiguan.github.io/commandline/)
-   Quellcode: [https://github.com/rushuiguan/commandline](https://github.com/rushuiguan/commandline)
-   Reddit-Ankündigung: [https://www.reddit.com/r/dotnet/comments/1q800bs/updated\_albatrosscommandline\_library\_for/](https://www.reddit.com/r/dotnet/comments/1q800bs/updated_albatrosscommandline_library_for/)
