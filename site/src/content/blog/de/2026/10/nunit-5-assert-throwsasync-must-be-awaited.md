---
title: "NUnit 5: Assert.ThrowsAsync gibt jetzt einen Task zurück, und ein nicht erwarteter Aufruf besteht stillschweigend"
description: "NUnit 5.0.0 macht Assert.ThrowsAsync, CatchAsync und DoesNotThrowAsync wirklich asynchron. Wer das await vergisst, führt die Prüfung nie aus. Hier steht, was kaputtgeht, was die Regel NUnit2059 aus NUnit.Analyzers abfängt und welche weiteren NUnit-5-Änderungen Sie vor dem Upgrade prüfen sollten."
pubDate: 2026-10-04
tags:
  - "nunit"
  - "testing"
  - "dotnet"
  - "csharp"
lang: "de"
translationOf: "2026/10/nunit-5-assert-throwsasync-must-be-awaited"
translatedBy: "claude"
translationDate: 2026-10-04
---

[NUnit 5.0.0](https://github.com/nunit/nunit/releases/tag/v5.0.0) ist am 27. September 2026 erschienen. Die Maintainer nennen es ein kleines Major-Release, und die meisten der [Breaking Changes](https://docs.nunit.org/articles/nunit/V5BreakingChanges.html) machen aus Laufzeitfehlern Compilerfehler. Eine Änderung geht in die andere Richtung: Bei einem unvorsichtigen Upgrade kann ein fehlschlagender Test plötzlich bestehen.

## ThrowsAsync hat früher blockiert, jetzt gibt es einen Task zurück

In NUnit 4 hatten `Assert.ThrowsAsync<T>`, `Assert.CatchAsync` und `Assert.DoesNotThrowAsync` zwar asynchrone Namen, führten den Delegate aber synchron aus, blockierten den aufrufenden Thread und gaben die Exception direkt zurück. [Issue #4384](https://github.com/nunit/nunit/issues/4384) hat das in 5.0.0 behoben: Alle drei geben jetzt einen `Task` zurück und müssen erwartet (awaited) werden.

```csharp
// NUnit 4.6.1
var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());

// NUnit 5.0.0
var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());
```

Die neue Form ist die richtige. Das Problem ist der Code, den Sie bereits haben.

## Das stille Bestehen

Alte Tests rufen `ThrowsAsync` aus einer einfachen `void`-Testmethode auf. In NUnit 5 lässt sich das weiterhin kompilieren: Der zurückgegebene `Task` wird verworfen, und weil die Methode nicht `async` ist, gibt der Compiler nicht einmal CS4014 aus. Ich habe das mit .NET SDK 10.0.302 und NUnit3TestAdapter 6.3.0 ausgeführt, wobei `DoesNotThrowAsync` nie eine Exception auslöst:

```csharp
static async Task DoesNotThrowAsync() => await Task.Delay(10);

[Test]
public void Unawaited()
{
    var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}

[Test]
public async Task Awaited()
{
    var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}
```

Die Ergebnisse:

| Setup | `Unawaited` | `Awaited` |
| --- | --- | --- |
| NUnit 4.6.1 | schlägt fehl (korrekt) | CS1061, `ArgumentException` hat kein `GetAwaiter` |
| NUnit 5.0.0, NUnit.Analyzers 4.13.0 | **besteht** | schlägt fehl (korrekt) |
| NUnit 5.0.0, NUnit.Analyzers 4.14.0 oder 4.15.0 | Build-Fehler NUnit2059 | schlägt fehl (korrekt) |

Die mittlere Zeile ist die gefährliche. Der Test, der eine fehlende `ArgumentException` aufdecken sollte, wird grün, und nichts in der Testausgabe deutet darauf hin, dass die Prüfung nie ausgeführt wurde.

## Die Migration dem Analyzer überlassen

[NUnit.Analyzers](https://www.nuget.org/packages/NUnit.Analyzers) 4.14.0 hat NUnit2059 hinzugefügt, "Method 'ThrowsAsync' returns a Task and is not being observed", standardmäßig als Fehler gemeldet. Die Code-Korrektur ergänzt das `await` und ändert die umgebende Methode in `async Task`. Die Reihenfolge beim Upgrade ist also wichtig:

```xml
<PackageReference Include="NUnit" Version="5.0.0" />
<PackageReference Include="NUnit.Analyzers" Version="4.15.0" />
<PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />
```

Aktualisieren Sie den Analyzer im selben Commit wie das Framework. Wenn Ihre Projekte NUnit.Analyzers zentral in `Directory.Packages.props` auf einer älteren Version festlegen oder das Paket entfernt wurde, bleibt der Build grün, und Sie landen in der Zeile mit dem stillen Bestehen.

## Die weiteren NUnit-5-Änderungen, die ein grep wert sind

- `TestDelegate`, `AsyncTestDelegate` und `ActualValueDelegate<T>` sind entfernt. Lambdas sind nicht betroffen; explizite Verwendungen werden zu `Action`, `Func<Task>` und `Func<T>`.
- `[Platform("NET")]` und `"DotNET"` bedeuten jetzt modernes .NET, nicht .NET Framework. Verwenden Sie den neuen Bezeichner `"NETFramework"`, wenn Sie das meinten, sonst laufen Tests unbemerkt auf der falschen Laufzeit (oder gar nicht mehr).
- `Is.SameAs` akzeptiert nur Referenztypen, und `Has.Attribute<T>()` verlangt `T : Attribute`. Beides waren zuvor Laufzeitfehler.
- `StringAssert`, `CollectionAssert`, `FileAssert` und `DirectoryAssert` wandern zurück nach `NUnit.Framework`.
- Das Framework zielt auf `net462`, `net8.0` und `net10.0`. Das Ziel `net6.0` entfällt.
- `[Order]` ist jetzt `[Obsolete]`. Als Ersatz dienen die neuen Attribute `[DependsOnTest]` und `[DependsOnFixture]`, die einen Test überspringen, wenn seine Abhängigkeit fehlschlägt.

Wenn Sie entscheiden, ob NUnit für ein neues Projekt noch das richtige Framework ist: Mein [Vergleich von xUnit v3, NUnit und MSTest](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) wurde mit NUnit 4.6.1 gemessen. Die Zahlen dort stammen aus der Zeit vor 5.0.0, doch die Empfehlung hängt von nichts ab, was dieses Release geändert hat.
