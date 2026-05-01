---
title: ".NET 9: Das Ende von lock(object)"
description: ".NET 9 führt System.Threading.Lock ein, eine dedizierte, leichtgewichtige Synchronisationsprimitive, die lock(object) mit besserer Performance und klarerer Absicht ersetzt."
pubDate: 2026-01-02
tags:
  - "dotnet"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/net-9-the-end-of-lockobject"
translatedBy: "claude"
translationDate: 2026-05-01
---
Fast zwei Jahrzehnte lang verließen sich C#-Entwickler auf ein einfaches Muster zur Thread-Synchronisation: eine private `object`-Instanz erstellen und an die `lock`-Anweisung übergeben. Obwohl wirksam, bringt dieser Ansatz versteckte Performance-Kosten mit sich, die .NET 9 mit der Einführung von `System.Threading.Lock` endlich beseitigt.

## Die versteckten Kosten von `Monitor`

Wenn Sie `lock (myObj)` schreiben, übersetzt der Compiler dies in Aufrufe von `System.Threading.Monitor.Enter` und `Monitor.Exit`. Dieser Mechanismus stützt sich auf das Object Header Word, ein Stück Metadaten, das jedem Referenztyp auf dem verwalteten Heap angehängt ist.

Ein Standard-`object` zum Sperren zu verwenden zwingt die Laufzeit dazu:

1.  Ein Heap-Objekt nur zu Identitätszwecken zu allokieren.
2.  Den Object Header bei Contention aufzublähen, um Synchronisationsinformationen (den "Sync Block") aufzunehmen.
3.  Druck auf die Garbage Collection (GC) auszuüben, selbst wenn das Objekt die Klasse nie verlässt.

In Szenarien mit hohem Durchsatz summieren sich diese Mikro-Allokationen und Header-Manipulationen.

## Auftritt `System.Threading.Lock`

.NET 9 führt einen dedizierten Typ ein: `System.Threading.Lock`. Dies ist nicht nur ein Wrapper um `Monitor`; es handelt sich um eine leichtgewichtige Synchronisationsprimitive, die speziell für gegenseitigen Ausschluss entworfen wurde.

Wenn der C# 13-Compiler auf eine `lock`-Anweisung trifft, die auf eine Instanz von `System.Threading.Lock` zielt, generiert er anderen Code. Statt `Monitor.Enter` ruft er `Lock.EnterScope()` auf, was eine `Lock.Scope`-Struct zurückgibt. Diese Struct implementiert `IDisposable`, um den Lock freizugeben, und sorgt so für Thread-Sicherheit selbst bei Auftreten von Ausnahmen.

### Vorher vs. nachher

Hier der traditionelle Ansatz, den wir hinter uns lassen:

```cs
public class LegacyCache
{
    // The old way: allocating a heap object just for locking
    private readonly object _syncRoot = new();
    private int _count;

    public void Increment()
    {
        lock (_syncRoot) // Compiles to Monitor.Enter(_syncRoot)
        {
            _count++;
        }
    }
}
```

Und hier das moderne Muster in .NET 9:

```cs
using System.Threading;

public class ModernCache
{
    // The new way: a dedicated lock instance
    private readonly Lock _sync = new();
    private int _count;

    public void Increment()
    {
        // C# 13 recognizes this type and optimizes the IL
        lock (_sync) 
        {
            _count++;
        }
    }
}
```

## Warum das wichtig ist

Die Verbesserungen sind struktureller Natur:

1.  **Klarere Absicht**: Der Typname `Lock` macht den Zweck explizit, anders als ein generisches `object`.
2.  **Performance**: `System.Threading.Lock` umgeht den Overhead des Sync Blocks im Object Header. Es nutzt eine effizientere interne Implementierung, die CPU-Zyklen beim Erwerb und Freigeben des Locks reduziert.
3.  **Zukunftssicherheit**: Die Verwendung des dedizierten Typs erlaubt der Laufzeit, die Sperrmechanik weiter zu optimieren, ohne das Verhalten von `Monitor` zu brechen.

## Best Practices

Diese Funktion erfordert sowohl **.NET 9** als auch **C# 13**. Wenn Sie ein bestehendes Projekt aktualisieren, können Sie `private readonly object _lock = new();` mechanisch durch `private readonly Lock _lock = new();` ersetzen. Den Rest übernimmt der Compiler.

Geben Sie die `Lock`-Instanz nicht öffentlich preis. Genau wie beim alten `object`-Muster ist Kapselung der Schlüssel, um Deadlocks zu vermeiden, die durch externen Code entstehen, der Ihre internen Synchronisationsprimitiven sperrt.

Für Entwickler, die Hochnebenläufigkeitssysteme bauen, stellt diese kleine Änderung einen bedeutenden Fortschritt bei der Reduzierung des Laufzeit-Overheads dar.
