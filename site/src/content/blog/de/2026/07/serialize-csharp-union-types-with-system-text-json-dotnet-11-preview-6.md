---
title: "System.Text.Json lernt in .NET 11 Preview 6, C#-Union-Typen zu serialisieren"
description: "Wie System.Text.Json in .NET 11 Preview 6 die neuen C#-Union-Typen serialisiert, indem der aktive Fall geschrieben wird, und die APIs JsonUnionAttribute und Typklassifizierer, die mehrdeutige Fälle auflösen."
pubDate: 2026-07-21
tags:
  - "csharp"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "de"
translationOf: "2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-21
---

C#-Union-Typen waren die herausragende Funktion der .NET-11-Vorschauversionen, endeten aber bislang an der Compilergrenze. Ab [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) (9. Juli 2026) versteht `System.Text.Json` sie nativ: Sie können eine Union serialisieren und deserialisieren, ohne einen eigenen `JsonConverter` zu schreiben. In Preview 6 fügten sich zwei weitere Teile ein, sodass das Ganze endlich ohne Boilerplate funktioniert: Die Unterstützungstypen `System.Runtime.CompilerServices.UnionAttribute` und `IUnion` sind nun im Framework enthalten, sodass eine Union in einem schlichten `net11.0`-Projekt kompiliert.

## Den aktiven Fall schreiben, keinen Wrapper

Eine Union deklariert, dass ein Wert genau einer aus einer festen Menge von Falltypen ist. Die Kurzform generiert ein Struct, das den jeweils aktiven Fall enthält:

```csharp
public union Pet(Cat, Dog, Bird);

public record Cat(string Name);
public record Dog(string Name);
public record Bird(string Name);
```

`System.Text.Json` erkennt dies über eine neue Vertragsart, `JsonTypeInfoKind.Union`. Wenn Sie eine Union serialisieren, liest der Serializer den aktiven Fall und schreibt *dessen* Wert direkt, ohne eine Hülle darum herum:

```csharp
Pet pet = new Dog("Rex");
string json = JsonSerializer.Serialize(pet);
// {"Name":"Rex"}
```

Bei einer Union aus primitiven Typen bedeutet das: Eine Union aus `int` und `string` durchläuft sauber den Hin- und Rückweg, weil die JSON-Token strukturell verschieden sind:

```csharp
Pet-like union of (int, string):
"hello"   // the string case
42        // the int case
```

Sowohl der reflexionsbasierte Serializer als auch der Source Generator unterstützen dies, sodass Sie den AOT-freundlichen Weg nicht verlassen müssen, um es zu nutzen.

## Die Diskriminator-Lücke und wie man sie schließt

Den rohen Wert zu schreiben ist elegant, aber beachten Sie, was bei `Pet` passiert: Sowohl `Dog("Rex")` als auch `Cat("Rex")` werden zu `{"Name":"Rex"}` serialisiert. Auf dem Rückweg kann der Serializer nicht erkennen, welcher Fall das war. Das ist das klassische Problem markierter Unions, und Preview 6 gibt Ihnen die Werkzeuge, um es zu lösen, statt zu raten.

Drei neue APIs steuern, wie Fälle gefunden und benannt werden: `JsonUnionAttribute`, `JsonUnionCaseInfo` sowie das Typklassifizierer-Paar `JsonTypeClassifier` und `JsonSerializerOptions.TypeClassifiers`. Zusammen erlauben sie es, dem erzeugten JSON einen Typdiskriminator anzuhängen, damit mehrdeutige objektförmige Fälle wieder zum richtigen Falltyp deserialisiert werden. Strukturell verschiedene Fälle (wie `int` gegenüber `string`) brauchen davon nichts; die Zeremonie greift nur, wenn die Nutzdaten sonst kollidieren würden.

Wenn Sie die [Berichterstattung zu Union-Typen seit Preview 2](/de/2026/04/csharp-15-union-types-dotnet-11-preview-2/) verfolgt haben, ist dies das Teil, das sie über eine HTTP-Grenze hinweg nutzbar macht. Unions standen und fielen immer mit der Serialisierungsunterstützung, und in Preview 6 hören sie auf, eine Compilerkuriosität zu sein, und werden zu etwas, das Sie über die Leitung schicken können.

Alle Details finden sich in den [Bibliotheks-Release-Notes zu Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/libraries.md).
