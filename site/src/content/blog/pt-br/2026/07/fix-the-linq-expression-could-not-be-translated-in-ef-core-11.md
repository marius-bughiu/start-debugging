---
title: "Solução: \"The LINQ expression could not be translated\" no EF Core 11"
description: "O EF Core 11 lança isso quando um Where ou OrderBy chama um método que ele não consegue converter em SQL. Reescreva o predicado com operadores traduzíveis, ou traga os dados para o cliente com AsEnumerable primeiro."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

O EF Core 11 lança `The LINQ expression could not be translated` quando uma parte da sua consulta fora do `Select` final (geralmente um `Where`, `OrderBy`, `GroupBy` ou `Join`) chama um método ou usa uma construção que o provedor de banco de dados não consegue converter em SQL. Corrija reescrevendo o predicado com operadores que o EF consegue traduzir (`==`, `Contains`, `StartsWith`, `EF.Functions.*`), ou, se você realmente precisa de lógica em memória, force a avaliação no cliente de propósito chamando `AsEnumerable()`, `AsAsyncEnumerable()`, `ToList()` ou `ToListAsync()` antes do passo não traduzível. Isso vale para o `Microsoft.EntityFrameworkCore` 11.0 no .NET 11 com C# 14, e o comportamento não mudou desde o EF Core 3.0.

## O erro em contexto

A exceção completa em tempo de execução aparece assim. O EF Core imprime a árvore de expressão exata em que travou, que é a pista mais útil de toda a tela:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => o.CustomerName.Equals(
        name,
        StringComparison.OrdinalIgnoreCase))' could not be translated. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
```

O tipo da exceção é `System.InvalidOperationException`, e ela é lançada quando a consulta é executada (em `ToList`, `First`, `foreach` ou `await`), não quando você a compõe. É por isso que um stack trace muitas vezes aponta para o seu repositório ou controller em vez do `Where` que de fato causou. Leia a expressão citada, não o stack trace.

## Por que isso acontece

O EF Core traduz o máximo possível da sua consulta em uma única instrução SQL e a executa no servidor de banco de dados. Desde a versão 3.0, ele suporta avaliação parcial no cliente em exatamente um lugar: a projeção de nível superior, ou seja, a última chamada a `Select`. Se qualquer outra parte da consulta, um `Where`, `OrderBy`, `Skip`, `GroupBy`, `Join` ou uma subconsulta aninhada, contiver uma expressão que ele não consegue traduzir, ele se recusa a carregar silenciosamente a tabela inteira em memória e filtrar ali. Em vez disso, ele lança a exceção.

Essa recusa deliberada é um recurso. Antes do EF Core 3.0, o framework avaliava alegremente um `Where` não traduzível no cliente, o que significava que uma consulta de aparência barata podia baixar silenciosamente um milhão de linhas e filtrá-las no seu processo. O comportamento atual troca uma exceção barulhenta em tempo de desenvolvimento por uma classe de desastres de desempenho em produção que você nunca vê. Quando você bate nesse erro, o EF Core está dizendo que o predicado que você escreveu não tem equivalente em SQL.

Os gatilhos habituais são:

- Chamar um método de C# sem mapeamento para SQL (um helper próprio, `string.Equals` com um `StringComparison`, `Enum.HasFlag`, `decimal.Round` com um `MidpointRounding`).
- Formatar ou fazer parsing dentro da consulta (`DateTime.ToString("yyyy-MM-dd")`, `int.Parse`, `Guid.Parse`).
- Navegar ou chamar um tipo que o provedor não consegue mapear (uma propriedade calculada respaldada por lógica C#, não por uma coluna mapeada).
- Comparar contra uma construção que o provedor não suporta para o seu banco de dados (certa aritmética de `TimeSpan`, algumas APIs baseadas em `Span`).

## Reprodução mínima

Aqui está o menor programa que reproduz isso. A comparação sem diferenciar maiúsculas com uma sobrecarga de `StringComparison` é a causa mais comum do mundo real, porque se lê perfeitamente em C# e é completamente não traduzível:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();

string name = "acme";

// Throws at ToListAsync: StringComparison has no SQL translation.
var orders = await db.Orders
    .Where(o => o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
    .ToListAsync();

public class Order
{
    public int Id { get; set; }
    public string CustomerName { get; set; } = "";
    public DateTime PlacedOn { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

A chamada `Equals(name, StringComparison.OrdinalIgnoreCase)` é o problema. O EF Core não tem como expressar "ordinal, sem diferenciar maiúsculas" como SQL, porque a diferenciação de maiúsculas em SQL é governada pela collation da coluna, não por um argumento de método. Então ele lança a exceção.

## Solução, em detalhe

As soluções estão ordenadas da melhor (deixar o trabalho no servidor) até a de último recurso (trazer os dados para a memória de propósito).

### 1. Reescreva o predicado com operadores traduzíveis

Noventa por cento das vezes a solução é expressar a mesma intenção usando operadores que o EF Core conhece. Para comparação sem diferenciar maiúsculas, descarte a sobrecarga de `StringComparison` por completo. No SQL Server a collation padrão já não diferencia maiúsculas, então um simples `==` faz o que você quer e se traduz em um `WHERE` limpo:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] = @name
var orders = await db.Orders
    .Where(o => o.CustomerName == name)
    .ToListAsync();
```

Se você precisa de comparação sem diferenciar maiúsculas independentemente da collation da coluna, use `EF.Functions.Collate` para fixar a comparação em uma collation que não diferencia maiúsculas, que o provedor traduz em uma cláusula `COLLATE`:

```csharp
// .NET 11, EF Core 11 -- explicit case-insensitive comparison in SQL
var orders = await db.Orders
    .Where(o => EF.Functions.Collate(o.CustomerName, "SQL_Latin1_General_CP1_CI_AS") == name)
    .ToListAsync();
```

A superfície `EF.Functions` existe justamente para isso: `Like`, `Collate`, `DateDiffDay`, `Contains` (full-text), `Random` e helpers específicos do provedor te dão construções SQL que o C# puro não consegue expressar. Recorra a ela antes de desistir da avaliação no servidor. Para correspondência de substring, prefira `Contains`, `StartsWith` e `EndsWith`, que se traduzem em `LIKE`:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] LIKE @p + '%'
var orders = await db.Orders
    .Where(o => o.CustomerName.StartsWith(name))
    .ToListAsync();
```

### 2. Calcule o valor antes da consulta, não dentro dela

Uma grande fatia desses erros é autoinfligida: você chama um método dentro da consulta cujo resultado na verdade não depende da linha. Suba-o para uma variável local e o EF Core o converte em um parâmetro:

```csharp
// Throws: ToString() on a DateTime cannot be translated
var bad = await db.Orders
    .Where(o => o.PlacedOn.ToString("yyyy") == "2026")
    .ToListAsync();

// Fixed: compare the mapped column directly, no formatting in SQL
var year = 2026;
var good = await db.Orders
    .Where(o => o.PlacedOn.Year == year)
    .ToListAsync();
```

`DateTime.Year`, `Month`, `Day`, `Date` e afins de fato se traduzem (para `DATEPART` no SQL Server), enquanto `ToString(format)` não. A regra prática: extraia o dado de que você precisa com uma propriedade que o EF consiga mapear, em vez de formatar o valor inteiro em uma string e comparar sobre ela.

### 3. Mova a lógica só-cliente para a projeção de nível superior

Lembre-se de que o EF Core permite avaliação no cliente no último `Select`. Se o seu método não traduzível é na verdade sobre moldar a saída, não filtrar, mova-o para lá. Esta consulta filtra e ordena em SQL, e depois roda o helper de C# apenas nas linhas que voltaram:

```csharp
// .NET 11, EF Core 11 -- filter in SQL, format on the client in the projection
var rows = await db.Orders
    .Where(o => o.PlacedOn.Year == 2026)      // server
    .OrderByDescending(o => o.PlacedOn)        // server
    .Select(o => new
    {
        o.Id,
        Display = FormatCustomer(o.CustomerName) // client, allowed here
    })
    .ToListAsync();

static string FormatCustomer(string raw) => raw.Trim().ToUpperInvariant();
```

`FormatCustomer` lançaria a exceção em um `Where`, mas no `Select` final é legal e roda em memória sobre o conjunto de resultados já filtrado. Esta é a forma sancionada de combinar a filtragem em SQL com a formatação em C#.

### 4. Force a avaliação no cliente de propósito (último recurso)

Se a lógica realmente não pode rodar em SQL e precisa ficar em um `Where`, opte pela avaliação no cliente de forma explícita quebrando a consulta com `AsEnumerable` ou `AsAsyncEnumerable`. Tudo antes da quebra roda no servidor; tudo depois roda em memória:

```csharp
// .NET 11, EF Core 11 -- narrow in SQL first, then filter in memory
var orders = db.Orders
    .Where(o => o.PlacedOn.Year == 2026)   // runs in SQL, cuts the row count down
    .AsAsyncEnumerable();                    // boundary: client evaluation from here

var matched = new List<Order>();
await foreach (var o in orders)
{
    if (o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
        matched.Add(o);
}
```

O detalhe crítico é colocar o máximo de filtragem possível antes do limite `AsEnumerable` para transferir o menor número de linhas. Chamar `AsEnumerable()` sobre um `DbSet` cru e filtrar depois baixa a tabela inteira, que é exatamente o desastre do qual a exceção estava te protegendo. Prefira `AsAsyncEnumerable` a `ToList` aqui para transmitir em fluxo em vez de acumular o resultado intermediário.

## Pegadinhas e variantes

**Funcionava no EF Core 2.2 e quebrou na atualização.** A avaliação no cliente em qualquer lugar foi removida no EF Core 3.0. Uma consulta que "funcionava" antes provavelmente filtrava em memória o tempo todo. A atualização não quebrou a sua consulta, ela expôs um problema de desempenho latente. Se você está migrando entre versões maiores, vale a pena ler as [mudanças que quebram e que de fato mordem ao migrar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) antes de começar.

**O provedor em memória não lança a exceção, o real lança.** Se seus testes unitários usam o provedor em memória, eles avaliam tudo no cliente e nunca veem este erro, e então produção contra SQL Server ou PostgreSQL lança a exceção com a mesma consulta. Teste contra um provedor que traduza. Rodar sua suíte contra um banco de dados real com algo como Testcontainers pega esses casos antes que eles vão para produção.

**Um `GroupBy` que projeta para algo que o SQL não consegue agregar.** Um `GroupBy` seguido de um `Select` que devolve entidades agrupadas cruas (em vez de agregados como `Count`, `Sum`, `Max`) frequentemente não pode ser traduzido. Remodele a projeção em agregados escalares, ou agrupe no cliente após materializar.

**Propriedades de navegação e membros calculados não mapeados.** Filtrar sobre uma propriedade calculada de C# (um getter com lógica, não uma coluna mapeada) não pode ser traduzido, porque não há coluna por trás. Mapeie uma coluna persistida/calculada, ou filtre sobre as colunas subjacentes.

**`Contains` sobre uma lista local grande.** `Where(o => ids.Contains(o.Id))` de fato se traduz (para `IN` ou um parâmetro com valores de tabela no EF Core 11), mas um "could not be translated" relacionado pode aparecer quando o tipo do elemento é complexo. Mantenha o argumento de `Contains` como uma lista simples de escalares.

**Um erro diferente, o mesmo gatilho.** Se você vê `The LINQ expression could not be translated` e logo abaixo uma nota sobre `AsSplitQuery`, você está batendo em um limite de tradução em uma consulta com múltiplos includes de coleções, não em um problema de avaliação no cliente. Esse é sobre explosão cartesiana, e a solução é a [divisão de consultas para evitar uma explosão cartesiana no EF Core 11](/pt-br/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), não reescrever um predicado.

O modelo mental que te mantém fora deste erro para sempre: tudo exceto o `Select` final tem que virar SQL. Antes de escrever um `Where`, pergunte se o banco de dados conseguiria executá-lo. Se a resposta envolve um método de C# do qual o banco de dados nunca ouviu falar, ou encontre o equivalente em `EF.Functions`, precalcule o valor, ou aceite que você está trazendo linhas para a memória e diga isso explicitamente com `AsAsyncEnumerable`.

## Relacionado

- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) cobre a outra armadilha silenciosa de desempenho de consultas que sobrevive ao bloqueio da avaliação no cliente.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution no EF Core 11](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) vale a leitura quando suas consultas de leitura se traduzem de forma limpa e você quer que fiquem mais rápidas.
- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) mostra como manter os predicados JSON no servidor em vez de materializar e filtrar.
- [Como usar consultas compiladas com o EF Core para caminhos críticos](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) ajuda quando sua consulta já é traduzível e você está ajustando o desempenho.
- [Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) é o equivalente do lado da escrita de manter o trabalho no banco de dados em vez de na memória.

## Fontes

- [Avaliação no cliente vs. servidor, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [Como as consultas funcionam, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/querying/how-query-works)
- [Funções de banco de dados e EF.Functions, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions)
- [dotnet/efcore issue #24318: "could not be translated" com o provedor em memória](https://github.com/dotnet/efcore/issues/24318)
