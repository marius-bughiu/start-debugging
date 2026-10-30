---
title: "ref-T-Schleife vs. Span<T>-Indizierung in C#: warum die Span-Variante in .NET 10 gleich schnell oder schneller ist"
description: "In .NET 10 wird eine einfache for-Schleife über span[i], begrenzt durch span.Length, zu einer Schleife ohne Bounds Check, mit Strength Reduction und abwärts zählendem Zähler kompiliert. Eine handgeschriebene Unsafe.Add(ref r, i)-Schleife mit int-Index behält eine Vorzeichenerweiterung und einen aufwärts zählenden Vergleich und war in der Messung 2 bis 5 % langsamer. Benchmarks und JIT-Disassembly für arm64 und x64 auf .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "span"
  - "jit"
lang: "de"
translationOf: "2026/10/ref-t-loop-vs-span-t-indexing-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-30
---

Schreiben Sie die Schleife in .NET 10 als `for (int i = 0; i < span.Length; i++) sum += span[i];` und belassen Sie es dabei. Der JIT beweist, dass jeder Index im gültigen Bereich liegt, entfernt den Bounds Check, schreibt den Index in einen Byte-Offset um, der pro Durchlauf um 4 erhöht wird (Strength Reduction), und macht aus der Schleife einen Abwärtszähler, der mit einem einzigen `dec`/`jne` endet (auf Arm64 `sub`/`cbnz`). Die "schnellere" handgeschriebene Variante, `sum += Unsafe.Add(ref r, i)` mit einem `int`-Index, erhält diese Behandlung nicht. Sie behält den `int`-Zähler, erweitert ihn in jedem Durchlauf vorzeichenrichtig zu einem Offset in nativer Größe und vergleicht am Schleifenende mit der Länge. In meinen Messungen auf .NET 10.0.10 war die `Unsafe.Add`-Schleife dadurch **bei 4.096 Elementen 2,4 % langsamer und bei 1.000.000 Elementen 3,6 % langsamer** als die sichere Span-Schleife. Ein `nint`-Zähler in der `ref`-Schleife schließt die Lücke vollständig, und ein `ref`-Durchlauf mit Zeigerinkrement gleicht die Span-Schleife aus. `ref T`-Code kann die Span-Schleife in .NET 10 also höchstens einholen. Er gewinnt nie, und er gibt dafür die Speichersicherheit auf.

Alles Folgende wurde mit BenchmarkDotNet 0.15.8 auf .NET 10.0.10 (SDK 10.0.302), C# 14, auf einem Apple M4 unter macOS 27.0.1 gemessen. Die Arm64-Listings sind der echte Tier1-Code aus diesem Lauf, aufgezeichnet mit `DOTNET_JitDisasm`. Die x64-Listings stammen von crossgen2 10.0.10 mit Ziel `win-x64`, das denselben RyuJIT mit vollen Optimierungen ausführt, aber ohne Dynamic PGO. Die Schleifenoptimierungen, die das Ergebnis erklären, wurden in [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) eingeführt, daher gilt alles hier auch für .NET 9.

## Der Vergleich im Überblick

| Schleifenform | Bounds Check in der Schleife | Indexrechnung pro Durchlauf | 4.096 ints | 1.000.000 ints |
| --- | --- | --- | ---: | ---: |
| `for` über `array[i]` | Entfernt | Offset mit Strength Reduction, abwärts zählend | 1.035,6 ns | 251,9 us |
| `for` über `span[i]`, Grenze `span.Length` | Entfernt | Offset mit Strength Reduction, abwärts zählend | 1.035,9 ns | 254,4 us |
| `foreach (ref readonly int x in span)` | Entfernt | Wie oben | 1.035,6 ns | 254,5 us |
| `for` über `span[i]`, Grenze ist ein Parameter `n` | Per Loop Cloning herausgezogen | Wie oben im schnellen Klon | 1.035,4 ns | 254,5 us |
| `Unsafe.Add(ref r, i)`, `int i` | Keiner (gab es nie) | Vorzeichenerweiterung + aufwärts zählender Vergleich | 1.060,1 ns | 263,7 us |
| `Unsafe.Add(ref r, i)`, `nint i` | Keiner | Strength Reduction, abwärts zählend | 1.036,1 ns | 254,7 us |
| `ref`-Durchlauf mit `Unsafe.IsAddressLessThan` | Keiner | Zeiger mit Post-Inkrement | 1.035,3 ns | 251,4 us |
| `Enumerable.Sum(int[])` | n/a | Vektorisiert | 506,9 ns | 128,6 us |

Jede Schleife summiert ein `int[]`. Die Fehlerbalken liegen bei 4.096 Elementen durchweg unter 1,5 ns und bei einer Million unter 0,8 us. Ich habe die Span- und `ref`-Zeilen in einer zweiten, separaten BenchmarkDotNet-Sitzung erneut gemessen, und jeder Mittelwert lag innerhalb von 0,6 ns (4.096) beziehungsweise 0,1 us (eine Million) des ersten Laufs. Die letzte Zeile dient der Einordnung: Die schnellste skalare Schleife erreicht nur die halbe Geschwindigkeit einer vektorisierten.

## Die beiden Schleifen, die tatsächlich verglichen werden

Die Frage entsteht meist, nachdem jemand BCL-Quellcode gelesen hat, überall `ref T` und `Unsafe.Add` sieht und eine heiße Schleife entsprechend umschreibt. Hier sind die beiden Formen nebeneinander:

```csharp
// .NET 10.0.10, C# 14
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

static int SpanFor(ReadOnlySpan<int> s)
{
    int sum = 0;
    for (int i = 0; i < s.Length; i++) sum += s[i];
    return sum;
}

static int RefAdd(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (int i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

Die Überlegung hinter `RefAdd` lautet: `s[i]` hat einen Bounds Check, `Unsafe.Add` nicht, also muss die `ref`-Variante schneller sein. In .NET Core 2.1 stimmte das oft. Seitdem hat der JIT gelernt, den Bounds Check genau aus dieser Schleifenform zu entfernen, und in .NET 9 kamen drei weitere Tricks hinzu, die nur greifen, wenn er die Indexvariable vollständig versteht. Die Span-Schleife bekommt alle drei. Die `Unsafe.Add`-Schleife fällt aus dem Muster.

## Was der JIT mit der Span-Schleife macht

Hier ist der Tier1-Arm64-Code für `SpanFor`, direkt aus `DOTNET_JitDisasm` auf .NET 10.0.10:

```asm
; Kernels:SpanFor(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
            mov     w2, wzr            ; sum = 0
            cmp     w1, #0             ; length <= 0 ?
            ble     G_M000_IG05
            mov     x3, xzr            ; byte offset = 0
G_M000_IG04:
            ldr     w4, [x0, x3]       ; load s[i]
            add     w2, w4, w2         ; sum += ...
            add     x3, x3, #4         ; offset += 4
            sub     w1, w1, #1         ; remaining--
            cbnz    w1, G_M000_IG04    ; loop while remaining != 0
```

In dieser Schleife sind drei getrennte Optimierungen sichtbar:

1. **Entfernung des Bounds Check.** Es gibt keinen Vergleich mit der Länge und keinen Aufruf von `CORINFO_HELP_RNGCHKFAIL`. Da `i` bei 0 beginnt, nur hochzählt und durch `i < s.Length` abgesichert ist, beweist die Bereichsanalyse des JIT, dass `s[i]` immer gültig ist. Das ist der bekannte Teil, und er funktioniert für Spans seit .NET Core 2.1.
2. **Strength Reduction.** Der Quelltext multipliziert `i` mit 4, um eine Adresse zu erhalten. Die Schleife führt stattdessen einen Byte-Offset in `x3` und addiert 4. Die Laufzeithinweise zu .NET 9 beschreiben das als "automatische" Umwandlung des indizierten Zugriffs in diese Form.
3. **Zählrichtung der Schleife.** Das ursprüngliche `i` ist verschwunden. Sobald die Adresse nicht mehr von `i` abhängt, steuert der Zähler nur noch die Anzahl der Durchläufe. Der JIT zählt die Länge daher auf null herunter und beendet die Schleife mit `cbnz` statt mit einem separaten Vergleich und Sprung.

Auf x64 kompiliert dieselbe Methode zu vier Instruktionen im Schleifenkörper:

```asm
; Kernels:SpanFor, crossgen2 10.0.10, win-x64, full opts
G_M000_IG04:
       add      edx, dword ptr [rax+r8]
       add      r8, 4
       dec      ecx
       jne      SHORT G_M000_IG04
```

Enger kann eine skalare Summenschleife kaum werden. Es bleibt keine Instruktion übrig, die eine `ref`-Umschreibung entfernen könnte.

## Was der JIT mit der `Unsafe.Add`-Schleife macht

Nun `RefAdd`, gleiche Maschine, gleicher Lauf:

```asm
; Kernels:RefAdd(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
G_M000_IG03:
            ldr     w4, [x0, w3, SXTW #2]   ; load r[(nint)i * 4]
            add     w2, w4, w2
            add     w3, w3, #1              ; i++
            cmp     w3, w1                  ; i < length ?
            blt     G_M000_IG03
```

```asm
; Kernels:RefAdd, crossgen2 10.0.10, win-x64, full opts
G_M000_IG05:
       movsxd   r8, ecx                     ; sign-extend i to 64 bits
       add      esi, dword ptr [rax+4*r8]
       inc      ecx
       cmp      ecx, edx
       jl       SHORT G_M000_IG05
```

Die Schleife hat keinen Bounds Check, aber die Span-Schleife hatte ebenfalls keinen, das bringt also nichts. Verloren gegangen sind die Strength Reduction und das Abwärtszählen. `Unsafe.Add<T>(ref T source, int elementOffset)` wandelt den `int`-Offset vor der Skalierung in eine native Ganzzahl um. Diese Vorzeichenerweiterung sitzt zwischen der Induktionsvariablen und der Adresse, und der JIT schreibt nicht durch sie hindurch um. Die Schleife behält deshalb `i` als 32-Bit-Zähler, leitet die Adresse in jedem Durchlauf neu daraus ab (`SXTW #2` auf Arm64, ein explizites `movsxd` auf x64) und braucht am Ende einen echten Vergleich mit der Länge.

Auf Arm64 ist die Vorzeichenerweiterung in den Adressierungsmodus des Ladebefehls eingefaltet, sodass die Instruktionsanzahl der Span-Schleife entspricht. Sie war trotzdem messbar langsamer, durchgängig in beiden Läufen. Der sichtbare Unterschied liegt im Schleifenausgang: ein expliziter `cmp` des erhöhten Zählers mit der Länge statt des verschmolzenen `cbnz` des Abwärtszählers. Ich habe nicht unterhalb der Instruktionsebene profiliert, daher ist das die wahrscheinliche, aber keine bewiesene Ursache. Auf x64 gibt es schlicht eine zusätzliche Instruktion pro Element. Beide Unterschiede sind klein, und genau das ist der Punkt: Die handgeschriebene Variante kostet Sicherheit und verliert trotzdem einige Prozent.

## Die `ref`-Schleife korrigieren, falls Sie wirklich eine brauchen

Es gibt zwei Wege, eine `ref`-Schleife zu schreiben, die der Span-Schleife entspricht. Der erste macht den Index nativ groß, sodass nichts vorzeichenerweitert werden muss:

```csharp
// .NET 10.0.10, C# 14
static int RefAddNint(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (nint i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

Der Arm64-Tier1-Code dafür ist Instruktion für Instruktion identisch mit `SpanFor` (`ldr w4, [x0, x3]`, `add x3, x3, #4`, `sub x1, x1, #1`, `cbnz`), und er erreichte im Benchmark 1.036,1 ns gegenüber 1.035,7 ns bei der Span-Schleife. Die x64-Ausgabe von crossgen2 hat ebenfalls denselben Schleifenkörper mit vier Instruktionen.

Der zweite ist der Durchlauf mit Zeigerinkrement, den viele ältere Hochleistungsprogramme verwenden:

```csharp
// .NET 10.0.10, C# 14
static int RefWalk(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int p = ref MemoryMarshal.GetReference(s);
    ref int end = ref Unsafe.Add(ref p, s.Length);
    while (Unsafe.IsAddressLessThan(ref p, ref end))
    {
        sum += p;
        p = ref Unsafe.Add(ref p, 1);
    }
    return sum;
}
```

Auf Arm64 verwendet diese Variante die Post-Indexed-Adressierung (`ldr w3, [x0], #0x04`, laden und weiterrücken in einer Instruktion), sodass der Schleifenkörper vier statt fünf Instruktionen hat. Sie war bei einer Million Elementen die schnellste Zeile, um etwa 1 %, was innerhalb des Rauschens zwischen zwei verschiedenen Maschinen liegt. Das ist der beste Fall für handgeschriebenen `ref`-Code in .NET 10: ein Gleichstand von 1 %, im Tausch gegen Code, in dem ein Off-by-one-Fehler ohne Ausnahme Speicher außerhalb des Spans liest oder schreibt. Außerdem ist `end` eine verwaltete Referenz, die ein Element hinter dem Ende des Puffers liegt. Die [Best Practices für unsicheren Code](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) raten davon ab, ungültige verwaltete Zeiger zu erzeugen, selbst wenn sie nie dereferenziert werden, und überlassen die genauen Gültigkeitsregeln ECMA-335. Für 1 % Gewinn ist das keine Ecke, in der man stehen möchte.

Wenn Sie `foreach (ref readonly int x in span)` schreiben, weil Sie gehört haben, das sei die "ref-Schleife", kompiliert das zum selben Code wie die indizierte Span-Schleife. Der C#-Compiler senkt ein `foreach` über einen Span zu einem indizierten `for` über den Span ab, sodass der JIT dieselbe Form sieht.

## Wo die Span-Schleife ihren Vorteil verliert

Die Span-Schleife ist schnell, weil der JIT Dinge über sie beweisen kann. Wird der Beweis gebrochen, ändert die Schleife ihre Form. Am häufigsten geschieht das, wenn die Schleife durch etwas anderes als `span.Length` begrenzt wird:

```csharp
// .NET 10.0.10, C# 14
static int SpanForN(ReadOnlySpan<int> s, int n)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += s[i];   // n is not s.Length
    return sum;
}
```

Jetzt kann `s[i]` tatsächlich außerhalb des Bereichs liegen. Der Tier1-JIT begegnet dem mit **Loop Cloning**: Er erzeugt vor der Schleife eine Prüfung `n <= s.Length`, einen schnellen Klon ohne Bounds Check für den Fall, dass sie gilt, und einen langsamen Klon, der in jedem Durchlauf prüft und beim ersten ungültigen Index eine `IndexOutOfRangeException` auslöst. Der schnelle Klon in meinem Arm64-Listing ist identisch mit `SpanFor`, weshalb die Benchmark-Zeile gleichauf liegt. Die crossgen2-x64-Ausgabe für dieselbe Methode hat nicht geklont und ein `cmp`/`jae` in der Schleife behalten. Läuft eine solche Methode also aus ReadyToRun-Code, bevor das Tiering sie ersetzt, zahlt sie die Prüfung. Die Lösung besteht darin, dem JIT den Beweis selbst zu liefern: `s = s[..n];` vor der Schleife, dann bis `s.Length` laufen. Der Slice führt vorab eine Bounds-Prüfung aus, und jeder Durchlauf danach ist kostenlos.

Derselbe Trick ist wichtig, wenn zwei Spans beteiligt sind:

```csharp
// .NET 10.0.10, C# 14
static void CopyX2(ReadOnlySpan<int> src, Span<int> dst)
{
    dst = dst[..src.Length];                    // one check here...
    for (int i = 0; i < src.Length; i++)
        dst[i] = src[i] * 2;                    // ...none in the loop
}
```

Ohne den Slice wird `dst[i]` nicht von der Absicherung `i < src.Length` abgedeckt. Tier1 hat auch diese Schleife geklont (ein `cmp w1, w3` / `bgt` vor dem Eintritt wählt die geprüfte oder die ungeprüfte Kopie), daher lagen alle drei Varianten (ohne Slice, mit Slice und eine `Unsafe.Add`-Version mit manueller Längenprüfung) bei 4.096 Elementen innerhalb von 1 % voneinander. Bei 64 Elementen war die `Unsafe.Add`-Version mit ihrer vorgezogenen `ArgumentException`-Prüfung die langsamste der drei, mit 20,1 ns gegenüber 16,8 ns für die Span-Schleife mit Slice. Der Slice bleibt dennoch die Variante der Wahl, weil er nicht von Cloning-Heuristiken abhängt und ausdrückt, was die Methode voraussetzt.

Wenn Sie die Prüfungen selbst ansehen möchten: Der frühere Beitrag zur [Bounds-Check-Elimination bei Index-from-End-Zugriff in .NET 11](/de/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) zeigt, wie man `CORINFO_HELP_RNGCHKFAIL` in einem Listing liest, und der [ASM-Viewer von Rider](/de/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) zeigt denselben Code ohne Umgebungsvariablen.

## So überprüfen Sie das im eigenen Code

Die Hinweise von Microsoft selbst in den [Best Practices für unsicheren Code](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) sind eindeutig: Die Vorteile des unsicheren Entfernens von Bounds Checks seien "often transient". Prüfen Sie also, ob der aktuelle JIT es noch braucht, und schreiben Sie den Code in sicherer Form um, falls nicht. Zwei Befehle genügen für die Prüfung:

```bash
# .NET 10 SDK, any OS
DOTNET_JitDisasm="SpanFor RefAdd" DOTNET_JitStdOutFile=jit.txt dotnet run -c Release
dotnet run -c Release -- --filter '*SpanFor*' '*RefAdd*'   # BenchmarkDotNet
```

Dinge, die Sie dabei in die Irre führen können:

- **Tier0-Code.** Das erste ausgegebene Listing einer Methode ist unoptimierter Tier0-Code, in dem `s[i]` ein echter Aufruf mit echter Prüfung ist. Suchen Sie das mit `Tier1` markierte Listing. Der Beitrag zur [Funktionsweise der Tiered Compilation](/de/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) erklärt, wann welche Stufe läuft und was OSR mit lang laufenden Schleifen macht.
- **ReadyToRun- und crossgen2-Listings.** Vorkompilierter Code hat kein PGO und kann Aufrufe behalten, die Tier1 inlinet. Meine x64-Listings rufen `MemoryMarshal.GetReference` ausgelagert auf, höchstwahrscheinlich weil crossgen2 nicht über die Version Bubble hinweg in `System.Private.CoreLib` inlinet. Die Schleifenkörper sind weiterhin repräsentativ, der Prolog nicht.
- **Mikrobenchmarks, die die Schleife verbergen.** Markieren Sie den Kernel mit `[MethodImpl(MethodImplOptions.NoInlining)]`, damit der JIT ihn als eigene Methode kompiliert, und lesen Sie das Listing dieser Methode, nicht das des Benchmark-Wrappers.
- **Falsche Vergleichsbasis.** Wenn das eigentliche Ziel der Durchsatz ist, vergleichen Sie mit einer vektorisierten Version. `Enumerable.Sum` auf einem `int[]` lief hier doppelt so schnell wie jede skalare Schleife, und `Vector<T>` oder `TensorPrimitives` führen für eigene Operationen dorthin.

## Die Wahl zwischen beiden

Verwenden Sie als Standard die indizierte Span-Schleife (oder Array-Schleife), begrenzt durch `.Length`. Sie ist sicher, der Schleifenoptimierer des JIT ist darauf abgestimmt, und in .NET 10 ist sie in keiner dieser Messungen langsamer als die `ref`-Alternativen. Ist die Grenze etwas anderes, slicen Sie zuerst, damit die Grenze zu `.Length` wird.

Greifen Sie zu `ref T` und `Unsafe.Add` nur, wenn Sie ein Listing haben, das einen Bounds Check zeigt, den der JIT nicht entfernen kann, und einen Benchmark, der zeigt, dass die Prüfung ins Gewicht fällt. Verwenden Sie dann einen `nint`-Index oder einen Zeigerdurchlauf, keinen `int`-Index, sonst verlieren Sie die Strength Reduction, die die Span-Schleife kostenlos erhielt. Wenn Sie `ref`- und Slicing-Entscheidungen für eine ganze API treffen, behandelt [`List<T>` vs. `Span<T>` vs. `ReadOnlySpan<T>`](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/), welchen Typ Sie überhaupt akzeptieren sollten. [Was `Span<T>` ist und wann es Code schneller macht](/de/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) behandelt die beiden anderen Stellen, an denen sich Spans tatsächlich lohnen, und [zwei Collections ohne Allokationen im Gleichschritt durchlaufen](/de/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/) wendet das Muster "slicen, um Grenzen zu beweisen" auf eine Schleife mit zwei Eingaben an.

## Quellen

- [What's new in the .NET 9 runtime: loop optimizations](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) (induction variable widening, post-indexed addressing, strength reduction, loop counter direction)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime) (improved loop inversion, which loop cloning and induction variable optimizations depend on)
- [Unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) (section 9, unsafe bounds check removal; section 4, invalid managed pointers)
- [`Unsafe` class API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe)
- [BenchmarkDotNet](https://benchmarkdotnet.org/)
