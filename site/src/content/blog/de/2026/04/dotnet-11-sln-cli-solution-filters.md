---
title: "dotnet sln bearbeitet endlich Solution Filters von der CLI aus in .NET 11 Preview 3"
description: ".NET 11 Preview 3 bringt dotnet sln bei, Projekte in .slnf Solution Filters zu erstellen, hinzuzufügen, zu entfernen und aufzulisten, sodass große Monorepos eine Teilmenge laden können, ohne Visual Studio zu öffnen."
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "sdk"
  - "dotnet-cli"
  - "msbuild"
lang: "de"
translationOf: "2026/04/dotnet-11-sln-cli-solution-filters"
translatedBy: "claude"
translationDate: 2026-04-24
---

Solution Filters (`.slnf`) gibt es seit Visual Studio 2019, aber sie außerhalb der IDE zu bearbeiten bedeutete, JSON von Hand zu schreiben. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) behebt das: `dotnet sln` erstellt, bearbeitet und listet jetzt den Inhalt von `.slnf`-Dateien direkt, via [dotnet/sdk #51156](https://github.com/dotnet/sdk/pull/51156). Für große Repositories ist das der Unterschied zwischen einer Teilmenge von zwanzig Projekten vom Terminal aus zu öffnen und ein Shell-Skript zu pflegen, das manuell an JSON herumstochert.

## Was ein Solution Filter tatsächlich ist

Ein `.slnf` ist ein JSON-Zeiger auf eine übergeordnete `.sln` plus eine Liste von Projektpfaden. Wenn ein Tool den Filter lädt, entlädt es jedes Projekt in der übergeordneten Solution, das nicht auf der Liste steht. Das hält Build-Graphen, Analyzer und IntelliSense auf der Teilmenge fokussiert, die Sie interessiert - der Haupthebel, den große Code Bases haben, um die Ladezeiten der IDE vernünftig zu halten. Bis Preview 3 konnte die CLI einen Filter zwar problemlos `build`en, aber nicht bearbeiten.

## Die neuen Kommandos

Die Oberfläche spiegelt die bestehenden `dotnet sln`-Verben. Sie können einen Filter erzeugen, Projekte hinzufügen und entfernen, und auflisten, was aktuell enthalten ist:

```bash
# Create a filter that points at the current .sln
dotnet new slnf --name MyApp.slnf

# Target a specific parent solution
dotnet new slnf --name MyApp.slnf --solution-file ./MyApp.sln

# Add and remove projects
dotnet sln MyApp.slnf add src/Lib/Lib.csproj
dotnet sln MyApp.slnf add src/Api/Api.csproj src/Web/Web.csproj
dotnet sln MyApp.slnf remove src/Lib/Lib.csproj

# Inspect what the filter currently loads
dotnet sln MyApp.slnf list
```

Die Kommandos akzeptieren die gleichen Glob- und Multi-Argument-Formen, die `dotnet sln` bereits für `.sln`-Dateien unterstützt, und sie schreiben `.slnf`-JSON, das dem entspricht, was Visual Studio emittiert - also öffnet ein per CLI editierter Filter sauber in der IDE.

## Warum das für Monorepos zählt

Zwei Workflows werden deutlich billiger. Der erste ist CI: Eine Pipeline kann das ganze Repo auschecken, aber nur den Filter bauen, der für die geänderten Pfade relevant ist. Vor Preview 3 machten die meisten Teams das mit einem eigenen Skript, das JSON schrieb, oder hielten handgepflegte `.slnf`-Dateien neben der `.sln`. Jetzt kann dieselbe Pipeline Filter on-the-fly regenerieren:

```bash
dotnet new slnf --name ci-api.slnf --solution-file MonoRepo.sln
dotnet sln ci-api.slnf add \
  src/Api/**/*.csproj \
  src/Shared/**/*.csproj \
  test/Api/**/*.csproj

dotnet build ci-api.slnf -c Release
```

Der zweite ist lokale Entwicklung. Große Repos liefern oft eine Handvoll "Starter"-Filter, damit eine neue Entwicklerin das Backend öffnen kann, ohne zu warten, bis die Mobile- und Docs-Projekte laden. Diese Filter aktuell zu halten, erforderte früher, jeden in Visual Studio zu öffnen, nachdem ein Projekt bewegt wurde, weil `.sln`-Renamings `.slnf` nicht automatisch aktualisiert haben. Mit den neuen Kommandos ist das Update ein Einzeiler:

```bash
dotnet sln backend.slnf remove src/Legacy/OldService.csproj
dotnet sln backend.slnf add src/Services/NewService.csproj
```

## Eine kleine Anmerkung zu Pfaden

`dotnet sln` löst Projektpfade relativ zum Filter auf, nicht zum Aufrufer, was passt, wie die IDE sie liest. Wenn die `.slnf` in `build/filters/` lebt und auf Projekte unter `src/` zeigt, ist der gespeicherte Pfad `..\..\src\Foo\Foo.csproj`, und `dotnet sln list` zeigt ihn genauso. Das lohnt sich zu merken, wenn Sie Filter-Edits aus einem anderen Arbeitsverzeichnis skripten.

Kombiniert mit [`dotnet run -e` für Inline-Umgebungsvariablen](https://github.com/dotnet/sdk/pull/52664) und den früheren [Ein-Schritt-EF-Core-Migrations](https://startdebugging.net/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) meißelt Preview 3 weiter an der Menge "Ich muss Visual Studio öffnen, um das zu tun". Die vollständige Liste steht in den [.NET 11 Preview 3 SDK Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md).
