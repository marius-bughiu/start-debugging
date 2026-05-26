---
title: "EF Core 11 Preview 4: as colunas de período das tabelas temporais finalmente podem ser propriedades reais"
description: "O EF Core 11 Preview 4 derruba a antiga restrição de propriedade shadow nas tabelas temporais do SQL Server. PeriodStart e PeriodEnd agora podem ser propriedades CLR comuns, configuradas com lambdas HasPeriodStart e HasPeriodEnd fortemente tipadas."
pubDate: 2026-05-26
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/05/ef-core-11-temporal-tables-clr-period-properties"
translatedBy: "claude"
translationDate: 2026-05-26
---

O EF Core suporta tabelas temporais do SQL Server desde a versão 6.0, mas com uma restrição irritante: as colunas `PeriodStart` e `PeriodEnd` precisavam ser modeladas como propriedades shadow. Você podia consultá-las com `EF.Property<DateTime>(entity, "PeriodStart")`, mas não podia colocá-las na sua classe de entidade e lê-las como qualquer outra coluna. Essa restrição acabou no EF Core 11 Preview 4, lançado em 12 de maio de 2026 como parte do [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/).

A correção chega como [efcore#38110](https://github.com/dotnet/efcore/pull/38110), fechando uma [issue aberta em 2021](https://github.com/dotnet/efcore/issues/26463). É uma mudança pequena em linhas de código e enorme em ergonomia.

## Como era o antigo modelo com propriedades shadow

Antes do Preview 4, uma entidade temporal só podia declarar as colunas da aplicação. As colunas de período viviam no modelo, mas não na classe:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal());
```

Ler os valores de período exigia passar pelo change tracker:

```csharp
var start = context.Entry(order).Property<DateTime>("PeriodStart").CurrentValue;
var end   = context.Entry(order).Property<DateTime>("PeriodEnd").CurrentValue;
```

Dois problemas. Primeiro, você perde IntelliSense e segurança de refatoração: o nome da coluna é uma string mágica. Segundo, projetar valores de período em uma consulta LINQ é desajeitado porque a propriedade não existe no tipo CLR. Mapear um DTO que inclua a janela de validade significava ou uma consulta SQL crua ou `EF.Property<>` dentro do `Select`, e ambas brigam com o sistema de tipos.

## O modelo do Preview 4

No Preview 4 você simplesmente coloca as colunas de período na entidade:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}
```

Configure-as com as novas sobrecargas fortemente tipadas de `HasPeriodStart` e `HasPeriodEnd` que recebem uma lambda:

```csharp
modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal(ttb =>
{
    ttb.HasPeriodStart(o => o.PeriodStart);
    ttb.HasPeriodEnd(o => o.PeriodEnd);
}));
```

Agora `PeriodStart` e `PeriodEnd` se comportam como qualquer outra coluna mapeada. Você pode lê-las em uma entidade materializada, projetá-las no `Select`, ordenar por elas e filtrar por elas em LINQ comum:

```csharp
var openOrders = await context.Orders
    .Where(o => o.PeriodEnd == DateTime.MaxValue)
    .Select(o => new { o.Id, o.Status, o.PeriodStart })
    .ToListAsync();
```

O predicado `PeriodEnd == DateTime.MaxValue` é o filtro canônico de "linha atual" para tabelas temporais do SQL Server. Antes era preciso escrevê-lo contra a propriedade shadow.

## O que não muda

A semântica da tabela temporal no lado do banco de dados é idêntica. O SQL Server continua mantendo a tabela de histórico, continua atualizando `PeriodStart` e `PeriodEnd` em cada escrita e continua rejeitando escritas diretas nas colunas de período. O EF Core continua marcando-as como `ValueGeneratedOnAddOrUpdate` e as ignora em insert e update. Você pode ler, mas não pode atribuir.

Consultas de viagem no tempo também funcionam do mesmo jeito:

```csharp
var snapshot = await context.Orders
    .TemporalAsOf(new DateTime(2026, 5, 1))
    .ToListAsync();
```

A única diferença é que as entidades retornadas agora carregam os valores de período no objeto CLR em vez de escondê-los atrás de `EF.Property<>`.

## A migração é opcional

Se você tem um modelo existente com colunas de período shadow, não precisa mudar nada. A API antiga continua funcionando. Para qualquer entidade temporal nova, colocar `PeriodStart` e `PeriodEnd` na classe é agora o caminho de menor resistência.

Notas completas do EF Core no Preview 4: [release-notes/11.0/preview/preview4/efcore.md](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/efcore.md).
