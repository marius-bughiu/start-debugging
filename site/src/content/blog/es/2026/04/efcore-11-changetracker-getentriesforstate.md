---
title: "EF Core 11 agrega GetEntriesForState para saltarse DetectChanges"
description: "EF Core 11 Preview 3 introduce ChangeTracker.GetEntriesForState, un enumerador filtrado por state que evita un pase extra de DetectChanges en hot paths como interceptors de SaveChanges y hooks de audit."
pubDate: 2026-04-16
tags:
  - "ef-core"
  - "dotnet-11"
  - "performance"
  - "csharp"
lang: "es"
translationOf: "2026/04/efcore-11-changetracker-getentriesforstate"
translatedBy: "claude"
translationDate: 2026-04-24
---

`ChangeTracker.Entries()` tiene una particularidad que muerde a toda app que lo usa en un hot path: implícitamente llama a `DetectChanges()` antes de devolver. Para un audit interceptor o un validador pre-`SaveChanges`, ese costo se paga otra vez en el save real, duplicando el scan sobre cada entidad trackeada. [EF Core 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) introduce `GetEntriesForState` específicamente para eliminar ese pase redundante.

## La forma del API

El nuevo método vive en `ChangeTracker` al lado de `Entries()` y acepta cuatro flags, uno por cada valor de `EntityState` que el scanner recorre:

```csharp
IEnumerable<EntityEntry> GetEntriesForState(
    bool added,
    bool modified,
    bool deleted,
    bool unchanged);
```

Se salta `DetectChanges` completamente y devuelve entries cuyo state actual ya matchea las flags pedidas. Pierdes detección automática de cambios para la llamada, que es exactamente el trade que quieres en código que está a punto de disparar un save (y por lo tanto detección) unas líneas más tarde.

La feature se trackea como [dotnet/efcore #37847](https://github.com/dotnet/efcore/issues/37847) y salió con los bits de EF Core en Preview 3.

## Auditing sin el doble scan

Un audit interceptor típico saca entries modificados y eliminados del tracker y los escribe a una tabla de audit. Con `Entries()`, ese interceptor fuerza un pase completo de detección sobre potencialmente miles de entidades, y luego `SaveChanges` lo hace de nuevo:

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

Como `SaveChanges` siempre corre su propio pase de detección, el loop de audit ahora lee el state recién computado sin pagar por él dos veces.

## Cuándo echar mano de él

`GetEntriesForState` no es un reemplazo drop-in de `Entries()`. Úsalo cuando ya sabes qué states importan y un pase de detección está agendado para pasar de todos modos. Buenos fits:

- Implementaciones de `SaveChangesInterceptor`.
- Outbox publishers que corren dentro de la misma transacción que el save.
- Reescritores de soft-delete que solo necesitan entries en `Deleted`.
- Validadores que aceptan resultados "ligeramente stale" a cambio de throughput.

Evítalo para código que debe ver cada cambio pendiente antes del save, por ejemplo una UI que renderiza "tienes 3 edits sin guardar". En ese caso `Entries()` sigue siendo correcto porque su pase de detección es el punto entero.

## Midiendo el win

El impacto crece con el count de entidades trackeadas. Para un context sosteniendo 10.000 entidades con value objects complejos, `Entries()` corre un scan por property para decidir si algo cambió. Reemplazar un audit read de `Entries().Where(e => e.State != EntityState.Unchanged)` con `GetEntriesForState(false, true, true, false)` recorta un pase completo, que típicamente es 10-30% del tiempo total de `SaveChanges` en paths OLTP audit-heavy.

Como siempre, mide: si tu context raramente sostiene más de un par de decenas de entidades, el API sigue siendo más lindo, pero el delta perf es ruido. La lista completa de cambios de EF Core saliendo en este preview está en las [release notes de EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).
