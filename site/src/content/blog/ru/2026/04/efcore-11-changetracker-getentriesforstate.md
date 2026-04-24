---
title: "EF Core 11 добавляет GetEntriesForState, чтобы пропустить DetectChanges"
description: "EF Core 11 Preview 3 вводит ChangeTracker.GetEntriesForState, state-фильтрованный enumerator, избегающий лишнего прохода DetectChanges в hot paths вроде SaveChanges interceptors и audit hooks."
pubDate: 2026-04-16
tags:
  - "ef-core"
  - "dotnet-11"
  - "performance"
  - "csharp"
lang: "ru"
translationOf: "2026/04/efcore-11-changetracker-getentriesforstate"
translatedBy: "claude"
translationDate: 2026-04-24
---

У `ChangeTracker.Entries()` есть одна причуда, кусающая любое приложение, использующее его в hot path: он неявно вызывает `DetectChanges()` перед возвратом. Для audit interceptor или pre-`SaveChanges` валидатора эта цена платится снова на реальном save, удваивая scan по каждой tracked-сущности. [EF Core 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) вводит `GetEntriesForState` специально, чтобы убрать этот избыточный проход.

## Форма API

Новый метод живёт на `ChangeTracker` рядом с `Entries()` и принимает четыре флага, по одному на каждое значение `EntityState`, которое обходит scanner:

```csharp
IEnumerable<EntityEntry> GetEntriesForState(
    bool added,
    bool modified,
    bool deleted,
    bool unchanged);
```

Он полностью пропускает `DetectChanges` и возвращает entries, текущий state которых уже совпадает с запрошенными флагами. Вы теряете автоматическую change detection для вызова, что именно та сделка, которую вы хотите в коде, который вот-вот запустит save (и следовательно detection) несколькими строками позже.

Фича отслеживается как [dotnet/efcore #37847](https://github.com/dotnet/efcore/issues/37847) и поставилась в Preview 3 EF Core bits.

## Аудит без двойного scan

Типичный audit interceptor вытаскивает modified и deleted entries из tracker и пишет их в audit-таблицу. С `Entries()` этот interceptor принудительно запускает полный проход detection по потенциально тысячам сущностей, а потом `SaveChanges` делает это ещё раз:

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

Поскольку `SaveChanges` всегда запускает собственный проход detection, audit-цикл теперь читает свежевычисленное состояние, не платя за него дважды.

## Когда тянуться за ним

`GetEntriesForState` не drop-in замена `Entries()`. Используйте, когда уже знаете, какие states важны, и detection pass всё равно запланирован. Хорошие случаи:

- Реализации `SaveChangesInterceptor`.
- Outbox publishers, работающие внутри той же транзакции, что save.
- Soft-delete rewriters, которым нужны только entries в `Deleted`.
- Валидаторы, принимающие "чуть устаревшие" результаты в обмен на throughput.

Избегайте для кода, который должен видеть каждое незавершённое изменение перед save, например UI, рендерящего "у вас 3 несохранённых правки". В этом случае `Entries()` всё ещё правильный, потому что его detection pass - это и есть вся суть.

## Измерение выигрыша

Влияние растёт со счётом tracked-сущностей. Для context, держащего 10 000 сущностей со сложными value objects, `Entries()` запускает per-property scan, чтобы решить, изменилось ли что-то. Замена audit read `Entries().Where(e => e.State != EntityState.Unchanged)` на `GetEntriesForState(false, true, true, false)` срезает один полный проход, что обычно 10-30% от общего времени `SaveChanges` в audit-тяжёлых OLTP-путях.

Как всегда, измеряйте: если ваш context редко держит больше нескольких десятков сущностей, API всё ещё приятнее, но perf-разница - шум. Полный список изменений EF Core, выходящих в этом preview, - в [release notes EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).
