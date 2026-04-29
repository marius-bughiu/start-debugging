---
title: "C# 14 Idee: Interceptors könnten die Source-Generation von System.Text.Json automatisch wirken lassen"
description: "Eine Community-Diskussion schlug vor, C# 14 Interceptors zu nutzen, um JsonSerializer-Aufrufe so umzuschreiben, dass sie automatisch einen generierten JsonSerializerContext verwenden und so die AOT-freundliche Source-Generation mit saubereren Aufrufstellen erhalten."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
  - "system-text-json"
  - "aot"
lang: "de"
translationOf: "2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics"
translatedBy: "claude"
translationDate: 2026-04-29
---

Eine der interessanteren .NET Diskussionen der letzten 24 bis 48 Stunden war eine einfache Frage: Warum fühlt sich die Source-Generation von `System.Text.Json` an der Aufrufstelle immer noch "manuell" an?

Der Auslöser war ein Thread vom 7. Februar 2026, der einen Ansatz vorschlug, der sehr im Geist von C# 14 ist: **Interceptors**, die `JsonSerializer.Serialize`- und `JsonSerializer.Deserialize`-Aufrufe so umschreiben, dass sie automatisch einen generierten `JsonSerializerContext` verwenden.

## Die Ergonomielücke: Context funktioniert, breitet sich aber durch den Code aus

Wenn Sie in **.NET 10** Trimming-Sicherheit und vorhersagbare Performance möchten, ist Source-Generation eine starke Option. Die Reibung ist, dass Sie den Kontext überall durchschleifen:

```csharp
using System.Text.Json;

var foo = JsonSerializer.Deserialize<Foo>(json, FooJsonContext.Default.Foo);
var payload = JsonSerializer.Serialize(foo, FooJsonContext.Default.Foo);
```

Es ist explizit und korrekt, aber es ist laut. Dieses Rauschen sickert tendenziell in App-Schichten, die sich nicht um Serialisierungs-Verkabelung kümmern sollten.

## Wie eine Interceptor-basierte Umschreibung aussehen könnte

Die Idee ist: Halten Sie die Aufrufstellen sauber:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json);
```

Und lassen Sie dann einen Interceptor (zur Kompilierzeit) ihn in den kontextbasierten Aufruf umschreiben, den Sie von Hand geschrieben hätten:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json, GlobalJsonContext.Default.Foo);
```

Wenn Sie mehrere Options-Profile haben, benötigt der Interceptor eine deterministische Zuordnung zur richtigen Context-Instanz. Genau hier beginnt der "das ist schwer"-Teil.

## Die Beschränkungen, die darüber entscheiden (AOT ist der Richter)

Damit dies mehr als nur eine nette Idee ist, muss es in den Umgebungen überleben, in denen Source-Generation am wichtigsten ist:

- **NativeAOT und Trimming**: Die Umschreibung darf nicht versehentlich reflektionsbasierte Fallbacks wiedereinführen.
- **Options-Identität**: Sie brauchen einen stabilen Weg, einen Kontext für ein gegebenes `JsonSerializerOptions` auszuwählen. Zur Laufzeit mutierte Options passen nicht gut.
- **Partielle Kompilierung**: Interceptors müssen sich projektübergreifend, in Test-Assemblies und bei inkrementellen Builds konsistent verhalten.

Wenn diese Beschränkungen erfüllt sind, bekommen Sie einen seltenen Gewinn: **die AOT-freundliche Pipeline beibehalten**, aber die "Context-Verkabelung" aus dem Großteil Ihres Codes entfernen.

Die praktische Lehre für heute: Selbst wenn Interceptors nicht in der genau diskutierten Form landen, ist dies ein starkes Signal, dass .NET Entwickler bessere Ergonomie rund um Source-Generation wünschen. Ich würde erwarten, dass künftiges Tooling, Analyzer oder Framework-Muster sich in diese Richtung bewegen.

Quellen:

- [Reddit-Thread](https://www.reddit.com/r/csharp/comments/1qyaviv/interceptors_for_systemtextjson_source_generation/)
- [Dokumentation zur System.Text.Json Source-Generation](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation)
