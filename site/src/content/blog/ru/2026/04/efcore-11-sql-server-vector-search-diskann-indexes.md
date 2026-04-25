---
title: "EF Core 11 добавляет нативный векторный поиск SQL Server с индексами DiskANN"
description: "EF Core 11 Preview 2 поддерживает VECTOR_SEARCH() из SQL Server 2025 и векторные индексы DiskANN прямо из LINQ. Вот как настроить индекс, выполнять приближённые запросы, и что меняется по сравнению с подходом VectorDistance из EF Core 10."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2026/04/efcore-11-sql-server-vector-search-diskann-indexes"
translatedBy: "claude"
translationDate: 2026-04-25
---

EF Core 10 представил `EF.Functions.VectorDistance()` для вычисления точных расстояний между эмбеддингами в LINQ-запросах. Это работает, но точный поиск по миллионам строк дорог. EF Core 11 Preview 2 закрывает этот пробел, поддерживая приближённый векторный поиск SQL Server 2025: индексы DiskANN и табличную функцию `VECTOR_SEARCH()`, всё подключённое через ваш `DbContext`.

## Настройка векторного индекса

Объявите индекс в `OnModelCreating` с нужной метрикой расстояния (косинусная, скалярное произведение или евклидова):

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasVectorIndex(b => b.Embedding, "cosine");
}
```

Когда вы добавляете миграцию, EF генерирует DDL `CREATE VECTOR INDEX`, нацеленный на движок DiskANN из SQL Server 2025. Индекс живёт рядом с вашими обычными B-tree и полнотекстовыми индексами, управляемый через тот же конвейер миграций.

## Запросы через VectorSearch()

Когда индекс существует, используйте новый метод-расширение `VectorSearch()` на вашем `DbSet`:

```csharp
float[] queryEmbedding = GetEmbeddingForQuery("distributed caching");

var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 5)
    .ToListAsync();
```

Это транслируется в табличную функцию `VECTOR_SEARCH()` SQL Server, которая выполняет приближённый поиск ближайших соседей по индексу DiskANN. Параметр `topN` ограничивает, сколько результатов возвращается.

Тип возврата -- `VectorSearchResult<TEntity>`, который раскрывает как сущность, так и вычисленное расстояние:

```csharp
var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 10)
    .Select(r => new { r.Value.Name, r.Distance })
    .ToListAsync();
```

## Точный против приближённого: когда что использовать

`VectorDistance()` из EF Core 10 по-прежнему работает и даёт точные результаты. Используйте его, когда набор данных мал или точность важнее задержки. `VectorSearch()` с индексом DiskANN обменивает небольшое количество точности recall на значительно лучшую пропускную способность на больших таблицах.

На практике большинство RAG-нагрузок и нагрузок рекомендаций хотят приближённый путь. Если ранее вы выгружали векторный поиск в выделенную базу данных (Qdrant, Pinecone, pgvector), это возвращает его в SQL Server, который вы уже запускаете, с EF Core, управляющим схемой.

## Требования

Эта функциональность нацелена на SQL Server 2025, где были введены векторные индексы DiskANN. Функция `VECTOR_SEARCH()` и связанный с ней синтаксис `CREATE VECTOR INDEX` экспериментальны в SQL Server на момент написания, поэтому ожидайте изменений. API EF Core отражают этот экспериментальный статус.

Для полных деталей настройки см. [документацию по векторному поиску EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/vector-search).
