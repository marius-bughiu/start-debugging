---
title: "EF Core 11 adiciona GetEntriesForState pra pular DetectChanges"
description: "EF Core 11 Preview 3 introduz ChangeTracker.GetEntriesForState, um enumerador filtrado por state que evita um pass extra de DetectChanges em hot paths como interceptors de SaveChanges e hooks de audit."
pubDate: 2026-04-16
tags:
  - "ef-core"
  - "dotnet-11"
  - "performance"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/efcore-11-changetracker-getentriesforstate"
translatedBy: "claude"
translationDate: 2026-04-24
---

`ChangeTracker.Entries()` tem uma quirk que morde toda app que usa em um hot path: implicitamente chama `DetectChanges()` antes de retornar. Pra um audit interceptor ou um validador pre-`SaveChanges`, esse custo é pago de novo no save real, dobrando o scan sobre cada entidade trackeada. [EF Core 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) introduz `GetEntriesForState` especificamente pra remover esse pass redundante.

## O formato da API

O novo método vive no `ChangeTracker` ao lado de `Entries()` e aceita quatro flags, uma por valor de `EntityState` que o scanner percorre:

```csharp
IEnumerable<EntityEntry> GetEntriesForState(
    bool added,
    bool modified,
    bool deleted,
    bool unchanged);
```

Ele pula `DetectChanges` completamente e retorna entries cujo state atual já bate com as flags pedidas. Você perde detecção automática de mudança pra a chamada, que é exatamente o trade que você quer em código que está prestes a disparar um save (e portanto detecção) umas linhas depois.

A feature é trackeada como [dotnet/efcore #37847](https://github.com/dotnet/efcore/issues/37847) e saiu nos bits do EF Core Preview 3.

## Auditing sem o double scan

Um audit interceptor típico pega entries modificados e deletados do tracker e escreve numa tabela de audit. Com `Entries()`, esse interceptor força um pass completo de detecção sobre potencialmente milhares de entidades, depois o `SaveChanges` faz de novo:

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

Como o `SaveChanges` sempre roda o próprio pass de detecção, o loop de audit agora lê o state recém computado sem pagar duas vezes.

## Quando usar

`GetEntriesForState` não é substituto drop-in de `Entries()`. Use quando você já sabe quais states importam e um pass de detecção está agendado pra rodar de qualquer jeito. Boas encaixes:

- Implementações de `SaveChangesInterceptor`.
- Outbox publishers que rodam dentro da mesma transação do save.
- Soft-delete rewriters que só precisam de entries em `Deleted`.
- Validadores que aceitam resultados "levemente stale" em troca de throughput.

Evite pra código que precisa ver toda mudança pendente antes do save, por exemplo uma UI que renderiza "você tem 3 edits não salvos". Nesse caso `Entries()` ainda é correto porque o pass de detecção é o ponto todo.

## Medindo o ganho

O impacto cresce com a contagem de entidades trackeadas. Pra um context segurando 10.000 entidades com value objects complexos, `Entries()` roda um scan por propriedade pra decidir se algo mudou. Substituir um audit read de `Entries().Where(e => e.State != EntityState.Unchanged)` por `GetEntriesForState(false, true, true, false)` corta um pass completo, que tipicamente é 10-30% do tempo total de `SaveChanges` em caminhos OLTP audit-heavy.

Como sempre, meça: se seu context raramente segura mais do que algumas dezenas de entidades, a API ainda é mais bonita, mas o delta de perf é ruído. A lista completa de mudanças do EF Core saindo nesse preview está nas [release notes do EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).
