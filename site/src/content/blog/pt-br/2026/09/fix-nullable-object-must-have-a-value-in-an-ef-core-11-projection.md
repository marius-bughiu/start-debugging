---
title: "Correção: InvalidOperationException: Nullable object must have a value em uma projeção do EF Core 11"
description: "O EF Core lança este erro quando um Select lê um NULL do SQL em um int, decimal ou DateTime não anulável. Faça o cast do membro para o tipo anulável e adicione ?? default, ou proteja a navegação com uma verificação de null."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "pt-br"
translationOf: "2026/09/fix-nullable-object-must-have-a-value-in-an-ef-core-11-projection"
translatedBy: "claude"
translationDate: 2026-09-14
---

O EF Core lança `InvalidOperationException: Nullable object must have a value` quando o SQL gerado para o seu `Select` retorna `NULL` em uma coluna que a sua projeção atribui a um tipo de valor não anulável (`int`, `decimal`, `DateTime`, `Guid`, uma struct). Os culpados de sempre são uma navegação opcional (`o.Customer.Rating` em um pedido sem cliente), `Max`/`Min`/`Average` sobre uma coleção vazia e um DTO inteiro tirado do lado vazio de um join com `DefaultIfEmpty`. A correção é tornar a anulabilidade visível no LINQ: faça o cast para o tipo anulável (`(int?)o.Customer.Rating`) e forneça um valor padrão com `?? 0`, ou escreva `o.Customer == null ? 0 : o.Customer.Rating`. Todos os resultados abaixo foram medidos no `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 no .NET 11 RC 1 e comparados com o EF Core 10.0.12. Um caso é novo no EF Core 11: projetar uma coleção complexa JSON junto com uma navegação de coleção. Essa é uma regressão real, tratada em uma seção própria.

## O erro no contexto

No caso de runtime, a exceção vem do shaper compilado, não do seu código nem do driver do banco de dados. Isso faz o stack trace parecer inútil:

```
System.InvalidOperationException: Nullable object must have a value.
   at lambda_method272(Closure, QueryContext, DbDataReader, ResultContext, SingleQueryResultCoordinator)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.Enumerator.MoveNext()
   at System.Collections.Generic.List`1..ctor(IEnumerable`1 collection)
```

`lambda_method` é o materializador que o EF Core compilou para a sua projeção. Ele lê cada coluna como um valor anulável e depois chama `.Value` para colocá-lo no seu membro não anulável. Quando a coluna é `NULL`, `Nullable<T>.Value` lança a exceção, e você recebe a mesma mensagem que veria com `((int?)null).Value` em C# puro. A consulta foi traduzida sem problemas e o SQL rodou sem problemas. O que falhou foi a conversão da linha em objeto.

Se os frames do topo forem ``System.Nullable`1.get_Value()`` e `SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension`, a consulta falhou em tempo de compilação, antes de qualquer SQL rodar. Até `ToQueryString()` lança a exceção. Essa é a regressão do EF Core 11 tratada na seção sobre coleções complexas JSON mais abaixo.

## Por que isso acontece

LINQ-to-Objects e SQL discordam sobre o que significa "ausente". Em C#, `order.Customer.Rating` com um `Customer` nulo lança uma `NullReferenceException`, e `new List<decimal>().Max()` lança `Sequence contains no elements`. Em SQL, um `LEFT JOIN` sem correspondência produz colunas `NULL`, e `MAX` sobre zero linhas retorna `NULL`. O EF Core traduz para a semântica do SQL, então nenhuma exceção é disparada no banco de dados. O `NULL` então volta para um membro do CLR que não consegue armazená-lo.

O EF Core já compensa isso em vários lugares. `Sum` é envolvido em `COALESCE(..., 0)`, um `FirstOrDefault()` escalar em uma subconsulta é envolvido em `ISNULL`, e a materialização de entidades verifica as colunas de chave antes de construir um objeto. O erro aparece nas lacunas que ele não cobre. Essas lacunas são as mesmas no EF Core 10 e 11, exceto por uma correção e uma regressão.

## Reprodução mínima

O modelo tem pedidos com um cliente opcional e um cliente ("Bob") sem nenhum pedido:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (same model on EF Core 10.0.12)
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public List<Order> Orders { get; set; } = [];
}

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public int? CustomerId { get; set; }     // optional relationship
    public Customer? Customer { get; set; }
}

// seed: Ana (Rating 5) with one order, Bob with none, plus one guest order with CustomerId = null
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer!.Rating })
    .ToList(); // InvalidOperationException: Nullable object must have a value.
```

O `!` silencia o aviso de anulável. Ele não faz nada em runtime. O EF Core gera um `LEFT JOIN` simples:

```sql
-- EF Core 11 RC 1, SQL Server provider, via ToQueryString()
SELECT [o].[Id], [c].[Rating]
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

A linha do pedido de convidado tem `NULL` em `[c].[Rating]`, e o `int Rating` do tipo anônimo não consegue recebê-lo. Um DTO nomeado (`new OrderDto { Rating = o.Customer!.Rating }`) e um escalar simples (`Select(o => o.Customer!.Rating)`) falham da mesma forma.

## Correções, em ordem de preferência

### 1. Faça o cast para o tipo anulável e escolha um valor padrão

Esta é a correção mais comum e a que gera o SQL mais barato:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = (int?)o.Customer!.Rating ?? 0 })
    .ToList(); // { Id = 1, Rating = 0 } | { Id = 2, Rating = 5 }
```

```sql
SELECT [o].[Id], ISNULL([c].[Rating], 0)
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Se "sem cliente" e "avaliação 0" significam coisas diferentes para quem chama o código, remova o `?? 0` e torne o membro do DTO `int?`. Isso preserva a diferença, o que geralmente é mais honesto do que inventar um zero.

### 2. Proteja a navegação explicitamente

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer == null ? 0 : o.Customer.Rating })
    .ToList();
```

O EF Core transforma a verificação de null em um teste sobre a chave do join, que é o sinal correto de "o join encontrou correspondência" mesmo quando o próprio membro é uma coluna anulável:

```sql
SELECT [o].[Id], CASE
    WHEN [c].[Id] IS NULL THEN 0
    ELSE [c].[Rating]
END
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Use esta forma quando você projeta vários membros da mesma navegação opcional, ou quando o membro é uma string ou outro tipo de referência e você quer uma propriedade não nula no DTO.

### 3. Agregações sobre coleções possivelmente vazias

`Sum` é seguro. `Max`, `Min` e `Average` não são. Tanto no EF Core 11 RC 1 quanto no 10.0.12:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
db.Customers.Select(c => new { c.Name, Biggest = c.Orders.Max(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Avg = c.Orders.Average(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Sum = c.Orders.Sum(o => o.Total) });          // Bob = 0.0
db.Customers.Select(c => new { c.Name, Last = c.Orders.OrderBy(o => o.Id)
                                                .Select(o => o.Total).FirstOrDefault() }); // Bob = 0.0
```

O SQL gerado mostra o porquê. `Sum` recebe `COALESCE(SUM([o].[Total]), 0.0)`, e a subconsulta do `FirstOrDefault` recebe `ISNULL((SELECT TOP(1) ...), 0.0)`. `MAX` e `AVG` passam sem nada. A correção é o mesmo cast, feito dentro do seletor da agregação:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Customers.Select(c => new
{
    c.Name,
    Biggest  = c.Orders.Max(o => (decimal?)o.Total) ?? 0m,
    Smallest = c.Orders.Min(o => (decimal?)o.Total) ?? 0m,
    Avg      = c.Orders.Average(o => (decimal?)o.Total) ?? 0m,
}).ToList(); // Bob: 0, 0, 0
```

`c.Orders.Select(o => o.Total).DefaultIfEmpty().Max()` também funciona, mas é compilado para um `LEFT JOIN` contra uma tabela derivada `SELECT 1 AS empty` de uma linha. O cast para anulável gera um SQL mais simples para a mesma resposta.

### 4. Joins com `DefaultIfEmpty` que projetam um DTO

Este é o formato de [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915): um left join manual em que o lado interno é um DTO projetado, e não uma entidade.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers.Select(c => new CustomerDto { Id = c.Id, Rating = c.Rating })
         on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new { o.Id, Customer = c })
    .ToList(); // throws on EF Core 11 RC 1 and 10.0.12
```

LINQ-to-Objects daria `Customer = null` para o pedido de convidado. O EF Core, em vez disso, tenta construir um `CustomerDto` a partir de colunas todas `NULL`. Faça o join com a entidade e construa o DTO depois do join, protegido por uma verificação de null:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new
     {
         o.Id,
         Customer = c == null ? null : new CustomerDto { Id = c.Id, Rating = c.Rating }
     })
    .ToList(); // { Id = 1, Customer = null } | { Id = 2, Customer = CustomerDto 1 Rating=5 }
```

Com uma entidade no lado interno, o EF Core pode verificar a coluna de chave para decidir se a linha teve correspondência. Com um DTO projetado simples, ele não tem nada para verificar. A equipe do EF acompanha exatamente essa variante em [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608), ainda aberta, e diz que a correção depende da reformulação da expansão de navegações.

## O que o EF Core 11 já corrigiu: `LeftJoin` contra um `GroupBy`

Uma família de casos melhorou de fato no EF Core 11. Um `LeftJoin` (o operador adicionado no .NET 10, veja [os operadores de join do LINQ no .NET 10 e 11](/pt-br/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)) contra uma agregação agrupada, relatado em [dotnet/efcore#38055](https://github.com/dotnet/efcore/issues/38055):

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var counts = db.Orders.GroupBy(o => o.CustomerId, (k, g) => new { CustomerId = k, Count = g.Count() });

var rows = db.Customers
    .LeftJoin(counts, c => (int?)c.Id, g => g.CustomerId, (c, g) => new { c, g })
    .Select(x => new { x.c.Name, Count = x.g == null ? 0 : x.g.Count })
    .ToList();
// EF Core 10.0.12: InvalidOperationException: Nullable object must have a value.
// EF Core 11 RC 1: { Name = Ana, Count = 1 } | { Name = Bob, Count = 0 }
```

O EF Core 11 agora coloca uma coluna sintética na subconsulta interna e condiciona o objeto a ela:

```sql
SELECT [c].[Name], [o0].[CustomerId], [o0].[Count], [o0].[marker]
FROM [Customers] AS [c]
LEFT JOIN (
    SELECT [o].[CustomerId], COUNT(*) AS [Count], 1 AS [marker]
    FROM [Orders] AS [o]
    GROUP BY [o].[CustomerId]
) AS [o0] ON [c].[Id] = [o0].[CustomerId]
```

`[marker]` só é `NULL` quando o join não encontrou correspondência, então `x.g == null` finalmente significa o que diz. Isso chegou em [dotnet/efcore#38479](https://github.com/dotnet/efcore/pull/38479) (mesclado em junho de 2026), com complementos para projeções de tipos de valor ([#38555](https://github.com/dotnet/efcore/pull/38555)) e joins posteriores ([#38499](https://github.com/dotnet/efcore/pull/38499)). Nenhum deles recebeu backport para o 10.0.x. No EF Core 10, faça o cast dentro do agrupamento (`Count = (int?)g.Count()`) e leia `x.g!.Count ?? 0`, o que funciona nas duas versões e produz `ISNULL([o0].[Count], 0)`.

## Regressão do EF Core 11 RC 1: coleção complexa JSON mais uma navegação de coleção

Este não é um problema de dados. Projetar uma coleção complexa mapeada para JSON (`ComplexCollection(...).ToJson()`, veja [mapeando colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)) junto com uma navegação de coleção no mesmo `Select` lança a exceção enquanto a consulta é compilada:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
modelBuilder.Entity<Parent>(e =>
{
    e.ComplexCollection(p => p.Items).ToJson();
    e.HasMany(p => p.Links).WithMany(l => l.Parents);
});

var dtos = db.Parents
    .Select(p => new ParentDto
    {
        Name = p.Name,
        Items = p.Items,                                  // JSON complex collection
        Links = p.Links.Select(l => l.Name).ToList(),     // collection navigation
    })
    .ToList();
// EF Core 10.0.12: works
// EF Core 11 RC 1: InvalidOperationException: Nullable object must have a value.
//   at System.Nullable`1.get_Value()
//   at ...SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension(Expression expression)
```

Cada metade funciona sozinha. `AsSplitQuery()` não ajuda, porque a falha acontece antes de o EF Core decidir como dividir a consulta. Este é o [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928), marcado como regressão desde a 11.0.0-preview.1. A correção, [dotnet/efcore#38932](https://github.com/dotnet/efcore/pull/38932), foi mesclada na `main` em 2026-09-09. O backport para `release/11.0`, [#38948](https://github.com/dotnet/efcore/pull/38948), ainda estava aberto em 2026-09-14, então o RC 1 tem o bug e a correção deve chegar em um RC posterior ou na GA. Até lá, carregue a entidade com `Include` e faça o mapeamento em memória:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var dtos = (await db.Parents.Include(p => p.Links).AsNoTracking().ToListAsync())
    .Select(p => new ParentDto { Name = p.Name, Items = p.Items, Links = p.Links.Select(l => l.Name).ToList() })
    .ToList();
```

ou execute duas projeções (uma para a coluna JSON, outra para a navegação) e junte os resultados pela chave. As duas abordagens funcionam no RC 1. A versão com `Include` carrega todas as colunas de `Link`, então para tabelas largas use a versão com duas consultas.

## Erros parecidos que trazem você até aqui

- **`The data is NULL at ordinal 1. This method can't be called on NULL values`** (SQLite) ou **`SqlNullValueException: Data is Null`** (SQL Server): uma coluna que é anulável no banco de dados, mas mapeada para uma propriedade não anulável, algo típico de modelos database-first e de views. O provider lança a exceção ao ler a coluna, antes que o shaper do EF Core a veja. Medido apenas no SQLite. A correção está no modelo: torne a propriedade `int?`, ou corrija a coluna. Nem `(int?)p.Stock` nem `(int?)p.Stock ?? -1` na projeção ajudam (os dois ainda lançam a exceção no EF Core 11 RC 1), porque o EF Core confia no modelo e lê a coluna com `GetInt32`.
- **`Sequence contains no elements`**: a versão LINQ-to-Objects do mesmo problema de conjunto vazio, ou um `First()`/`Single()` que rodou em memória. Veja [o post dedicado](/pt-br/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`** envolvendo `Nullable object must have a value`: é o seu próprio `maybe!.Value` sendo avaliado no cliente como parâmetro, antes de qualquer SQL. Isso é tratado no [post sobre avaliação de parâmetros](/pt-br/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).

## Encontrando a coluna problemática rapidamente

O stack trace do shaper nunca informa o membro. Duas formas rápidas de encontrá-lo:

1. Chame `query.ToQueryString()` e procure uma coluna do lado anulável de um `LEFT JOIN`, de um `OUTER APPLY` ou de uma subconsulta com `MAX`/`MIN`/`AVG` sem proteção. [Registrando em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) cobre as outras opções.
2. Altere temporariamente a projeção para `(int?)` / `(decimal?)` em todos os membros de tipo de valor, execute e veja qual deles volta como `null`. Esse é o membro a corrigir.

Se o próprio `ToQueryString()` lançar a exceção, o problema está em tempo de compilação. No EF Core 11 RC 1, verifique se há o formato JSON mais navegação descrito acima. Se o que falha é a tradução, e não a materialização, normalmente você verá outra mensagem, tratada no [guia sobre "could not be translated"](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Uma nota sobre o método: todas as contagens de linhas e exceções acima vieram da execução das consultas contra SQLite em memória, nas duas versões do EF Core. O SQL do SQL Server foi gerado com `ToQueryString()`, não executado. O materializador que lança a exceção não depende do provider, então as mesmas projeções falham de forma idêntica no SQL Server, mas não rodei uma instância do SQL Server para este post.

## Fontes

- [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928): regressão da coleção complexa JSON mais navegação de coleção; correção em [#38932](https://github.com/dotnet/efcore/pull/38932), backport em [#38948](https://github.com/dotnet/efcore/pull/38948).
- [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) e [#38055](https://github.com/dotnet/efcore/issues/38055): projeções que não são entidades em left joins; correção parcial em [#38479](https://github.com/dotnet/efcore/pull/38479).
- [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608): a variante com DTO projetado simples em `DefaultIfEmpty` que continua aberta.
- [dotnet/efcore#33802](https://github.com/dotnet/efcore/issues/33802): comportamento inconsistente de agregações sobre coleções vazias.
- [dotnet/efcore#35950](https://github.com/dotnet/efcore/issues/35950): a regressão de `COALESCE` com `DefaultIfEmpty` no EF Core 9, corrigida no EF Core 10.
- [Operadores de consulta complexos no EF Core](https://learn.microsoft.com/ef/core/querying/complex-query-operators) no Microsoft Learn.
