---
title: "EF Core 11 poda joins de referência desnecessários em split queries"
description: "EF Core 11 Preview 3 remove joins to-one redundantes de split queries e derruba chaves ORDER BY desnecessárias. Um cenário relatado ficou 29% mais rápido, outro 22%. Aqui está como o SQL fica agora."
pubDate: 2026-04-18
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "performance"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries"
translatedBy: "claude"
translationDate: 2026-04-24
---

Split queries do EF Core sempre tiveram uma aresta afiada: quando você misturava `Include` de navegações de referência com `Include` de navegações de coleção, toda query filha ainda re-joineava as tabelas de referência, mesmo que nada naquelas queries de coleção precisasse delas. EF Core 11 Preview 3 conserta isso, junto com uma super-especificação de `ORDER BY` relacionada. As [release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) cronometram o impacto do benchmark em 29% para um cenário comum de split-query e 22% para um caso de single-query. É o tipo de mudança que aparece em produção sem nenhuma edição de LINQ da sua parte.

## O join extra que nunca foi necessário

Considere o formato canônico: um blog com um `BlogType` to-one e `Posts` to-many, carregado com `AsSplitQuery()`:

```csharp
var blogs = context.Blogs
    .Include(b => b.BlogType)
    .Include(b => b.Posts)
    .AsSplitQuery()
    .ToList();
```

Split queries rodam um SQL por coleção incluída, mais a query raiz. A query raiz legitimamente precisa joinear `BlogType` pra projetar suas colunas. A query de coleção pra `Posts` não, porque só projeta colunas de post. EF Core 10 e anteriores ainda emitiam o join:

```sql
-- Before EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id], [b0].[Id]
FROM [Blogs] AS [b]
INNER JOIN [BlogType] AS [b0] ON [b].[BlogTypeId] = [b0].[Id]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id], [b0].[Id]
```

Aquele `INNER JOIN [BlogType]` extra resolve pra toda linha, depois participa do sort, sem razão de payload. EF Core 11 poda:

```sql
-- EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]
```

Quanto mais navegações de referência você tinha embaladas no `Include`, mais joins somem. Se seu modelo de domínio se apoia em `Include` de lookups pequenos (`Country`, `Status`, `Currency`) ao lado de uma coleção real, isso é essencialmente throughput grátis.

## Super-especificação de ORDER BY, também vai

A segunda otimização também se aplica a single queries. Quando você inclui uma navegação de referência, o EF historicamente emitia a chave dela na cláusula `ORDER BY`, mesmo que a primary key do pai já a determinasse via foreign key:

```csharp
var blogs = context.Blogs
    .Include(b => b.Owner)
    .Include(b => b.Posts)
    .ToList();
```

Antes do EF Core 11:

```sql
ORDER BY [b].[BlogId], [p].[PersonId]
```

No EF Core 11:

```sql
ORDER BY [b].[BlogId]
```

`BlogId` é único, e `PersonId` era totalmente determinado por `BlogId` via o FK, então mantê-lo na chave de sort era puro custo. Derrubá-lo encurta a chave de sort, o que importa assim que a tabela fica grande o suficiente pra vazar pra disco ou assim que o planner escolhe um merge join sobre o resultado.

## Quando você vai notar

Você verá os maiores wins em queries com múltiplos includes de referência pequenos mais um ou mais includes de coleção, já que esses costumavam repetir os mesmos joins desnecessários em cada query filha. Customer-order, invoice-with-lines, e blog-with-posts são os candidatos óbvios. Queries sem `AsSplitQuery()`, e queries sem includes de referência, ganham a simplificação de `ORDER BY` mas não a poda de join.

Não há mudança de API e nada pra ligar. Upgrade pra EF Core 11.0.0-preview.3 (targetando .NET 11 Preview 3), rode o mesmo LINQ, e o SQL gerado fica mais apertado. Detalhes do benchmark vivem no [issue de tracking do EF Core](https://github.com/dotnet/efcore/issues/29182).
