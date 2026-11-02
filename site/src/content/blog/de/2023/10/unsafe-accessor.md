---
title: "C# UnsafeAccessor: private Member ohne Reflection (.NET 8)"
description: "Mit UnsafeAccessor in .NET 8 auf bekannte private Konstruktoren, Methoden, Eigenschaften und Felder zugreifen: geprüfte Beispiele und Versionsgrenzen."
pubDate: 2023-10-31
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
`UnsafeAccessorAttribute` wurde mit .NET 8 eingeführt. Eine `static extern`-Methode kann damit an einen bekannten, nicht zugänglichen Member gebunden werden; die Laufzeit stellt die Implementierung bereit. Der Ansatz eignet sich, wenn deklarierender Typ und Signatur zur Kompilierzeit bekannt sind. Er ersetzt keine Reflection zur Suche während der Laufzeit.

**Korrektur — 2. November 2026:** Der ursprüngliche Artikel schloss Überladungen fälschlich aus und verlangte für statischen Zugriff eine Instanz. Beides ist unten korrigiert. Das wiederhergestellte Beispiel wurde auf .NET 8.0.33 ausgeführt. Leistung wird separat behandelt und nicht pauschal als ohne Overhead beschrieben.

## Vollständiges Beispiel herunterladen

[Lauffähigen Quellcode als ZIP herunterladen](/examples/unsafe-accessor.zip) oder die [Beispielanleitung öffnen](/examples/#unsafe-accessor). Enthalten sind Projekt, deklarierende Typen, Imports und Prüfungen für alle folgenden Zugriffsmuster.

```sh
dotnet run -c Release
```

Das Programm prüft erwartete Werte und beendet sich bei Abweichungen mit einem Fehler. Bei Erfolg erscheint:

```text
PASS: constructors, instance/static members, field access, readonly accessor observation
```

## Private Konstruktoren und Überladungen

In einer Hilfsklasse sind gewöhnliche C#-Methodenüberladungen erlaubt. Ein Konstruktor-Accessor gibt den deklarierenden Typ zurück und übernimmt die Parameter des Zielkonstruktors:

```cs
using System.Runtime.CompilerServices;

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();

    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
}
```

Diese Deklarationen binden an `Foo()` und `Foo(string)`. Der vollständige Typ `Foo` steht im ZIP. Für lokale Funktionen in Top-Level-Code gelten andere C#-Namensregeln als für Methoden einer Hilfsklasse; das ist keine Einschränkung von `UnsafeAccessor`.

## Instanzmethoden und Eigenschaften

Der erste Parameter bestimmt den deklarierenden Typ und übergibt die Instanz. Die übrigen Parameter- und Rückgabetypen müssen zum Ziel passen. Eigenschaften werden über ihre Zugriffsmethoden angesprochen:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
internal static extern string CallInstance(Foo instance, int value);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
internal static extern string GetProperty(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
internal static extern void SetProperty(Foo instance, string value);
```

Das Beispiel prüft das Ergebnis der privaten Methode, liest den anfänglichen Eigenschaftswert, schreibt ihn und liest erneut. Bei Instanzmembern eines Structs muss der erste Parameter mit `ref` übergeben werden.

## Statische Member

Verwende `StaticMethod` oder `StaticField`. Der erste Parameter bestimmt weiterhin den deklarierenden Typ, sein **Wert wird jedoch nicht verwendet** und darf null sein:

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
internal static extern string CallStatic(Foo? typeMarker, int value);

var result = Accessors.CallStatic(null, 42);
```

Der deklarierende Typ ist hier keine statische Klasse. C# erlaubt statische Klassen nicht als Parametertyp; daraus folgt also nicht, dass sich jede API einer statischen Klasse mit diesem .NET-8-Muster erreichen lässt.

## Felder

Ein Feld-Accessor gibt eine Referenz zurück. Das Beispiel liest und schreibt sowohl Instanz- als auch statische Felder:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
internal static extern ref int InstanceField(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
internal static extern ref int StaticField(Foo? typeMarker);
```

Den Sonderfall schreibgeschützter Felder behandelt das [Readonly-Beispiel](/de/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/). Eine Feldreferenz macht beliebige Änderungen unveränderlichen Zustands nicht zu einem unterstützten Entwurf.

## Grenzen und Leistung

Gesucht wird nur im angegebenen deklarierenden Typ; die Laufzeit durchläuft nicht dessen Vererbungshierarchie. Fehlende Feld- oder Methodenbindungen lösen bei Verwendung Fehler aus. Falsche Signaturen und Constraints können weitere Bindungsfehler verursachen. Unterstützung für generische Parameter kam mit .NET 9 hinzu; generische Beispiele brauchen deshalb eine eigene Versionsprüfung.

Ein Accessor kann Reflection-Suche und die Argumentverarbeitung von `Invoke` vermeiden. Die Zieloperation und der erzeugte Code bleiben jedoch relevant. Der [wiederhergestellte Benchmark](/de/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) enthält direkten Zugriff, gecachte Reflection und einen gecachten Delegaten mit beobachtbarer Arbeit.

Quelle: [Microsofts Referenz zu UnsafeAccessorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute).
