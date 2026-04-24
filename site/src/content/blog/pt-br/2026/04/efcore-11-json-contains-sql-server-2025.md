---
title: "EF Core 11 traduz Contains para JSON_CONTAINS no SQL Server 2025"
description: "EF Core 11 traduz automaticamente LINQ Contains sobre coleções JSON para a nova função JSON_CONTAINS do SQL Server 2025, e adiciona EF.Functions.JsonContains para queries com path e modos específicos que conseguem bater num índice JSON."
pubDate: 2026-04-20
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "linq"
lang: "pt-br"
translationOf: "2026/04/efcore-11-json-contains-sql-server-2025"
translatedBy: "claude"
translationDate: 2026-04-24
---

O SQL Server 2025 ganhou uma função nativa [`JSON_CONTAINS`](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql), e o EF Core 11 é o release que se conecta a ela. Duas coisas mudam para quem armazena coleções como colunas JSON: `Contains` sobre coleções JSON agora ganha uma tradução direta em vez do antigo join `OPENJSON`, e existe um novo `EF.Functions.JsonContains()` para casos em que você precisa de um path JSON ou um modo de busca específico. O trabalho faz parte do [EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).

## Optando pelo nível de compatibilidade do SQL Server 2025

A nova tradução só liga quando o provider sabe que está conversando com o SQL Server 2025. Você faz isso via `UseCompatibilityLevel(170)` nas opções do provider:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

O nível de compatibilidade 170 é o que o SQL Server 2025 reporta; níveis menores continuam usando a tradução antiga, então é seguro deixar de fora até você realmente atualizar o banco.

## Como o Contains fica agora

Pegue uma forma clássica de "tags como array JSON":

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = new();
}

modelBuilder.Entity<Blog>()
    .Property(b => b.Tags)
    .HasColumnType("json"); // SQL Server 2025 native JSON type
```

No EF Core 10 ou em um target SQL Server mais antigo, esta query:

```csharp
var posts = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

devolve a tradução `OPENJSON`, que se lê como uma subquery correlacionada:

```sql
WHERE N'ef-core' IN (
    SELECT [t].[value]
    FROM OPENJSON([b].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)
```

EF Core 11 contra o nível de compatibilidade 170 emite isso no lugar:

```sql
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

A razão de isso importar não é só estética do SQL. `JSON_CONTAINS` é o único predicado no SQL Server 2025 que consegue usar um [índice JSON](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql). Se você tem `CREATE JSON INDEX IX_Tags ON Blogs(Tags)`, o caminho `OPENJSON` nunca o toca, mas a tradução do EF 11 sim.

Tem uma armadilha apontada nas release notes: `JSON_CONTAINS` não trata NULL como o `Contains` do LINQ trata, então o EF só escolhe a nova tradução quando pelo menos um lado é comprovadamente não-anulável (uma constante não nula, ou uma coluna não anulável). Se ambos os lados podem ser null, o EF cai pra `OPENJSON` para preservar o comportamento existente.

## Quando você precisa de um path ou um modo de busca

`Contains` cobre o caso "esse escalar está no array". Para qualquer outra coisa, o EF Core 11 expõe `EF.Functions.JsonContains(container, value, path?, mode?)`. O exemplo clássico é procurar um valor num path específico dentro de um documento JSON estruturado:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string JsonData { get; set; } = "{}"; // { "Rating": 8, ... }
}

var ratedEights = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

Traduz para:

```sql
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Você pode usar com colunas string escalares, com tipos complexos mapeados em JSON, e com tipos owned mapeados via `OwnsOne(... b.ToJson())`. A comparação contra `= 1` é load-bearing: `JSON_CONTAINS` retorna um `bit`, e o EF preserva isso para que predicados compostos como `WHERE ... AND JSON_CONTAINS(...) = 1` continuem SARGable contra um índice JSON.

Combine isso com [`EF.Functions.JsonPathExists`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) para checagens "essa propriedade existe?" e você cobre a maior parte da superfície de queries de coluna JSON sem descer para SQL cru. A lista completa de mudanças do tradutor do EF Core 11 está no doc [What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
