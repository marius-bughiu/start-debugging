---
title: "Was ist Transparent Struct Layout, und warum ändert ein Wrapper-Struct mit einem einzigen Feld die Aufrufkonvention in .NET?"
description: "Ein transparentes Struct wird von der ABI exakt wie sein einziges Feld behandelt. .NET 11 bietet diese Garantie nicht: Ein Struct, das ein double kapselt, wird unter Windows x64 in RCX übergeben, unter Linux und macOS aber in XMM0. Hier sind das Disassembly des .NET-11-JIT für drei ABIs, die daraus entstehenden P/Invoke-Fehler und wie Sie Wrapper-Typen schreiben, die an jeder Grenze sicher sind."
pubDate: 2026-10-10
tags:
  - "dotnet-11"
  - "csharp"
  - "interop"
  - "jit"
  - "performance"
lang: "de"
translationOf: "2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-10
---

Kurze Antwort: "Transparent Layout" ist die Garantie, dass ein Struct mit genau einem Feld *und bei Aufrufen übergeben* exakt wie dieses Feld behandelt wird. Rust schreibt dafür `#[repr(transparent)]`. .NET 11 hat das nicht. Ein C#-Struct wie `readonly record struct Meters(double Value)` hat dasselbe 8-Byte-Speicherlayout wie ein `double`, doch an einer Aufrufgrenze klassifiziert der JIT es als Aggregat, und jede Plattform-ABI entscheidet selbst, wie Aggregate übertragen werden. Unter Linux x64, macOS x64 und jedem ARM64-Ziel reist der Wrapper weiterhin in einem Gleitkommaregister, Sie bemerken also nichts. Unter Windows x64 landet er in `RCX`, einem Integer-Register, und wird in `RAX` statt in `XMM0` zurückgegeben. Das kostet im verwalteten Code ein paar Register-Moves und verfälscht stillschweigend Werte, wenn Sie den Wrapper in einer P/Invoke-Signatur verwenden, deren native Seite ein einfaches `double` erwartet.

Alles Folgende wurde mit .NET 11 RC1 (Laufzeit 11.0.0-rc.1.26425.128, SDK 11.0.100-rc.1.26425.128) und C# 15 ausgeführt. Das verwaltete Disassembly für Windows x64 und Linux x64 stammt vom RC1-Cross-Compiler `crossgen2` mit `JitDisasm`, die macOS-Listings stammen aus der nativen Ausführung der App auf arm64 und unter Rosetta auf x64, und die nativen Listings stammen von Apple clang 21 für die jeweilige ABI.

## Speicherlayout und Aufrufkonvention sind zwei verschiedene Verträge

Wenn man sagt, ein Struct mit einem Feld sei "kostenlos", meint man meist das Speicherlayout. Das stimmt. `Meters` belegt 8 Byte, auf 8 ausgerichtet, genau wie `double`. `Unsafe.SizeOf<Meters>()` liefert 8, ein Array aus `Meters` ist bitkompatibel mit einem Array aus `double`, und `MemoryMarshal.Cast<Meters, double>` funktioniert.

Die Aufrufkonvention ist ein eigener Vertrag. Sie beantwortet: Wenn dieser Wert ein Argument oder ein Rückgabewert ist, welches Register oder welcher Stack-Slot hält ihn? Eine ABI trifft diese Entscheidung, indem sie den Typ *klassifiziert*, und die meisten ABIs fragen zuerst "Skalar oder Aggregat?" und schauen erst danach hinein. Ein Struct ist ein Aggregat, auch wenn es nur ein Feld hat. Ob die ABI anschließend zum `double` darin durchschaut, hängt vollständig von der Plattform ab:

- **System V AMD64 (Linux x64, macOS x64)** zerlegt Aggregate in Eightbytes und klassifiziert jedes nach den enthaltenen Feldern. Ein `double`-Feld bedeutet, dass das Eightbyte zur Klasse SSE gehört, das Struct landet also in `XMM0`, genau wie ein einzelnes `double`.
- **AAPCS64 (Linux, macOS und Windows auf ARM64)** kennt die Regel für homogene Gleitkomma-Aggregate (HFA): Ein Struct aus einem bis vier Feldern desselben Gleitkommatyps wird in aufeinanderfolgenden SIMD-Registern übergeben. Ein `double` ist ein HFA der Größe eins, also geht es in `D0`, genau wie ein einzelnes `double`.
- **Windows x64** schaut gar nicht hinein. Die [Dokumentation zur x64-Aufrufkonvention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention) sagt, dass Structs der Größe 8, 16, 32 oder 64 Bit "are passed as if they were integers of the same size." Ein Struct mit einem `double` hat 64 Bit, also geht es in `RCX`. Bei Rückgaben kommt ein benutzerdefinierter Typ passender Größe in `RAX` zurück, während float und double in `XMM0` zurückkommen.

Der .NET-JIT folgt der Plattform-ABI bei Aufrufen zwischen verwaltetem Code, nicht nur bei P/Invoke. Das ist also keine reine Interop-Kuriosität. Es tritt in gewöhnlichem C#-Code auf.

## Die native ABI, direkt vom Compiler

Hier ist die kleinste C-Datei, die den Unterschied sichtbar macht. Kompiliert man sie mit `clang -O2 -S` für drei Ziele, sieht man, was jede ABI erwartet:

```c
// abi.c, Apple clang 21, -O2
typedef struct { double value; } Meters;
typedef struct { float x, y; } Vec2;

double take_double(double d) { return d * 2.0; }
double take_meters(Meters m) { return m.value * 2.0; }
Meters ret_meters(double d) { Meters m = { d }; return m; }
float  take_vec2(Vec2 v) { return v.x + v.y; }
float  take_two_floats(float x, float y) { return x + y; }
```

Für `x86_64-pc-windows-msvc`:

```asm
; Windows x64
take_double:
    addsd   %xmm0, %xmm0      ; double arrives in xmm0
    retq
take_meters:
    movq    %rcx, %xmm0       ; Meters arrives in rcx, moved to xmm0 first
    addsd   %xmm0, %xmm0
    retq
ret_meters:
    movq    %xmm0, %rax       ; Meters is returned in rax, not xmm0
    retq
```

Für `x86_64-apple-macos` (System V) und `arm64-apple-macos` (AAPCS64) wird `take_meters` zu exakt denselben Anweisungen kompiliert wie `take_double` (jeweils `addsd %xmm0, %xmm0` und `fadd d0, d0, d0`), und `ret_meters` wird zu einem bloßen `ret`, weil der Wert bereits im Rückgaberegister liegt.

Der Wrapper ist also auf zwei von drei ABIs nur durch Zufall ihrer Klassifizierungsregeln transparent und unter Windows x64 undurchsichtig.

## Was der .NET-11-JIT für ein Wrapper-Struct erzeugt

Nun die verwaltete Seite. Zwei Methoden, identisch bis auf den Wrapper:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.CompilerServices;

public readonly record struct Meters(double Value);

static class Managed
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static double ScaleDouble(double d) => d * 2.0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Meters ScaleMeters(Meters m) => new(m.Value * 2.0);
}
```

Unter Linux x64 (crossgen2 `--targetos:linux --targetarch:x64`) werden beide Methoden zu denselben 5 Byte kompiliert:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, linux-x64
       vaddsd   xmm0, xmm0, xmm0
       ret
; Total bytes of code 5
```

Unter macOS arm64, nativ mit `DOTNET_JitDisasm` ausgeführt, sind beide gleich 20 Byte groß, mit `fadd d0, d0, d0` als einziger echter Arbeit.

Unter Windows x64 (crossgen2 `--targetos:windows --targetarch:x64`) bleibt `ScaleDouble` bei 5 Byte, aber `ScaleMeters` wird zu:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, win-x64
       vmovq    xmm0, rcx          ; argument arrives in an integer register
       vaddsd   xmm0, xmm0, xmm0
       vmovq    rax, xmm0          ; result leaves in an integer register
       ret
; Total bytes of code 15
```

Zwei zusätzliche Moves zwischen den Registerdomänen pro Aufruf, dreifache Codegröße. Innerhalb des Methodenrumpfs befördert der JIT das Struct zu seinem einzigen Feld und arbeitet mit einem einfachen `double`-Register; die Kosten entstehen allein an der Grenze. Wird der Aufruf inline eingebettet, verschwindet die Grenze und mit ihr die Kosten. Deshalb spielt der Aufwand praktisch selten eine Rolle und zeigt sich nur auf heißen, nicht inline eingebetteten Pfaden: virtuelle Aufrufe, Interface-Dispatch, Delegates, `NoInlining`-Methoden oder Methoden, die zu groß zum Inlining sind.

Das Kapseln eines Integers oder einer Referenz hat auf keiner dieser ABIs dieses Problem. Ein `readonly record struct UserId(int Value)` reist unter Windows x64 in `ECX`, unter System V in `EDI` und unter ARM64 in `W0`, genau wie ein einzelnes `int`. Ein Struct, das eine Objektreferenz kapselt, reist wie ein Zeiger. Die Abweichung betrifft gezielt Gleitkommafelder (und, wie unten gezeigt, Structs mit mehreren Feldern), weil nur Gleitkommawerte eine eigene Registerdatei haben, die die ABI überspringen kann.

## Der eigentliche Fehler: Wrapper-Typen in P/Invoke-Signaturen

Der Leistungsunterschied ist eine Fußnote. Der Korrektheitsunterschied nicht. Wenn Sie einen stark typisierten Wrapper in einer `LibraryImport`- oder `DllImport`-Signatur verwenden, deren natives Gegenstück den zugrunde liegenden Primitivtyp nimmt, behaupten Sie, der Wrapper sei transparent. Der Marshaller prüft das nicht, weil das Struct blittable ist und unverändert übergeben wird.

Hier ein Repro gegen die obige `abi.c`-Bibliothek:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.ProcessArchitecture} / {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"take_double(Meters 21)  = {Native.TakeDoubleAsMeters(new Meters(21)).Value}");
Console.WriteLine($"take_two_floats(Vec2)   = {Native.TakeTwoFloatsAsVec2(new Vec2(1f, 2f))}");
Console.WriteLine($"take_two_floats(f, f)   = {Native.TakeTwoFloats(1f, 2f)}");

public readonly record struct Meters(double Value);
public readonly record struct Vec2(float X, float Y);

static partial class Native
{
    // Wrong on purpose: the C side is double take_double(double)
    [LibraryImport("libabi", EntryPoint = "take_double")]
    public static partial Meters TakeDoubleAsMeters(Meters m);

    // Wrong on purpose: the C side is float take_two_floats(float, float)
    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloatsAsVec2(Vec2 v);

    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloats(float x, float y);
}
```

Auf macOS arm64:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 3
take_two_floats(f, f)   = 3
```

Alles "funktioniert". `Meters` ist ein HFA aus einem `double`, `Vec2` ist ein HFA aus zwei `float`, und AAPCS64 legt sie in `D0` bzw. `S0`/`S1`, genau dort, wo der native Code nachsieht.

Auf macOS x64 (System V), dieselbe Binärdatei, dieselbe Bibliothek:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 1
take_two_floats(f, f)   = 3
```

`Meters` funktioniert weiterhin, weil ein einzelnes SSE-Eightbyte in `XMM0` geht. `Vec2` nicht: System V packt beide floats in ein Eightbyte, sodass das ganze Struct in den unteren 64 Bit von `XMM0` ankommt. Die native Funktion liest `x` aus `XMM0` und `y` aus `XMM1`, wo noch irgendetwas steht. In diesem Lauf war es zufällig null, deshalb lautete die Antwort `1`. In einem anderen Lauf kann es alles Mögliche sein.

Unter Windows x64 brechen beide falschen Deklarationen. `Meters` geht in `RCX`, während `take_double` aus `XMM0` liest, und das Ergebnis wird aus `RAX` gelesen, während der native Code `XMM0` geschrieben hat. `Vec2` (8 Byte) geht ebenfalls in `RCX`. Die native Seite lässt sich am obigen Listing für `x86_64-pc-windows-msvc` bestätigen; die verwaltete Seite folgt derselben Regel, die das `ScaleMeters`-Disassembly zeigt.

Das ist der klassische Fehler "läuft auf meinem Mac, Müll auf dem Windows-Build-Agent". Auf ARM64-Laptops geprüfter und getesteter Code besteht, und der erste Lauf unter Windows x64 liefert Unsinn oder einen subtil falschen Wert.

## So schreiben Sie Wrapper-Typen, die an jeder Grenze sicher sind

In .NET 11 gibt es kein Attribut, das ein Struct transparent macht. `[StructLayout(LayoutKind.Sequential)]`, `Pack` und `Size` steuern alle das Speicherlayout, nicht die Registerklassifizierung. Die Lösung besteht also darin, Wrapper auf der verwalteten Seite der Grenze zu halten.

1. **Deklarieren Sie native Signaturen mit den exakten nativen Typen.** Wenn C ein `double` nimmt, nimmt auch das P/Invoke ein `double`. Kapseln und entkapseln Sie in einer dünnen verwalteten Methode:

    ```csharp
    // .NET 11 RC1, C# 15
    static partial class Native
    {
        [LibraryImport("libabi", EntryPoint = "take_double")]
        private static partial double TakeDouble(double d);

        public static Meters Scale(Meters m) => new(TakeDouble(m.Value));
    }
    ```

    Die Wrapper-Methode wird inline eingebettet, die Typsicherheit kostet Sie also nichts.

2. **Verwenden Sie ein Struct in einem P/Invoke nur dann, wenn die native Seite ein Struct mit denselben Feldern verwendet.** Wenn der C-Header `Vec2 v` sagt, ist ein C#-`Vec2` mit denselben Feldern in derselben Reihenfolge auf jeder ABI korrekt, weil beide Seiten dieselbe Klassifizierung anwenden. Der Fehler entsteht immer nur dann, wenn auf einer Seite ein Struct und auf der anderen lose Skalare stehen.

3. **Behandeln Sie Funktionszeiger und `UnmanagedCallersOnly` genauso.** Ein `delegate* unmanaged<Meters, Meters>` hat dasselbe Problem wie ein `LibraryImport`, und ebenso ein `[UnmanagedCallersOnly]`-Export, den ein nativer Host mit einem `double` aufruft. Wenn Sie Node-Addons oder Plugin-Hosts auf diese Weise bauen, wie in [Node.js-Addons mit .NET Native AOT schreiben](/de/2026/04/nodejs-addons-dotnet-native-aot/), halten Sie die exportierten Signaturen primitiv.

4. **Prüfen Sie bei heißen verwalteten Pfaden unter Windows x64 zuerst, ob der Aufruf inline eingebettet wird.** Wenn ein Profiler auf eine nicht inline eingebettete Methode zeigt, die einen Gleitkomma-Wrapper annimmt oder zurückgibt, sehen Sie sich das Disassembly an. Riders [ASM-Viewer für JIT- und Native-AOT-Disassembly](/de/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) oder `DOTNET_JitDisasm` zeigt das `vmovq`-Paar. Anschließend können Sie den Primitivtyp über die heiße Grenze reichen oder den Code so umstrukturieren, dass der Aufruf inline eingebettet wird.

## Stolperfallen und Sonderfälle

- **Zwei floats sind kein double.** Viele nehmen an, 8 Byte seien 8 Byte. `Vec2(float, float)` hat 8 Byte, ist aber unter System V ein SSE-Eightbyte, unter ARM64 ein HFA aus zwei Feldern und unter Windows x64 ein Blob in Integer-Größe. Drei ABIs, drei Antworten. Dieser Fall trifft plattformübergreifenden Spiele- und Grafikcode am häufigsten.
- **Gemischte Felder ändern die Klassifizierung erneut.** Ein `struct { int Id; float Weight; }` hat 8 Byte. Unter System V wird es zu einem Eightbyte der Klasse INTEGER (Integer gewinnt, wenn ein Eightbyte Klassen mischt) und geht in `RDI`. Unter ARM64 ist es kein HFA, also geht es in `X0`. Unter Windows x64 in `RCX`. Nichts davon entspricht der getrennten Übergabe eines `int` und eines `float`.
- **Die Größe zählt unter Windows x64.** Nur Structs mit 1, 2, 4 und 8 Byte werden per Wert in einem Register übergeben. Ein 12-Byte- oder 16-Byte-Struct wird per Referenz auf eine vom Aufrufer angelegte Kopie übergeben, was eine viel größere Änderung gegenüber der Übergabe der einzelnen Felder ist. Unter System V und ARM64 gehen Structs bis 16 Byte weiterhin in Registern.
- **Instanzmethoden von C++-Klassen sind wieder anders.** MSVC gibt benutzerdefinierte Typen aus nicht statischen Memberfunktionen über einen versteckten Zeiger zurück, selbst wenn sie in `RAX` passen würden. Deshalb gibt es `CallConvMemberFunction` in `System.Runtime.CompilerServices`, und deshalb sind COM-Methoden, die kleine Structs zurückgeben, eine bekannte Falle.
- **Struct Promotion verbirgt die Kosten, sie beseitigt sie nicht.** Innerhalb einer Methode ersetzt der JIT ein promotetes Struct durch sein Feld, lokale Arithmetik auf `Meters` ist also so schnell wie auf `double`. Die Promotion ändert nicht, wie der Wert einen Aufruf überquert. Wenn Sie Structs und Klassen für Value Objects abwägen, behandelt die [Entscheidungsmatrix Record vs. Class vs. Struct](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) die Seite von Größe und Kopieren dieses Abwägens.
- **ReadyToRun und Native AOT folgen denselben Regeln.** Vorkompilierter Code muss weiterhin mit der Plattform-ABI übereinstimmen, daher macht auch die Veröffentlichung mit [Native AOT oder ReadyToRun](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) einen Wrapper nicht transparent. Die crossgen2-Ausgabe in diesem Beitrag ist ReadyToRun-Code.

## Bekommt .NET ein echtes Transparent Layout?

Nicht in .NET 11. Das Nächstliegende auf der Roadmap ist der [Vorschlag zum Interop-Struct-Layout in dotnet/runtime#100896](https://github.com/dotnet/runtime/issues/100896), der ein `CustomLayoutAttribute` mit Layoutarten für C-artige Structs, Unions und Swift-Typen genehmigt hat. Das Issue erwähnt ausdrücklich Wünsche nach einem Mechanismus wie Rusts `repr(transparent)`, doch die genehmigte Form enthält keinen, und das Issue wurde im Juli 2026 vom Meilenstein 11.0.0 auf 12.0.0 verschoben. Falls je eine transparente Variante erscheint, könnten JIT und Marshaller einen Wrapper mit einem Feld auf jeder ABI als sein Feld klassifizieren, genau das, was [Rusts RFC 1758](https://rust-lang.github.io/rfcs/1758-repr-transparent.html) für dessen Newtypes leistet.

Bis dahin ist die Regel kurz: Wrapper sind im Speicher kostenlos und nach dem Inlining kostenlos, aber an einer ABI-Grenze sind sie Aggregate, und nur die Plattform entscheidet, ob das eine Rolle spielt. Halten Sie sie aus nativen Signaturen heraus, und wenn Sie sie unter Windows x64 über einen heißen, nicht inline eingebetteten Aufruf reichen müssen, lesen Sie zuerst das Disassembly.

## Verwandte Beiträge

- [Record vs. Class vs. Struct in C#: eine Entscheidungsmatrix](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), um überhaupt erst die Form eines Werttyps zu wählen.
- [Der ASM-Viewer von Rider 2026.1 für JIT- und Native-AOT-Disassembly](/de/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/), der einfachste Weg, das `vmovq`-Paar selbst zu sehen.
- [Native AOT vs. ReadyToRun vs. JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) dazu, wie sich die drei Codegenerierungsmodi unterscheiden und wo nicht.
- [Polars.NET und LibraryImport](/de/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) für eine echte Rust-basierte Bibliothek, die diese Signaturen richtig hinbekommen muss.
- [Node.js-Addons mit .NET Native AOT](/de/2026/04/nodejs-addons-dotnet-native-aot/), wo `UnmanagedCallersOnly`-Exporte in umgekehrter Richtung derselben Regel unterliegen.

## Quellen

- [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention), Microsoft-C++-Dokumentation, für die Windows-x64-Regeln zu Aggregaten und Rückgabewerten.
- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI), Abschnitt 3.2.3, für die Eightbyte-Klassifizierung.
- [Procedure Call Standard for the Arm 64-bit Architecture (AAPCS64)](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst), für die HFA-Regel.
- [dotnet/runtime#100896: New attribute for interop-specific struct concerns](https://github.com/dotnet/runtime/issues/100896).
- [dotnet/runtime#43867: Keep structs in registers](https://github.com/dotnet/runtime/issues/43867), das JIT-Tracking-Issue für die Behandlung von Structs mit einem Feld.
- [Rust RFC 1758: repr(transparent)](https://rust-lang.github.io/rfcs/1758-repr-transparent.html).
