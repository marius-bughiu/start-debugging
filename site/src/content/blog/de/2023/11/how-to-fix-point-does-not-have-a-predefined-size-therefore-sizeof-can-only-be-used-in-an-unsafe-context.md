---
title: "Behebung des Fehlers: 'Point' hat keine vordefinierte Größe, daher kann sizeof nur in einem unsafe-Kontext verwendet werden"
description: "Beheben Sie den C#-Fehler, bei dem sizeof außerhalb eines unsafe-Kontexts nicht mit Point verwendet werden kann. Zwei Lösungen: unsafe-Code aktivieren oder Marshal.SizeOf verwenden."
pubDate: 2023-11-09
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/11/how-to-fix-point-does-not-have-a-predefined-size-therefore-sizeof-can-only-be-used-in-an-unsafe-context"
translatedBy: "claude"
translationDate: 2026-05-01
---
Der Fehler tritt auf, weil `sizeof` in C# nur mit Typen verwendet werden kann, deren Größe zur Kompilierzeit bekannt ist. Die `Point`-Struktur gehört nicht dazu, es sei denn, Sie befinden sich in einem unsafe-Kontext.

Es gibt zwei Wege, das Problem zu lösen.

## `unsafe`-Code verwenden

Damit lässt sich der `sizeof`-Operator für Typen jeder Größe verwenden. Dazu müssen Sie Ihre Methode mit dem Schlüsselwort `unsafe` markieren und unsafe-Code in den Build-Einstellungen Ihres Projekts aktivieren.

Im Wesentlichen ändert sich Ihre Methodensignatur zu Folgendem:

```cs
public static unsafe void YourMethod()
{
    // ... your unsafe code
    // IntPtr sizeOfPoint = (IntPtr)sizeof(Point);
}
```

Um unsafe-Code zuzulassen, öffnen Sie die Projekteigenschaften, wechseln Sie zum Tab `Build` und aktivieren Sie die Option "Allow unsafe code". Danach sollte der Kompilierungsfehler verschwunden sein.

## `Marshal.SizeOf` verwenden

`Marshal.SizeOf` ist sicher und benötigt keinen unsafe-Kontext. Die Methode `SizeOf` gibt die unverwaltete Größe eines Objekts in Bytes zurück.

Sie müssen lediglich `sizeof(Point)` durch `Marshal.SizeOf(typeof(Point))` ersetzen. So:

```cs
IntPtr sizeOfPoint = (IntPtr)Marshal.SizeOf(typeof(Point));
```

`Marshal.SizeOf` gehört zum Namespace `System.Runtime.InteropServices`. Stellen Sie also sicher, dass Sie die entsprechende using-Direktive am Anfang Ihrer Datei haben:

```cs
using System.Runtime.InteropServices;
```

Beachten Sie, dass `Marshal.SizeOf` einen sehr leichten Leistungsnachteil gegenüber dem unsafe-`sizeof` hat. Das sollten Sie bei der Wahl der für Ihre Anforderungen am besten geeigneten Lösung berücksichtigen.
