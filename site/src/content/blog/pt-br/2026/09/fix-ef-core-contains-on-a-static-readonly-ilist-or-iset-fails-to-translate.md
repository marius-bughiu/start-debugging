---
title: "Correção: EF Core `Contains` em um `IList<T>` ou `ISet<T>` static readonly não pôde ser traduzido"
description: "O EF Core 8, 9 e 10 falham ao traduzir Contains quando a lista é um campo static readonly do tipo IList, ICollection, ISet ou IReadOnlySet. Chame Enumerable.Contains explicitamente ou atualize para o EF Core 11."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "pt-br"
translationOf: "2026/09/fix-ef-core-contains-on-a-static-readonly-ilist-or-iset-fails-to-translate"
translatedBy: "claude"
translationDate: 2026-09-29
---

Se `Where(x => AllowedCodes.Contains(x.Code))` lança `The LINQ expression ... could not be translated` com `Translation of method 'System.Linq.Enumerable.Contains' failed`, olhe como `AllowedCodes` está declarado. Quase certamente é um campo `static readonly` do tipo `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>`, `IImmutableSet<T>` ou `FrozenSet<T>`. A correção mais rápida, que mantém o mesmo SQL, é chamar o operador LINQ explicitamente: `Enumerable.Contains(AllowedCodes, x.Code)`. A correção de verdade é o EF Core 11, em que dotnet/efcore#36757 corrigiu a verificação de query root que rejeita esses formatos. Medi todas as variantes abaixo com `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21, 9.0.19, 10.0.12 e 11.0.0-rc.1.26425.128. Os três primeiros falham da mesma forma. O EF Core 11 RC 1 traduz todas elas.

## O erro em contexto

Aqui está a exceção do EF Core 10.0.12 no .NET 10 para um `static readonly IList<string>`:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => (IList<string>)List<string> { "Open", "Pending" }
        .Contains(o.Status))' could not be translated. Additional information: Translation of method 'System.Linq.Enumerable.Contains' failed. If this method can be mapped to your custom function, see https://go.microsoft.com/fwlink/?linkid=2132413 for more information. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
   at Microsoft.EntityFrameworkCore.Query.QueryableMethodTranslatingExpressionVisitor.Translate(Expression expression)
   at Microsoft.EntityFrameworkCore.Query.QueryCompilationContext.CreateQueryExecutorExpression[TResult](Expression query)
```

Há duas pistas nessa mensagem. A primeira é o cast. A coleção aparece como `(IList<string>)List<string> { "Open", "Pending" }`, o que significa que o EF já avaliou seu campo até chegar ao valor, uma constante, e o envolveu em um cast de volta ao tipo declarado. A segunda é o nome do método. Você escreveu `IList<T>.Contains`, um método de instância, mas a mensagem cita `Enumerable.Contains`. O EF reescreve chamadas a `ICollection<T>.Contains` para o operador LINQ antes de traduzi-las. Portanto o método não é o problema. O problema é o argumento que o EF passa para ele.

Quando o campo é do tipo `IReadOnlySet<T>` ou `IImmutableSet<T>`, o nome do método na mensagem muda para `System.Collections.Generic.IReadOnlySet<string>.Contains` ou `System.Collections.Immutable.IImmutableSet<string>.Contains`. Essas interfaces não herdam de `ICollection<T>`, então o EF nunca reescreve a chamada. É o mesmo bug com outra mensagem.

## Por que um campo static readonly quebra e uma variável local não

São duas etapas, e o bug só aparece quando ambas acontecem.

**Etapa 1: o EF incorpora campos `static readonly` como constantes.** Antes da tradução, o funcletizer do EF percorre a consulta e avalia tudo o que não depende do banco de dados. Variáveis locais capturadas, campos de instância e propriedades static viram parâmetros da consulta. Um campo static que é `readonly` (`FieldInfo.IsInitOnly`) é tratado como um valor que não pode mudar, então o EF o avalia uma vez e o incorpora como constante. No EF Core 10 você pode ver isso em [`ExpressionTreeFuncletizer.VisitMember`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs): o membro static é marcado como variável capturada "unless the captured variable is init-only". Quando o EF constrói essa constante, ele a tipa pelo tipo em runtime do valor (`List<string>`) e depois adiciona um nó `Convert` de volta ao tipo declarado (`IList<string>`) sempre que os dois diferem.

**Etapa 2: a verificação de query root só remove um tipo de cast.** Para traduzir `Contains` sobre uma coleção em memória, o EF transforma a coleção em uma query root inline e depois em `IN (...)`. No EF Core 8, 9 e 10, [`QueryRootProcessor.VisitQueryRootCandidate`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) desembrulha um `Convert` somente quando o tipo de destino é exatamente `IEnumerable<T>`:

```csharp
// EF Core 10.0.x, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.GetGenericTypeDefinition() == typeof(IEnumerable<>))
{
    candidateExpression = convertExpression.Operand;
}
```

Um `Convert` para `IList<string>` não corresponde, então a coleção nunca é reconhecida como query root e o `Contains` cai em "could not be translated".

Com isso em mente, o padrão de sucesso e falha faz sentido:

- Campos `List<T>`, `HashSet<T>` e `T[]` funcionam porque o tipo declarado é igual ao tipo em runtime. O EF não adiciona `Convert`.
- Campos `IEnumerable<T>`, `IReadOnlyList<T>` e `IReadOnlyCollection<T>` funcionam porque nenhum deles declara seu próprio `Contains`. A chamada é resolvida para `Enumerable.Contains`, o compilador converte o argumento para `IEnumerable<T>`, e a constante que o EF produz recebe cast para `IEnumerable<T>`, o único formato que a verificação antiga aceita.
- `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>` e `IImmutableSet<T>` falham porque declaram `Contains`. O C# prefere o método de instância à extensão, então o cast permanece no tipo da interface.
- `FrozenSet<T>` falha mesmo sendo uma classe concreta, porque ela é abstrata. O valor em runtime é uma subclasse interna, o que novamente produz um `Convert`. Esse foi o caso relatado em dotnet/efcore#36496, e o PR que o corrigiu corrigiu as interfaces também.
- Uma variável local capturada, um campo static não readonly e uma propriedade static funcionam porque viram parâmetros, não constantes, e o caminho de parâmetros nunca teve esse bug.

Isso não é uma regressão. O relato original da variante com `IReadOnlySet<T>` remonta ao EF Core 7, e dotnet/efcore#38839 o reproduz do 7.0.20 ao 10.0.11.

## Repro mínimo

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
db.Database.EnsureDeleted();
db.Database.EnsureCreated();
db.Orders.AddRange(
    new Order { Status = "Open" },
    new Order { Status = "Pending" },
    new Order { Status = "Shipped" });
db.SaveChanges();

// Throws InvalidOperationException on EF Core 8, 9 and 10
var active = db.Orders
    .Where(o => OrderRules.ActiveStatuses.Contains(o.Status))
    .ToList();

Console.WriteLine(active.Count);

public static class OrderRules
{
    public static readonly IList<string> ActiveStatuses = new List<string> { "Open", "Pending" };
}

public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=shop.db");
}
```

Troque `IList<string>` por `List<string>`, remova `readonly` ou transforme o campo em uma propriedade `{ get; }`, e a mesma consulta funciona. Geralmente é assim que as pessoas descobrem o bug: uma revisão de código sugere "exponha a interface, não o tipo concreto" ou "deixe esse campo readonly", e uma consulta que funcionava havia meses quebra.

## O que cada declaração faz no EF Core 8, 9, 10 e 11

Executei uma sonda por formato contra o SQLite em cada versão do EF. Os pacotes do EF Core 8 e 9 rodaram no runtime do .NET 10. O EF Core 11 RC 1 rodou no .NET 11 RC 1. "Constant" significa que o EF incorporou os valores no SQL. "Parameter" significa que ele os enviou como parâmetros.

| Declaração | EF 8.0.21 | EF 9.0.19 | EF 10.0.12 | EF 11 RC 1 |
|---|---|---|---|---|
| `static readonly IList<T>` | falha | falha | falha | constant |
| `static readonly ICollection<T>` | falha | falha | falha | constant |
| `static readonly ISet<T>` | falha | falha | falha | constant |
| `static readonly IReadOnlySet<T>` | falha | falha | falha | constant |
| `static readonly IImmutableSet<T>` | falha | falha | falha | constant |
| `static readonly FrozenSet<T>` | falha | falha | falha | constant |
| `static readonly IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `IEnumerable<T>` | constant | constant | constant | constant |
| `static readonly List<T>`, `HashSet<T>`, `T[]` | constant | constant | constant | constant |
| `static IList<T>` (não readonly) ou propriedade static | parameter | parameter | parameter | parameter |
| `IList<T>` local capturado | parameter | parameter | parameter | parameter |
| `EF.Constant(localIList).Contains(...)` | falha | constant | constant | constant |

A última linha é um caso parecido que vale conhecer. No EF Core 8, forçar um `IList<T>` local a virar constante com `EF.Constant` cai no mesmo bug. A partir do EF Core 9, `EF.Constant` passa por outro caminho e funciona.

## As correções, em ordem de preferência

### 1. Atualizar para o EF Core 11

A correção é [dotnet/efcore#36757](https://github.com/dotnet/efcore/pull/36757), mesclada em `main` em 2025-09-24 e lançada no EF Core 11. Ela muda a verificação para desembrulhar qualquer `Convert` cujo destino seja atribuível a `IEnumerable`, e faz isso de forma recursiva:

```csharp
// EF Core 11.0, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.IsAssignableTo(typeof(IEnumerable)))
{
    return VisitQueryRootCandidate(convertExpression.Operand, elementClrType);
}
```

Não houve backport. O branch `release/10.0` ainda tem a comparação com `typeof(IEnumerable<>)`, e o 10.0.12 continua falhando. dotnet/efcore#35024 (o relato de `IList`/`ICollection`) está no milestone 11.0.0, e #38839 foi fechado como duplicata dele. Se você está no EF Core 10 LTS, planeje usar uma das reescritas abaixo até migrar para o 11.

### 2. Chamar `Enumerable.Contains` explicitamente

Esta é a correção de uma linha que recomendo no EF Core 8, 9 e 10, porque mantém exatamente o SQL que você obteria no EF Core 11:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var active = db.Orders
    .Where(o => Enumerable.Contains(OrderRules.ActiveStatuses, o.Status))
    .ToList();

// WHERE "o"."Status" IN ('Open', 'Pending')
```

Chamar o método static diretamente faz o compilador converter o campo para `IEnumerable<string>`, então a constante do EF chega com cast para `IEnumerable<T>` e passa pela verificação antiga. Funcionou nos seis formatos que falham nas minhas execuções, incluindo `IReadOnlySet<T>` e `IImmutableSet<T>`. `OrderRules.ActiveStatuses.AsEnumerable().Contains(o.Status)` faz o mesmo se você preferir a sintaxe de método. `OrderRules.ActiveStatuses.Any(s => s == o.Status)` também é traduzido para a mesma lista `IN`, mas é pior de ler e eu não o usaria apenas para contornar esse problema.

Uma contrapartida: em um `ISet<T>` ou `FrozenSet<T>`, `Enumerable.Contains` em LINQ to Objects puro deixaria de usar a busca por hash. Dentro de uma consulta do EF isso não importa, porque a chamada nunca é executada no .NET. Ela apenas descreve o SQL.

### 3. Mudar o tipo declarado

Se a coleção é usada apenas em consultas, declare-a como `IReadOnlyCollection<T>`, `IReadOnlyList<T>` ou um array. Os três são somente leitura e os três são traduzidos em todas as versões:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore 10.0.12
public static class OrderRules
{
    public static readonly IReadOnlyList<string> ActiveStatuses = ["Open", "Pending"];
}
```

Não troque para `FrozenSet<T>` para obter imutabilidade "de verdade". No EF Core 8 a 10 ele falha pelo motivo descrito acima.

### 4. Deixar o EF parametrizar os valores

Copiar o campo para uma variável local, ou transformá-lo em uma propriedade `static`, faz o EF enviar os valores como parâmetros em vez de constantes:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var statuses = OrderRules.ActiveStatuses;
var active = db.Orders.Where(o => statuses.Contains(o.Status)).ToList();

// EF Core 10: WHERE "o"."Status" IN (@statuses1, @statuses2)
// EF Core 8/9 on SQLite: WHERE "o"."Status" IN (SELECT "s"."value" FROM json_each(@__statuses_0) AS "s")
```

Isso funciona, mas muda o SQL. Lembre por que o caminho da constante existe: os valores nunca mudam, então incorporá-los dá ao banco de dados uma lista literal fixa, que é o melhor formato para uso de índices e cache de planos. Para uma lista curta de códigos de status, constantes geram o SQL melhor. Use esta opção quando a lista realmente puder mudar em runtime, e não apenas para contornar o bug de tradução. Se quiser ver o que o EF gera em cada caso, [registre em log o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) antes e depois da mudança.

## Variantes que chegam a esta página por engano

- **`Translation of method 'System.MemoryExtensions.Contains' failed`** em um array após migrar para o C# 14. Essa é a mudança de resolução de sobrecarga de span de primeira classe, não este bug. Veja [a correção da resolução de sobrecarga com spans no C# 14](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).
- **Um "could not be translated" genérico em um método que você mesmo escreveu**, como `ids.HasItem(x.Id)`. O EF não enxerga o interior do seu método, seja qual for o tipo de coleção. As causas gerais e as reescritas estão em [a LINQ expression could not be translated no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), e a forma de reutilizar lógica de predicado com segurança está em [como escrever predicados LINQ reutilizáveis que o EF Core consegue traduzir](/pt-br/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**. Isso acontece quando o funcletizer executa o getter do seu campo ou propriedade e o getter lança uma exceção. Falha na mesma etapa, mas por outro motivo. Veja [a correção da avaliação da parameter expression](/pt-br/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).
- **O mesmo `static readonly IList<T>` dentro de uma consulta compilada** (`EF.CompileQuery`). As consultas compiladas passam pelas mesmas etapas de funcletizer e query root. Confirmei que elas falham da mesma forma no EF Core 10.0.12, e `Enumerable.Contains` também as corrige. Veja [como usar consultas compiladas em caminhos críticos](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Relacionados

- [Correção: The LINQ expression could not be translated no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Como escrever predicados LINQ reutilizáveis que o EF Core consegue traduzir](/pt-br/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)
- [Como registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Correção da breaking change de resolução de sobrecarga com spans no C# 14](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)
- [Como usar consultas compiladas com o EF Core em caminhos críticos](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Fontes

- [dotnet/efcore#35024: Query could not be translated when using a static ICollection/IList field](https://github.com/dotnet/efcore/issues/35024), milestone 11.0.0.
- [dotnet/efcore#38839: Contains on a constant collection fails when declared as ICollection/IList/ISet/IReadOnlySet/IImmutableSet](https://github.com/dotnet/efcore/issues/38839), fechado como duplicata, com uma matriz de versões do 7.0.20 ao 10.0.11.
- [dotnet/efcore#36757: Fix handling of readonly fields using abstract classes (i.e. FrozenSet) in parameters for primitive collections](https://github.com/dotnet/efcore/pull/36757), a correção, mesclada em 2025-09-24.
- [`QueryRootProcessor.cs` em `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) e [`ExpressionTreeFuncletizer.cs` em `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs).
- [What's new in EF Core 10: improved translation for parameterized collections](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection).
