---
title: "C# 11 - file-Zugriffsmodifizierer und dateibezogene Typen"
description: "Erfahren Sie, wie der file-Modifizierer in C# 11 den Geltungsbereich eines Typs auf die Datei beschränkt, in der er deklariert wird, und so Namenskollisionen mit Source Generators vermeidet."
pubDate: 2023-03-18
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/03/c-11-file-access-modifier"
translatedBy: "claude"
translationDate: 2026-05-01
---
Der **file**-Modifizierer beschränkt Geltungsbereich und Sichtbarkeit eines Typs auf die Datei, in der er deklariert ist. Das ist besonders nützlich, wenn Sie Namenskollisionen zwischen Typen vermeiden möchten, etwa bei Typen, die mit Source Generators erzeugt werden.

Ein kurzes Beispiel:

```cs
file class MyLocalType { }
```

Bei den Einschränkungen gilt Folgendes:

-   Typen, die in einem dateibezogenen Typ verschachtelt sind, sind nur in der Datei sichtbar, in der sie deklariert wurden
-   andere Typen in der Assembly dürfen denselben vollqualifizierten Namen wie der dateibezogene Typ verwenden, ohne eine Namenskollision zu verursachen
-   datei-lokale Typen dürfen nicht als Rückgabetyp oder Parameter eines Members verwendet werden, der eine größere Sichtbarkeit als der `file`-Geltungsbereich hat
-   ebenso darf ein dateibezogener Typ kein Feld-Member eines Typs sein, der eine größere Sichtbarkeit als der `file`-Geltungsbereich hat

Andererseits:

-   Ein Typ mit größerer Sichtbarkeit kann eine dateibezogene Schnittstelle implizit implementieren
-   Ein Typ mit größerer Sichtbarkeit kann eine dateibezogene Schnittstelle auch explizit implementieren, mit der Bedingung, dass die expliziten Implementierungen nur innerhalb des Datei-Geltungsbereichs verwendet werden dürfen

## Eine dateibezogene Schnittstelle implizit implementieren

Eine public-Klasse kann eine dateibezogene Schnittstelle implementieren, solange beide in derselben Datei definiert sind. Im folgenden Beispiel sehen Sie die dateibezogene Schnittstelle `ICalculator`, implementiert von einer public-Klasse `Calculator`.

```cs
file interface ICalculator
{
    int Sum(int x, int y);
}

public class Calculator : ICalculator
{
    public int Sum(int x, int y) => x + y;
}
```
