---
title: "C# 12 Alias für beliebige Typen"
description: "Die using-alias-Direktive wurde in C# 12 gelockert, sodass Alias für beliebige Typen vergeben werden können, nicht nur für benannte Typen. Damit lassen sich nun Tuples, Pointer, Array-Typen, generische Typen usw. mit Aliasen versehen. Statt der vollständigen strukturellen Form eines Tuples können Sie einen kurzen, aussagekräftigen Aliasnamen verwenden..."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/08/c-12-alias-any-type"
translatedBy: "claude"
translationDate: 2026-05-01
---
Die using-alias-Direktive wurde in C# 12 gelockert: Damit lassen sich Aliase für beliebige Typen vergeben, nicht nur für benannte Typen. Sie können nun also Tuples, Pointer, Array-Typen, generische Typen usw. aliasieren. Statt der vollständigen strukturellen Form eines Tuples nutzen Sie einen kurzen, aussagekräftigen Aliasnamen, den Sie überall verwenden können.

Ein kurzes Beispiel für das Aliasieren eines Tuples. Zuerst der Alias:

```cs
using Point = (int x, int y);
```

Dann verwenden Sie ihn wie jeden anderen Typ: als Rückgabetyp, in der Parameterliste einer Methode oder zum Erzeugen neuer Instanzen. Praktisch ohne Einschränkungen.

Ein Beispiel mit dem oben deklarierten Tuple-Alias:

```cs
Point Copy(Point source)
{
    return new Point(source.x, source.y);
}
```

Wie bisher gelten Typaliase nur in der Datei, in der sie definiert sind.

### Einschränkungen

Zumindest aktuell müssen Sie für alles, was kein primitiver Typ ist, den voll qualifizierten Typnamen angeben. Zum Beispiel:

```cs
using CarDictionary = System.Collections.Generic.Dictionary<string, ConsoleApp8.Car<System.Guid>>;
```

Höchstens den Namespace Ihrer App können Sie sich sparen, indem Sie den Alias innerhalb des Namespaces definieren.

```cs
namespace ConsoleApp8
{
    using CarDictionary = System.Collections.Generic.Dictionary<string, Car<System.Guid>>;
}
```

### Error CS8652

> The feature 'using type alias' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Dieser Fehler bedeutet, dass Ihr Projekt noch nicht auf C# 12 läuft und Sie die neuen Sprachfeatures somit nicht nutzen können. Wenn Sie auf C# 12 wechseln möchten und nicht wissen, wie, schauen Sie in [unseren Leitfaden zum Umstieg auf C# 12](/2023/06/how-to-switch-to-c-12/).
