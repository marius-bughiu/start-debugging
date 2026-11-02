---
title: "System.Text.Json reflection-basierte Serialisierung deaktivieren"
description: "Reflection-Standardwerte in System.Text.Json deaktivieren, InvalidOperationException erklären und mit einem generierten Kontext serialisieren: ausführbares .NET-8-Beispiel."
pubDate: 2023-10-21
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 deaktiviert `JsonSerializerIsReflectionEnabledByDefault` mit dem Wert `false` den standardmäßigen Reflection-Fallback von `System.Text.Json`. Die benötigten Serialisierungsmetadaten stellen Sie anschließend über einen per Quellcodegenerierung erzeugten Kontext bereit.

> **Korrektur — 2. November 2026:** Die vorherige Fassung nannte die falsche Ausnahme und erweckte den Eindruck, ein Optionsobjekt allein genüge. Ohne Reflection-Standardwerte wirft ein normaler Serialisierungsaufruf `InvalidOperationException`; leere Optionen beheben das Problem nicht.

## Reflection-Standardwerte deaktivieren

Ergänzen Sie diese Eigenschaft in Ihrer `.csproj`-Datei:

```xml
<PropertyGroup>
  <JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Mit dieser Einstellung schlagen sowohl `JsonSerializer.Serialize(widget)` als auch `JsonSerializer.Serialize(widget, new JsonSerializerOptions())` fehl. Ein Optionsobjekt liefert noch keine Typmetadaten. `JsonSerializer.IsReflectionEnabledByDefault` zeigt den wirksamen Wert des Schalters an.

Der Schalter betrifft den standardmäßigen Reflection-Pfad des Serializers, nicht sämtliche Reflection in der Anwendung. Seit .NET 8 deaktiviert auch `PublishTrimmed` diese Standardwerte, sofern Sie die Einstellung nicht ausdrücklich überschreiben. Siehe [Microsofts Kompatibilitätshinweis zum Trimming](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed).

## Mit generierten Metadaten serialisieren und deserialisieren

Verwenden Sie diese vollständige `Program.cs` in einem .NET-8-Konsolenprojekt mit der obigen Eigenschaft:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault);
var widget = new Widget(42, "Ada");
string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Ausgabe:

```text
False
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
```

`[JsonSerializable]` registriert `Widget`; der Kontext liefert direkt dessen generiertes `JsonTypeInfo<Widget>`. Für diese Überladungen ist kein zusätzliches Optionsobjekt erforderlich.

Erwartet eine API stattdessen `JsonSerializerOptions`, konfigurieren Sie den Resolver ausdrücklich:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
string json = JsonSerializer.Serialize(widget, options);
```

Registrieren Sie die tatsächlich serialisierten Wurzeltypen, gegebenenfalls einschließlich Collections. Bei Enums hilft [JsonStringEnumConverter mit Native AOT](/de/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/). Zum Wiederverwenden eingefrorener Optionen siehe [MakeReadOnly und die Resolver-Anforderung](/de/2023/09/net-8-mark-jsonserializeroptions-as-readonly/).

## Das geprüfte Beispiel ausführen

[Laden Sie das vollständige System.Text.Json-Optionsprojekt herunter](/examples/system-text-json-options.zip), entpacken Sie es und führen Sie Folgendes aus:

```sh
dotnet run -c Release
```

Das Projekt ohne zusätzliche Abhängigkeiten zielt auf .NET 8 und prüft die fehlschlagenden Standardaufrufe, die generierte Serialisierung samt Rückweg sowie den Options-Resolver. Außerdem prüft es schreibgeschützte Optionen. Alle Prüfungen liefen auf den tatsächlichen Runtimes .NET 8.0.33 und .NET 10.0.10; die getrennten Befehle stehen im Archiv. Dasselbe Projekt wurde außerdem als .NET 8 Native AOT für macOS arm64 veröffentlicht und ausgeführt. Die absichtlichen Fehlerprüfungen und Reflection-abhängigen Überladungen erzeugen Analysewarnungen; diese sind im Prüfprotokoll verzeichnet.

Weitere Hinweise zu unterstützten Typen und zur Integration enthält [Microsofts Anleitung zur Quellcodegenerierung](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation).
