---
title: "C#-Unions in ASP.NET Core 11: Bodys, SignalR und OpenAPI funktionieren, Query Strings nicht"
description: "Das ASP.NET Core-Team hat kartiert, wo C# 15-Union-Typen in .NET 11 funktionieren: Bodys in Minimal APIs und MVC, das JsonHubProtocol von SignalR, Blazor und anyOf-Schemas in OpenAPI. Binding aus Route, Query, Headern und Formularen wird noch nicht unterstützt."
pubDate: 2026-09-11
tags:
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "signalr"
lang: "de"
translationOf: "2026/09/csharp-unions-in-aspnetcore-11-where-binding-works"
translatedBy: "claude"
translationDate: 2026-09-11
---

Am 10. September, einen Tag nach dem Release von .NET 11 RC 1, hat das ASP.NET Core-Team [Use C# unions and closed hierarchies in ASP.NET Core](https://devblogs.microsoft.com/dotnet/unions-and-closed-hierarchies-in-aspnetcore/) veröffentlicht. Es ist die erste vollständige Übersicht darüber, wo `union`-Typen aus C# 15 im Web-Stack tatsächlich funktionieren, und die Antwort ist einfach: Alles, was über System.Text.Json läuft, funktioniert, alles andere nicht.

## Unions als Request-Body und Rückgabetyp

Da Unions als ihr aktiver Fall serialisiert werden, ohne Wrapper oder Diskriminator (das Verhalten, das mit [System.Text.Json in .NET 11 Preview 6](/de/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) kam), kann eine Minimal API sie direkt annehmen und zurückgeben:

```csharp
public record Cat(string Name, string Coat);
public record Dog(string Name, string Breed);

[JsonUnion(TypeClassifier = typeof(JsonUnionTypeStructuralClassifier))]
public union UnionPet(Cat, Dog);

public union UnionIntString(int, string);

app.MapPost("/pet", ([FromBody] UnionPet pet) => TypedResults.Ok(pet));
app.MapGet("/value", () => new UnionIntString(42));
```

`UnionPet` braucht den strukturellen Classifier, weil beide Fälle JSON-Objekte sind: STJ muss sich die Eigenschaftsnamen (`coat` vs `breed`) ansehen, um vor dem Deserialisieren einen Fall auszuwählen. Dieser Scan kostet pro Anfrage zusätzliche Arbeit, und das Umbenennen einer Eigenschaft kann stillschweigend ändern, welcher Fall gewinnt. Diese Eigenschaftsnamen gehören also zu Ihrem Vertrag.

MVC-Controller erhalten dasselbe Verhalten über die Input- und Output-Formatter von STJ, sodass ein Action-Parameter `[FromBody] UnionBoolString` oder ein Union-Rückgabetyp ohne weitere Konfiguration funktioniert.

## OpenAPI erzeugt anyOf

Der in .NET 11 integrierte OpenAPI-Generator beschreibt eine Union als `anyOf` mit einem Eintrag pro Fall:

```json
"UnionIntString": {
  "anyOf": [
    { "type": "integer", "format": "int32" },
    { "type": "string" }
  ]
}
```

Genau diese Form brauchen Client-Generatoren für Verträge wie `maxUnavailable` aus Kubernetes, das sowohl `2` als auch `"25%"` akzeptiert. Vor Unions modellierte man das mit einem eigenen `JsonConverter` und einem handgeschriebenen Schema-Transformer.

## SignalR und Blazor

Das `JsonHubProtocol` von SignalR unterstützt Unions als Parameter von Hub-Methoden, als Rückgabewerte und als Stream-Elemente in `IAsyncEnumerable<T>`. Die Hub-Protokolle für MessagePack und Newtonsoft.Json tun das nicht. Blazor verarbeitet Unions in Komponentenparametern (im Prozess, ohne Serialisierung), in der JS-Interop und im persistierten Komponentenzustand über `PersistAsJson` / `TryTakeFromJson`.

## Wo das Binding aufhört

Routenwerte, Query Strings, Header und Formularfelder laufen nicht über STJ, deshalb werden Unions dort nicht unterstützt. Die Begründung im Blog: Ein einfacher String-Token bietet keinen verlässlichen Weg, einen Fall auszuwählen. `[SupplyParameterFromQuery]` in Blazor ist aus demselben Grund ausgenommen. Die Designdiskussion läuft in [dotnet/aspnetcore#66648](https://github.com/dotnet/aspnetcore/issues/66648).

Bis dahin binden Sie den rohen String und bauen die Union selbst:

```csharp
app.MapGet("/rollout", (string maxUnavailable) =>
    int.TryParse(maxUnavailable, out var count)
        ? new UnionIntString(count)
        : new UnionIntString(maxUnavailable));
```

Auf der Body-Seite gibt es noch eine Falle. `JsonSerializerOptions.Web` erlaubt das Lesen von Zahlen aus Strings. Ist `UnionIntString` ein Request-Body, passt der JSON-Token `"42"` daher sowohl zu `int` als auch zu `string`. Diese Union zurückzugeben ist unproblematisch, sie als Eingabe anzunehmen erfordert aber einen eigenen Classifier. SignalR hat dieses Problem nicht, weil `JsonHubProtocol` einen String-Token nicht als mögliche Zahl behandelt.

## Unions oder geschlossene Hierarchien

Der Beitrag behandelt auch `closed`-Klassenhierarchien mit `[JsonPolymorphic(InferClosedTypePolymorphism = true)]`, die einen `$type`-Diskriminator erzeugen, ohne jedes `[JsonDerivedType]` aufzulisten. Die Empfehlung ist hilfreich: Eine Union passt, wenn der JSON-Vertrag ohne Diskriminator auskommen muss oder die Fälle primitive Typen und fremde Typen sind. Eine geschlossene Hierarchie passt, wenn Sie eine neue API entwerfen, deren Fälle einen gemeinsamen Basistyp haben. Wer bereits auf .NET 11 RC 1 ist, kann beides in Bodys und Antworten ausprobieren. Aus Routen-Templates sollten Unions vorerst draußen bleiben.
