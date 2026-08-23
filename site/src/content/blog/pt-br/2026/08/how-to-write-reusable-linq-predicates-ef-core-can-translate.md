---
title: "Como escrever predicados LINQ reutilizáveis que o EF Core consegue traduzir em Where, Select e OrderBy"
description: "Um método auxiliar que retorna bool lança \"could not be translated\". Um Expression<Func<T, bool>> não. Veja como compor, aninhar e reutilizar árvores de expressão no EF Core 11 sem LINQKit, com o SQL real de cada caso."
pubDate: 2026-08-23
tags:
  - "ef-core"
  - "linq"
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate"
translatedBy: "claude"
translationDate: 2026-08-23
---

A regra é curta: o EF Core só consegue traduzir aquilo que ainda é uma árvore de expressão quando chega ao provider. Um método auxiliar `static bool IsActive(Customer c)` compila para um nó de chamada de método e lança em tempo de execução; a mesma lógica guardada como `static readonly Expression<Func<Customer, bool>> IsActive` traduz sem problema e pode ser composta, aninhada e religada a outros tipos de entidade. O que a maioria dos guias erra é dizer que você precisa do `AsExpandable()` do LINQKit para compor essas árvores. Você não precisa: `Expression.Invoke` traduz desde o EF Core 3.1, e cada trecho de SQL abaixo saiu do EF Core 11.0.0-preview.7.26381.103 com o provider do SQL Server via `ToQueryString()`.

## Por que o método auxiliar bool lança e a expressão não

Comece pelo formato que quase todo mundo escreve primeiro, porque ele lê bem:

```csharp
// EF Core 11.0.0-preview.7, C# 14
static bool IsActiveMethod(Customer c) => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(c => IsActiveMethod(c));
```

O compilador de C# transforma essa lambda em uma árvore de expressão cujo corpo é um `MethodCallExpression` apontando para `IsActiveMethod`. O EF Core não tem como olhar dentro do corpo de um método compilado, então a tradução para:

```
System.InvalidOperationException
The LINQ expression 'DbSet<Customer>()
    .Where(c => Helpers.IsActiveMethod(c))' could not be translated. Either rewrite
the query in a form that can be translated, or switch to client evaluation explicitly
by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'.
```

Esse é o comportamento documentado: o EF Core suporta avaliação parcial no cliente apenas na projeção de nível superior, e lança para qualquer coisa não traduzível no resto da consulta, conforme a [orientação sobre avaliação no cliente versus no servidor](https://learn.microsoft.com/en-us/ef/core/querying/client-eval). Se você já esbarrou nisso em outros formatos, a lista completa de triagem está [no artigo sobre "The LINQ expression could not be translated"](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Guarde a mesma lógica como expressão e nada muda no ponto de chamada:

```csharp
static readonly Expression<Func<Customer, bool>> IsActive =
    c => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(IsActive);
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
```

`Queryable.Where` recebe `Expression<Func<T, bool>>`, então passar o campo diretamente entrega ao EF a árvore inteira. O mesmo vale quando o predicado chega como parâmetro de um método, que é a base de toda abstração no estilo specification:

```csharp
static IQueryable<Customer> Filter(IQueryable<Customer> q, Expression<Func<Customer, bool>> p)
    => q.Where(p);
```

Isso produziu o mesmo SQL no teste. No momento em que o predicado vira um `Func<>` em vez de um `Expression<Func<>>`, você volta para a exceção.

## Compondo predicados: Expression.Invoke traduz no EF Core 11

O caso interessante é combinar dois predicados escritos de forma independente. A tentativa óbvia falha:

```csharp
db.Customers.Where(c => IsActive.Compile()(c) && c.Country == "NL");
```

```
The LINQ expression 'DbSet<Customer>()
    .Where(c => Invoke(Func<Customer, bool>, c) && c.Country == "NL")'
could not be translated.
```

`Compile()` roda na montagem da consulta e deixa uma constante `Func<Customer, bool>` dentro da árvore. O EF vê um delegate opaco e desiste. É essa falha que empurra as pessoas para o LINQKit.

Mas construir a invocação como nó de expressão, em vez de chamada de delegate, funciona hoje:

```csharp
static Expression<Func<T, bool>> And<T>(
    Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = Expression.Parameter(typeof(T), "x");
    return Expression.Lambda<Func<T, bool>>(
        Expression.AndAlso(Expression.Invoke(a, p), Expression.Invoke(b, p)), p);
}

static Expression<Func<Customer, bool>> InCountry(string country) => c => c.Country == country;

db.Customers.Where(And(IsActive, InCountry("NL")));
```

```sql
DECLARE @c nvarchar(4000) = N'NL';

SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId]) AND [c].[Country] = @c
```

Sem `AsExpandable()`, sem pacote extra. O pipeline de consultas do EF Core reduz os nós `InvocationExpression` antes da tradução. A regressão que quebrou isso no EF Core 3.0 foi registrada como [dotnet/efcore#17791](https://github.com/dotnet/efcore/issues/17791) e corrigida na 3.1, mas muito conselho na web ainda é anterior à correção.

Dois detalhes que vale conhecer sobre esse helper `And`. Primeiro, uma semente `true` ou `false`, aquilo de que o `PredicateBuilder` parte, não custa nada: `And<Customer>(c => true, InCountry("NL"))` e `Or<Customer>(c => false, InCountry("NL"))` emitiram exatamente o `WHERE [c].[Country] = @c` acima, sem resíduo `1 = 1`. O simplificador de expressões do EF dobra a constante, então você pode escrever o laço acumulador de forma ingênua.

Segundo, `Expression.Invoke` não é sua única opção. Religar os parâmetros com um `ExpressionVisitor` produz uma árvore mais plana:

```csharp
sealed class Rebind(ParameterExpression from, Expression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node)
        => node == from ? to : base.VisitParameter(node);
}

public static Expression<Func<T, bool>> And<T>(
    this Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = a.Parameters[0];
    var right = new Rebind(b.Parameters[0], p).Visit(b.Body)!;
    return Expression.Lambda<Func<T, bool>>(Expression.AndAlso(a.Body, right), p);
}
```

As duas versões geraram SQL idêntico byte a byte no teste. Prefira o visitor quando quiser inspecionar ou continuar transformando a árvore combinada por conta própria, já que não há uma camada de invocação no caminho. Prefira `Expression.Invoke` quando quiser doze linhas a menos.

## Religando um predicado para outro tipo de entidade

O visitor se paga assim que você quer aplicar um predicado de `Customer` a uma consulta de `Order`. Aqui você não está compondo dois predicados sobre o mesmo parâmetro, está substituindo o parâmetro por um caminho de membros:

```csharp
public static Expression<Func<TOuter, bool>> On<TOuter, TInner>(
    this Expression<Func<TInner, bool>> inner,
    Expression<Func<TOuter, TInner>> path)
{
    var body = new Rebind(inner.Parameters[0], path.Body).Visit(inner.Body)!;
    return Expression.Lambda<Func<TOuter, bool>>(body, path.Parameters[0]);
}

db.Orders.Where(IsActive.On((Order o) => o.Customer));
```

```sql
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
```

Uma única definição de "cliente ativo", aplicada nas duas direções, com o join escrito para você. Se a regra parece mais um filtro permanente do que um bloco reutilizável, avalie se ela pertence a [um filtro de consulta nomeado](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/), para que quem chama não possa esquecê-la.

## Projeções reutilizáveis em Select

Projeções seguem a mesma regra, com um modo de falha extra. Passar a expressão direto para o `Select` funciona:

```csharp
static readonly Expression<Func<Customer, CustomerDto>> ToDto =
    c => new CustomerDto(c.Id, c.Name, c.Orders.Count);

db.Customers.Select(ToDto);
```

```sql
SELECT [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
FROM [Customers] AS [c]
```

Aninhá-la dentro de uma projeção maior com `Compile()` não funciona, e a exceção é diferente da do `Where` porque projeções permitem avaliação parcial no cliente:

```csharp
db.Orders.Select(o => new { o.Id, Cust = ToDto.Compile()(o.Customer) });
```

```
System.InvalidOperationException
The client projection contains a reference to a constant expression of
'System.Func<Customer, CustomerDto>'. This could potentially cause a memory leak;
consider assigning this constant to a local variable and using the variable in the
query instead.
```

Isso é o EF avisando que o plano de consulta compilado capturaria seu delegate para sempre. Construa o aninhamento como nó de expressão e ele traduz:

```csharp
var p = Expression.Parameter(typeof(Order), "o");
var ctor = typeof(OrderDto).GetConstructor([typeof(int), typeof(CustomerDto)])!;
var body = Expression.New(ctor,
    Expression.Property(p, nameof(Order.Id)),
    Expression.Invoke(ToDto, Expression.Property(p, nameof(Order.Customer))));

db.Orders.Select(Expression.Lambda<Func<Order, OrderDto>>(body, p));
```

```sql
SELECT [o].[Id], [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

O idioma `Expression.Invoke(ToDto, memberPath)` é o truque inteiro: ele aplica uma lambda reutilizável a uma subexpressão em vez do parâmetro raiz.

## Aplicando um predicado reutilizável dentro de uma navegação com AsQueryable()

`ICollection<T>.Any(Func<T, bool>)` é a sobrecarga de `IEnumerable`, então passar uma expressão guardada para uma propriedade de navegação não compila, e passar um método bool compila mas não traduz:

```csharp
db.Customers.Where(c => c.Orders.Any(o => IsBigOrderMethod(o)));
// InvalidOperationException: ... .Any(o => Helpers.IsBigOrderMethod(o))' could not be translated
```

Insira `AsQueryable()` e você recebe a sobrecarga de `Queryable`, que aceita uma expressão:

```csharp
static readonly Expression<Func<Order, bool>> IsBigOrder = o => o.Total > 1000m;

db.Customers.Where(c => c.Orders.AsQueryable().Any(IsBigOrder));
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId] AND [o].[Total] > 1000.0)
```

`AsQueryable()` sobre uma navegação é de graça dentro de uma árvore de consulta: o EF o remove durante a tradução. O mesmo truque vale para `All`, `Count` e `Select` sobre a coleção. `All(IsBigOrder)` traduziu para `NOT EXISTS (... AND [o].[Total] <= 1000.0)`, `Count(IsBigOrder)` para um `COUNT(*)` correlacionado com filtro, e `Select(OrderDtoExpr).ToList()` para um `LEFT JOIN` com um `ORDER BY [c].[Id]` para o shaper da coleção.

## Chaves de ordenação como parâmetros, incluindo o caso do boxing

Ordenação é onde reutilizar normalmente significa "a coluna vem de uma query string". `Queryable.OrderBy` é genérico sobre o tipo da chave, então um helper de passagem mantém a chave fortemente tipada:

```csharp
public static IOrderedQueryable<T> OrderByKey<T, TKey>(
    this IQueryable<T> q, Expression<Func<T, TKey>> key) => q.OrderBy(key);

static readonly Dictionary<string, Expression<Func<Customer, string>>> SortKeys = new()
{
    ["name"] = c => c.Name,
    ["country"] = c => c.Country,
};

db.Customers.OrderByKey(SortKeys["name"]);   // ORDER BY [c].[Name]
```

Se as colunas tiverem tipos CLR diferentes você vai se sentir tentado a usar `Expression<Func<T, object>>`, que força um nó `Convert(c.Id, Object)` para tipos por valor. O EF Core 11 lida com isso:

```csharp
Expression<Func<Customer, object>> key = c => c.Id;
db.Customers.OrderBy(key);   // ORDER BY [c].[Id]
```

A conversão de boxing é removida durante a tradução. Ainda assim vale evitar, porque chaves `object` aceitam em silêncio coisas que não vão traduzir e você perde a verificação em tempo de compilação sobre o tipo da chave. Um `Dictionary<string, Expression<Func<T, TKey>>>` por tipo de chave, ou um switch pequeno que chama `OrderByKey` com o argumento genérico certo, torna o erro impossível. Se a ordenação alimenta um endpoint paginado, note que uma ordem estável é requisito obrigatório para [paginação por keyset](/pt-br/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).

## A armadilha do Expression.Constant que embute seus parâmetros

Esse é o bug que só aparece em produção, e só no cache de planos de consulta. Quando você escreve uma fábrica como lambda, o argumento capturado vira um campo de closure e o EF o parametriza:

```csharp
static Expression<Func<Customer, bool>> InCountry(string c) => x => x.Country == c;
// WHERE [c].[Country] = @c   with DECLARE @c nvarchar(4000) = N'NL';
```

Quando você monta a mesma árvore na mão, o natural é escrever `Expression.Constant(c)`, e o EF emite fielmente um literal:

```csharp
var body = Expression.Equal(
    Expression.Property(p, nameof(Customer.Country)),
    Expression.Constant(c));       // <- inlined, not parameterized
// WHERE [c].[Country] = N'NL'
```

Agora cada país distinto produz uma string SQL distinta, uma entrada distinta no cache de consultas do EF e um plano distinto no SQL Server. Em um construtor de filtros dinâmico isso é uma inundação do cache de planos. Duas correções, ambas verificadas contra o EF Core 11:

```csharp
// 1. EF.Parameter<T>, added in EF Core 9, forces parameterization of a constant
var efParameter = typeof(EF).GetMethod(nameof(EF.Parameter))!.MakeGenericMethod(typeof(string));
var value = Expression.Call(efParameter, Expression.Constant(c));
// WHERE [c].[Country] = @p

// 2. read the value through a field on a captured object, exactly like a compiler closure
sealed class Box { public string? Value; }
var value = Expression.Field(Expression.Constant(new Box { Value = c }), nameof(Box.Value));
// WHERE [c].[Country] = @Value
```

`EF.Constant<T>` (EF Core 8.0.2) faz o oposto quando você realmente quer o literal, por exemplo para o otimizador enxergar um valor seletivo. O par está documentado nas [novidades do EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew). Quando não souber de que lado você caiu, a checagem mais rápida é [registrar o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) e procurar por `DECLARE @`.

## Compile() fica fora da consulta, e é caro

O único uso legítimo de `Compile()` é rodar o mesmo predicado contra objetos em memória, por exemplo para validar uma mudança antes de salvar. Compilar não é barato. Em um laço `Stopwatch` aquecido no .NET 11.0.100-preview.7 (medições grosseiras de laço, não BenchmarkDotNet), chamar `pred.Compile()(customer)` custou cerca de 47,7 microssegundos por operação, enquanto invocar um delegate compilado uma única vez custou cerca de 2,7 nanossegundos. Os números exatos vão mudar no seu hardware; as quatro ordens de grandeza não. Guarde o delegate em cache ao lado da expressão:

```csharp
public static class CustomerRules
{
    public static readonly Expression<Func<Customer, bool>> IsActive =
        c => !c.IsDeleted && c.Orders.Count > 0;

    public static readonly Func<Customer, bool> IsActiveFunc = IsActive.Compile();
}
```

Use `IsActive` para `IQueryable<Customer>` e `IsActiveFunc` para qualquer coisa que já esteja em memória. Essa separação é a versão prática da fronteira entre `IEnumerable` e `IQueryable` descrita em [como escolher o tipo de retorno certo](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), e também é o motivo de uma propriedade de entidade como `public bool IsActive => !IsDeleted && Orders.Count > 0` lançar "Translation of member 'IsActive' on entity type 'Customer' failed" na primeira vez que alguém a usa em um `Where`. Propriedades CLR calculadas não têm árvore para o EF ler.

Uma última nota sobre planos. Cada formato distinto de árvore de expressão é uma entrada distinta no cache de consultas compiladas do EF, então um construtor de predicados que monta uma árvore diferente por requisição não vai reaproveitar um plano mesmo que o texto SQL acabe idêntico. Se uma consulta composta específica domina um caminho quente, fixe-a com [uma consulta compilada](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) em vez de reconstruir a árvore a cada chamada.

## Onde isso mora em uma base de código real

Dois formatos cobrem quase tudo, e a escolha é sobre quem é dono da regra.

Se a regra pertence à entidade, uma classe estática ao lado dela basta. `CustomerRules.IsActive`, `OrderRules.IsBig`, um arquivo, sem interfaces. Quem chama escreve `db.Customers.Where(CustomerRules.IsActive)` e a definição tem exatamente uma casa. É por essa versão que se deve começar, e a maioria dos times nunca precisa de mais.

Se a regra pertence a um caso de uso e não a uma entidade, um objeto specification se justifica: um tipo pequeno expondo `Expression<Func<T, bool>> Criteria` mais includes e ordenação opcionais, com `And`, `Or` e `Not` implementados sobre os helpers de composição acima. O valor não está na abstração, está em que um caso de uso pode circular pelo código, ser testado unitariamente contra objetos em memória através do delegate `Compile()` em cache, e ser traduzido para SQL pela mesma árvore.

Escolha o que escolher, não construa uma abstração sobre o próprio `Where`. Chamadas encadeadas já compõem:

```csharp
db.Customers.Where(IsActive).Where(InCountry("NL"));
```

Isso emitiu exatamente o mesmo SQL que o predicado único composto com `And`, até o nome do parâmetro. Cada `Where` envolve o anterior na árvore, e o EF achata a cadeia em um único `WHERE` com `AND`. Então os helpers de composição só são necessários quando o operador é `Or`, quando você está religando para outro tipo de entidade, ou quando monta um predicado a partir de uma coleção cujo tamanho não é conhecido em tempo de compilação. Métodos de extensão sobre `IQueryable<T>` resolvem o caso simples de `And` sem nenhum código de expressão:

```csharp
public static IQueryable<Customer> ActiveOnly(this IQueryable<Customer> q)
    => q.Where(c => !c.IsDeleted && c.Orders.Count > 0);

public static IQueryable<Customer> InCountry(this IQueryable<Customer> q, string country)
    => q.Where(c => c.Country == country);

db.Customers.ActiveOnly().InCountry("NL");
```

O mesmo SQL de novo. A única coisa que você abre mão é a capacidade de extrair o predicado e usá-lo contra uma lista em memória, que é exatamente a vantagem que a versão com `Expression<Func<T, bool>>` compra.

## Relacionados

- [Fix: "The LINQ expression could not be translated" no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Como usar filtros de consulta nomeados para soft delete e multi-tenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Como registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Como usar consultas compiladas com EF Core em caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable em C#](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

## Fontes

- [Avaliação no cliente versus no servidor](https://learn.microsoft.com/en-us/ef/core/querying/client-eval), documentação do EF Core
- [dotnet/efcore#17791: regressão da 3.0, traduzir Expression.Invoke](https://github.com/dotnet/efcore/issues/17791)
- [Novidades do EF Core 9: EF.Parameter e EF.Constant](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [Queryable.Where e Queryable.OrderBy](https://learn.microsoft.com/en-us/dotnet/api/system.linq.queryable), referência de API do .NET
- Todo o SQL foi capturado com `ToQueryString()` contra `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.7.26381.103 no SDK do .NET 11.0.100-preview.7.26381.103, sem necessidade de conexão com banco de dados
