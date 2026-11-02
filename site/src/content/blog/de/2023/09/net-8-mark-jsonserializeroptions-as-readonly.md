---
title: ".NET 8 JsonSerializerOptions als readonly markieren"
description: "JsonSerializerOptions mit MakeReadOnly einfrieren, den fehlenden TypeInfoResolver ergänzen und eine veränderbare Kopie erstellen: ausführbares .NET-8-Beispiel."
pubDate: 2023-09-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/net-8-mark-jsonserializeroptions-as-readonly"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 friert `JsonSerializerOptions.MakeReadOnly()` eine Optionsinstanz ein. Konfigurieren Sie vorher deren `TypeInfoResolver`: Ein neues Optionsobjekt hat keinen Resolver, daher wirft der sofortige Aufruf der parameterlosen Methode `InvalidOperationException`.

> **Korrektur — 2. November 2026:** Im vorherigen Beispiel fehlte der Resolver, weshalb es bereits bei `MakeReadOnly()` scheiterte. Das folgende Beispiel verwendet generierte Metadaten und funktioniert auch mit deaktivierten Reflection-Standardwerten.

## Konfigurierte Optionen einfrieren

Diese vollständige `Program.cs` verwendet einen generierten Resolver, serialisiert mit eingefrorenen Optionen, weist eine spätere Änderung zurück und erstellt eine unabhängig konfigurierbare Kopie:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
Console.WriteLine(options.IsReadOnly);
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), options));

try
{
    options.WriteIndented = true;
}
catch (InvalidOperationException)
{
    Console.WriteLine("Mutation rejected");
}

var copy = new JsonSerializerOptions(options);
Console.WriteLine(copy.IsReadOnly);
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), copy));

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Ausgabe:

```text
True
{"ID":42,"NAME":"Ada"}
Mutation rejected
False
{"id":42,"name":"Ada"}
```

Nach dem Einfrieren ist `IsReadOnly` gleich `true`. Ein erneuter Aufruf von `MakeReadOnly()` ist zulässig. Eine spätere Änderung einer Einstellung wirft `InvalidOperationException`. Auch Serialisierung oder Deserialisierung macht eine Optionsinstanz schreibgeschützt.

Der Kopierkonstruktor übernimmt die Einstellungen einschließlich Resolver, erstellt aber eine veränderbare Instanz. Konfigurieren Sie die Kopie vor der ersten Verwendung; auch sie wird beim Serialisieren eingefroren.

## Warum wirft MakeReadOnly ohne Resolver eine Ausnahme?

`new JsonSerializerOptions().MakeReadOnly()` wählt keinen Resolver automatisch aus. Geben Sie ihn wie oben ausdrücklich an, oder verwenden Sie `MakeReadOnly(populateMissingResolver: true)`, wenn Reflection-Serialisierung beabsichtigt und aktiviert ist.

Diese Überladung ergänzt einen fehlenden Resolver durch den Reflection-Standardresolver. Sind die Reflection-Standardwerte deaktiviert, kann sie die Lücke nicht schließen und wirft `InvalidOperationException`. Für getrimmte oder Native-AOT-Anwendungen ersetzt sie keine generierten Metadaten. Siehe [Reflection-Standardwerte deaktivieren und einen Kontext konfigurieren](/de/2023/10/system-text-json-disable-reflection-based-serialization/) sowie den [MakeReadOnly-API-Vertrag](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0).

## Das geprüfte Beispiel ausführen

[Laden Sie das vollständige System.Text.Json-Optionsprojekt herunter](/examples/system-text-json-options.zip), entpacken Sie es und führen Sie Folgendes aus:

```sh
dotnet run -c Release
```

Das .NET-8-Projekt ohne zusätzliche Abhängigkeiten prüft fehlende Resolver, wiederholtes Einfrieren, zurückgewiesene Änderungen, generierte Serialisierung und Kopierverhalten. Es prüft `populateMissingResolver` getrennt mit deaktivierten und aktivierten Reflection-Standardwerten. Alle Prüfungen bestanden auf den tatsächlichen Runtimes .NET 8.0.33 und .NET 10.0.10; Befehle und Ergebnisse stehen im Prüfprotokoll des Archivs.
