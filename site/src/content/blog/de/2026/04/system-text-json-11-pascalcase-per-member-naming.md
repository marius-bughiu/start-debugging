---
title: "System.Text.Json in .NET 11 Preview 3 fügt PascalCase und Per-Member-Naming-Policies hinzu"
description: ".NET 11 Preview 3 schließt die Naming-Policy-Geschichte in System.Text.Json ab: JsonNamingPolicy.PascalCase, ein Member-Level-Attribut [JsonNamingPolicy] und ein Type-Level-Default [JsonIgnore] für sauberere DTOs."
pubDate: 2026-04-18
tags:
  - ".NET 11"
  - "System.Text.Json"
  - "C#"
  - "Serialization"
lang: "de"
translationOf: "2026/04/system-text-json-11-pascalcase-per-member-naming"
translatedBy: "claude"
translationDate: 2026-04-24
---

[.NET 8 hat](https://startdebugging.net/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/) die erste Charge eingebauter Naming Policies für `System.Text.Json` eingeführt: camel, snake und kebab in beiden Casings. Preview 3 von .NET 11 schließt die letzte offensichtliche Lücke und fügt zwei weitere Stellschrauben hinzu, die handgeschriebene `JsonConverter`s für die meisten DTO-Formen überflüssig machen. Die Arbeit wurde via [dotnet/runtime #124644](https://github.com/dotnet/runtime/pull/124644), [#124645](https://github.com/dotnet/runtime/pull/124645) und [#124646](https://github.com/dotnet/runtime/pull/124646) ausgeliefert.

## PascalCase tritt den eingebauten Policies bei

`JsonNamingPolicy.PascalCase` ist neu in Preview 3 und sitzt neben den bestehenden `CamelCase`, `SnakeCaseLower`, `SnakeCaseUpper`, `KebabCaseLower` und `KebabCaseUpper`. Es ist die Policy, die Sie wollen, wenn die .NET-Seite bereits PascalCase-Properties verwendet und der JSON-Vertrag ebenfalls PascalCase ist - verbreitet bei Azure-Management-APIs, älteren SOAP-zu-REST-Gateways und einigen Microsoft-Graph-Shapes:

```csharp
using System.Text.Json;

var options = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.PascalCase
};

var json = JsonSerializer.Serialize(
    new { firstName = "Ada", age = 37 },
    options);
// {"FirstName":"Ada","Age":37}
```

Vor Preview 3 ließen Sie entweder den Default (keine Policy) oder schrieben eine einzeilige Custom-Subklasse von `JsonNamingPolicy`. Jetzt passt es zu den anderen Presets und macht sauberen Round-Trip mit dem bestehenden `JsonKnownNamingPolicy`-Enum.

## Naming auf einem einzelnen Member überschreiben

Die interessantere Änderung ist, dass `[JsonNamingPolicy]` jetzt ein Member-Level-Attribut ist. Zuvor lebte die Policy auf `JsonSerializerOptions` und galt für den ganzen Graphen, also bedeutete eine PascalCase-Ausnahme in einem ansonsten camelCase-Vertrag entweder einen `[JsonPropertyName]`-Override auf jeder unhandlichen Property oder eine komplett custom Policy. In .NET 11 Preview 3 können Sie Policies innerhalb desselben Typs mischen:

```csharp
using System.Text.Json.Serialization;

public sealed class Webhook
{
    public string Url { get; set; } = "";

    [JsonNamingPolicy(JsonKnownNamingPolicy.KebabCaseLower)]
    public string RetryStrategy { get; set; } = "exponential";

    [JsonNamingPolicy(JsonKnownNamingPolicy.SnakeCaseLower)]
    public int MaxAttempts { get; set; } = 5;
}
```

Mit `PropertyNamingPolicy = JsonNamingPolicy.CamelCase` serialisiert `Url` zu `url`, `RetryStrategy` zu `retry-strategy` und `MaxAttempts` zu `max_attempts`. Das entfernt viel `[JsonPropertyName]`-Rauschen pro Property, wenn ein einzelnes externes System inkonsistent ist.

## Type-Level [JsonIgnore]-Defaults

Die Begleitänderung ist, dass `[JsonIgnore(Condition = ...)]` jetzt auf dem Typ selbst erlaubt ist, nicht nur auf Properties ([dotnet/runtime #124646](https://github.com/dotnet/runtime/pull/124646)). Setzen Sie es auf die Klasse, und die Condition wird zum Default für jede Property innerhalb des Typs:

```csharp
using System.Text.Json.Serialization;

[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
public sealed class PatchRequest
{
    public string? Name { get; set; }
    public string? Email { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public bool? IsActive { get; set; }
}
```

Jede nullable Property auf `PatchRequest` fällt jetzt aus dem Payload, wenn sie null ist, was genau das ist, was eine JSON-Merge-Patch-Request-Shape will. Der `IsActive`-Override tritt wieder ein, weil ein explizites `false` dort bedeutungsvoll ist. Das gleiche Muster erforderte früher `JsonIgnoreCondition.WhenWritingNull` auf jeder Property einzeln oder `DefaultIgnoreCondition` auf den Serializer-Optionen, was dann jedes andere DTO durch die gleiche Regel zwang.

## Warum die kleine Oberfläche zählt

Attribut-Level-Kontrolle ist das, was es Teams erlaubt, Custom Converters durch Standard-`System.Text.Json` zu ersetzen. PascalCase entfernt den letzten "Schreib deine eigene Policy"-Grund, Per-Member-Naming löscht eine Klasse von `[JsonPropertyName]`-Boilerplate, und Type-Level-`[JsonIgnore]` lässt PATCH- und Event-DTOs ihren Default an einer Stelle konfigurieren. Alle drei Änderungen funktionieren auch mit dem Source Generator, also bekommen Native-AOT-Apps sie ohne zusätzliche Konfiguration. Die [Preview-3-Libraries-Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/libraries.md) verfolgen den Rest der `System.Text.Json`-Updates, die diesen Monat ausgeliefert werden.
