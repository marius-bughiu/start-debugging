---
title: "C# 16 macht aus unsafe einen Vertrag für den Aufrufer"
description: "C# 16 gestaltet das Schlüsselwort unsafe neu, sodass es eine Verpflichtung an den Aufrufer weitergibt, statt stillschweigend einen unsafe-Kontext zu öffnen, und innere unsafe-Blöcke sind nun verpflichtend."
pubDate: 2026-05-22
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "memory-safety"
lang: "de"
translationOf: "2026/05/csharp-16-unsafe-keyword-caller-contract"
translatedBy: "claude"
translationDate: 2026-05-22
---

Richard Lander [stellte eine Neugestaltung](https://devblogs.microsoft.com/dotnet/improving-csharp-memory-safety/) des Schlüsselworts `unsafe` vor, die nach 25 Jahren dessen Bedeutung verändert. Heute markiert `unsafe` ein Implementierungsdetail: Sie schalten eine Methode oder einen Block in einen unsafe-Kontext, schreiben Ihren Zeiger-Code, und niemand, der diese Methode aufruft, ahnt, dass er speicherunsicheren Code berührt. Das neue Modell, das auf **C# 16** als Vorschau in **.NET 11** und Produktion in **.NET 12** abzielt, macht aus `unsafe` einen an den Aufrufer gerichteten Vertrag. Die Motivation ist teils der Aufstieg von KI-generiertem Code: Eine Sicherheitsverpflichtung, die nur als Konvention existiert, ist für Prüfende und für das Modell, das den Code schreibt, unsichtbar.

## Was das Schlüsselwort jetzt bedeutet

Nach den aktuellen Regeln erledigt das Markieren einer Methode als `unsafe` zwei voneinander unabhängige Aufgaben gleichzeitig: Es erlaubt Ihnen, darin Zeigeroperationen zu schreiben, und verlangt nichts von den Aufrufern. Die Neugestaltung trennt diese beiden.

`unsafe` in einer Mitgliedssignatur wird zu einem Vertrag, der sich weitergibt. Aufrufer müssen den Aufruf in einen `unsafe { }`-Block einschließen, genauso wie Sie die Dereferenzierung eines `pointer` einschließen müssen. Und innerhalb einer `unsafe`-Methode benötigen die unsafe-Operationen selbst weiterhin einen expliziten inneren Block. Keinen Freifahrtschein mehr:

```csharp
/// <safety>
/// The sum of <paramref name="ptr"/> and <paramref name="ofs"/> must address
/// a byte the caller is permitted to read.
/// </safety>
public static unsafe byte ReadByte(IntPtr ptr, int ofs)
{
    // SAFETY: relies on caller obligation.
    unsafe { return ((byte*)ptr)[ofs]; }
}
```

Der Dokumentationsblock `/// <safety>` ist der formale Ort, um die Verpflichtung festzuhalten, und ein Analyzer kennzeichnet `unsafe`-Mitglieder, denen er fehlt.

## Die Verpflichtung erfüllen

Eine Methode, die eine `unsafe`-API aufruft, hat zwei Möglichkeiten: weiterhin propagieren, indem sie selbst `unsafe` ist, oder zu einer sicheren Grenze werden, indem sie die Vorbedingung validiert und den Aufruf dann einschließt.

```csharp
void Caller2()
{
    if (!ObligationSatisfied()) throw new InvalidOperationException();
    unsafe { ReadByte(ptr, ofs); } // the guard discharges the contract
}
```

Genau das ist der Punkt: Der `unsafe`-Block ist die Stelle, an der Sie versichern "Ich habe die Vorbedingung geprüft", daher sollte er klein und bewusst sein und nicht eine ganze Methode umschließen.

## Kleinere Oberfläche, strengerer Standard

Einige weitere Regeln verschärfen das Modell. Der Typmodifizierer `unsafe` entfällt, sodass die unsafe-Eigenschaft nur noch bei Methoden, Eigenschaften und Feldern lebt. Zeigertypen machen eine Signatur nicht mehr von sich aus unsafe; das Übergeben eines `byte*` ist in Ordnung, das Dereferenzieren ist der unsafe-Akt. Und `extern`-Deklarationen erhalten einen neuen `safe`-Modifizierer, um zu bezeugen, dass ein P/Invoke sicher aufzurufen ist:

```csharp
[LibraryImport("libc")]
internal static safe partial int getpid();
```

Auch die Projektkonfiguration teilt sich auf. Die bestehende Eigenschaft `<AllowUnsafeBlocks>` steuert weiterhin, ob das Schlüsselwort `unsafe` überhaupt kompiliert, während eine neue Opt-in-Eigenschaft das C#-16-Modell dessen auswählt, was als unsafe zählt. Lassen Sie beide weg, erhalten Sie die strengste Haltung.

Nichts davon macht Zeiger-Code von selbst sicher. Wie Lander es formuliert, sind die Schlüsselwörter "nicht die Sicherheit; sie sind das Gerüst, das Entwickler dazu bringt, sie zu artikulieren und einzuhalten". Wenn Sie eine Bibliothek mit zeigerlastigen kritischen Pfaden pflegen, ist die Vorschau der Zeitpunkt, um mit dem Schreiben von `<safety>`-Blöcken zu beginnen, denn in .NET 12 sind es Ihre Aufrufer, die gezwungen sein werden, Ihre APIs einzuschließen.
