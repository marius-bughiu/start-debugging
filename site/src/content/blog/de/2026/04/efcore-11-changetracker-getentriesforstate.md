---
title: "EF Core 11 fügt GetEntriesForState hinzu, um DetectChanges zu überspringen"
description: "EF Core 11 Preview 3 führt ChangeTracker.GetEntriesForState ein, einen state-gefilterten Enumerator, der einen zusätzlichen DetectChanges-Pass in Hot Paths wie SaveChanges-Interceptors und Audit-Hooks vermeidet."
pubDate: 2026-04-16
tags:
  - "ef-core"
  - "dotnet-11"
  - "performance"
  - "csharp"
lang: "de"
translationOf: "2026/04/efcore-11-changetracker-getentriesforstate"
translatedBy: "claude"
translationDate: 2026-04-24
---

`ChangeTracker.Entries()` hat eine Eigenart, die jede App, die es in einem Hot Path verwendet, beißt: Es ruft implizit `DetectChanges()` auf, bevor es zurückkehrt. Für einen Audit-Interceptor oder einen pre-`SaveChanges`-Validator werden diese Kosten beim tatsächlichen Save erneut gezahlt, was den Scan über jede getrackte Entität verdoppelt. [EF Core 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) führt `GetEntriesForState` speziell ein, um diesen redundanten Pass zu entfernen.

## Die API-Form

Die neue Methode lebt auf `ChangeTracker` neben `Entries()` und akzeptiert vier Flags, eines pro `EntityState`-Wert, den der Scanner abläuft:

```csharp
IEnumerable<EntityEntry> GetEntriesForState(
    bool added,
    bool modified,
    bool deleted,
    bool unchanged);
```

Sie überspringt `DetectChanges` komplett und gibt Entries zurück, deren aktueller State bereits den angeforderten Flags entspricht. Sie verlieren die automatische Change Detection für den Aufruf, was genau der Tauschhandel ist, den Sie in Code wollen, der gleich darauf einen Save (und damit Detection) auslösen wird.

Das Feature wird als [dotnet/efcore #37847](https://github.com/dotnet/efcore/issues/37847) verfolgt und ist in den Preview-3-EF-Core-Bits ausgeliefert.

## Auditing ohne den Doppelscan

Ein typischer Audit-Interceptor zieht modifizierte und gelöschte Entries aus dem Tracker und schreibt sie in eine Audit-Tabelle. Mit `Entries()` erzwingt dieser Interceptor einen vollen Detection-Pass über potenziell Tausende Entities, und `SaveChanges` macht es danach nochmal:

```csharp
public override InterceptionResult<int> SavingChanges(
    DbContextEventData eventData,
    InterceptionResult<int> result)
{
    var context = eventData.Context!;

    // In EF Core 10: this call runs DetectChanges() even though
    // SaveChanges is about to run it again a moment later.
    foreach (var entry in context.ChangeTracker
        .GetEntriesForState(added: false, modified: true, deleted: true, unchanged: false))
    {
        WriteAudit(entry);
    }

    return result;
}
```

Weil `SaveChanges` immer seinen eigenen Detection-Pass ausführt, liest die Audit-Schleife jetzt den frisch berechneten State, ohne zweimal dafür zu zahlen.

## Wann darauf zurückgreifen

`GetEntriesForState` ist kein Drop-in-Ersatz für `Entries()`. Nutzen Sie es, wenn Sie bereits wissen, welche States zählen, und ein Detection-Pass ohnehin geplant ist. Gute Passungen:

- `SaveChangesInterceptor`-Implementierungen.
- Outbox Publisher, die innerhalb derselben Transaktion wie der Save laufen.
- Soft-Delete-Rewriter, die nur Entries in `Deleted` brauchen.
- Validatoren, die "leicht veraltete" Ergebnisse für Durchsatz akzeptieren.

Vermeiden Sie es für Code, der vor dem Save jede ausstehende Änderung sehen muss, zum Beispiel eine UI, die "Sie haben 3 ungespeicherte Edits" rendert. In dem Fall ist `Entries()` immer noch korrekt, weil sein Detection-Pass der ganze Zweck ist.

## Den Gewinn messen

Die Auswirkung wächst mit der Zahl getrackter Entities. Für einen Context, der 10.000 Entities mit komplexen Value Objects hält, läuft `Entries()` einen Per-Property-Scan, um zu entscheiden, ob sich etwas geändert hat. Ein Audit-Read von `Entries().Where(e => e.State != EntityState.Unchanged)` durch `GetEntriesForState(false, true, true, false)` zu ersetzen, schneidet einen vollen Pass, was typischerweise 10-30% der gesamten `SaveChanges`-Zeit in Audit-lastigen OLTP-Pfaden ausmacht.

Wie immer: messen. Wenn Ihr Context selten mehr als ein paar Dutzend Entities hält, ist die API immer noch netter, aber der Perf-Delta ist Rauschen. Die vollständige Liste der EF-Core-Änderungen in diesem Preview steht in den [EF Core 11 Preview 3 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).
