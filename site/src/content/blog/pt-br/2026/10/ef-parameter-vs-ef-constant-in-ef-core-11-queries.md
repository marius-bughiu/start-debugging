---
title: "EF.Parameter vs EF.Constant em consultas do EF Core 11"
description: "EF.Constant embute um valor capturado como literal SQL, EF.Parameter transforma um literal em parâmetro SQL. Mantenha os padrões do EF Core, use EF.Parameter para impedir que árvores de expressão montadas dinamicamente sejam recompiladas a cada chamada, e use EF.Constant apenas para um valor com poucos valores distintos e dados tão desbalanceados que precisam de um plano próprio."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "sql-server"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/ef-parameter-vs-ef-constant-in-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-10-02
---

`EF.Constant(x)` diz ao EF Core para escrever um valor no SQL como literal (`WHERE [Status] = N'Pending'`) mesmo que ele tenha vindo de uma variável, o que o EF normalmente enviaria como parâmetro. `EF.Parameter(x)` faz o oposto: força um valor que o EF normalmente embutiria, como um literal ou um `Expression.Constant` em uma árvore montada à mão, a ser enviado como parâmetro (`WHERE [Status] = @p`). Os padrões estão certos para quase todas as consultas. Use `EF.Parameter` quando você monta árvores de expressão dinamicamente, porque constantes puras nessas árvores forçam uma compilação completa da consulta para cada valor distinto. Use `EF.Constant` apenas quando uma coluna tem poucos valores distintos com dados muito desbalanceados e o banco de dados precisa de um plano separado para cada valor.

Tudo abaixo foi executado no EF Core 11.0.0-rc.1.26425.128 com o SDK 11.0.100-rc.1.26425.128 em um Apple M4. Onde indicado, também verifiquei o EF Core 10.0.12 no SDK 10.0.302, que se comportou da mesma forma. `EF.Constant` chegou no EF Core 8.0.2, `EF.Parameter` no EF Core 9, e o `EF.MultipleParameters`, específico para coleções, no EF Core 10.

## A comparação em resumo

| | `EF.Parameter(x)` | `EF.Constant(x)` |
| --- | --- | --- |
| Disponível desde | EF Core 9 | EF Core 8.0.2 |
| Resultado escalar no SQL | parâmetro `@p` | literal, por exemplo `N'Pending'` |
| Resultado de coleção no SQL (EF 10/11) | um parâmetro JSON + `OPENJSON` | literais `IN (1, 2, 3, ...)` |
| Entradas no cache de consultas do EF para N valores distintos | 1 | 1 (desde o EF 9) |
| Entradas no cache de planos do banco para N valores distintos | 1 | até N |
| Plano ajustado ao valor real | Não (vale o parameter sniffing) | Sim |
| Valor aparece nos logs do EF por padrão | Não (`'?'`) | Não, ocultado como `?` desde o EF 10 |
| Funciona em `EF.CompileQuery` / filtros de consulta | Não, lança exceção | Não, lança exceção |
| Uso principal | árvores de expressão dinâmicas, forçar um parâmetro de coleção JSON | colunas desbalanceadas de baixa cardinalidade, forçar uma lista `IN` embutida |

## O que o EF Core faz por padrão

A regra de parametrização do EF é simples: tudo que vem de fora da árvore de expressão (uma variável local capturada, um campo, um argumento de método) vira parâmetro, e tudo que é escrito como literal dentro da lambda vira constante. Veja o que o EF Core 11 RC 1 gera para o SQL Server, direto do `ToQueryString()`:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer, .NET 11 RC 1
var status = "Pending";

db.Orders.Where(o => o.Status == status);
// DECLARE @status nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @status

db.Orders.Where(o => o.Status == "Pending");
// WHERE [o].[Status] = N'Pending'
```

Essa divisão é deliberada. Um literal no código-fonte não pode mudar entre execuções, então embuti-lo não custa nada e dá ao otimizador de consultas o valor real para estimar. Uma variável capturada pode mudar a cada chamada, então embuti-la produziria uma string SQL diferente por valor, e cada string distinta ganha sua própria entrada no cache de planos do banco. Em um SQL Server ocupado, isso é inchaço do cache de planos e uma compilação a cada novo valor.

`EF.Constant` e `EF.Parameter` existem para sobrescrever essa regra nas duas direções.

## EF.Constant: forçar um literal

```csharp
// EF Core 11.0.0-rc.1
var status = "Pending";
db.Orders.Where(o => o.Status == EF.Constant(status));
// WHERE [o].[Status] = N'Pending'

var name = "O'Brien";
db.Orders.Where(o => o.Customer == EF.Constant(name));
// WHERE [o].[Customer] = N'O''Brien'
```

A segunda consulta importa se você se preocupa com injeção de SQL: o EF ainda gera o literal por meio do mapeamento de tipos do provedor, então a aspa é escapada. `EF.Constant` não é concatenação de strings.

O motivo para fazer isso é o parameter sniffing. O SQL Server compila um plano parametrizado usando o primeiro valor que vê e reutiliza esse plano para todos os valores seguintes. Se `Status = 'Archived'` corresponde a 40 milhões de linhas e `Status = 'Pending'` corresponde a 200, um plano compilado para um é errado para o outro. Com um literal, cada valor recebe seu próprio plano com sua própria estimativa de cardinalidade. Essa troca só compensa quando a coluna tem um conjunto pequeno e fixo de valores. Se você envolver um ID de usuário ou um número de pedido em `EF.Constant`, você recria o problema de cache de planos que os padrões do EF foram feitos para evitar.

### EF.Constant não custa mais uma recompilação do EF

No EF Core 8, a implementação inseria a constante cedo no pipeline, antes da consulta ao cache de consultas do próprio EF, então cada novo valor causava uma compilação completa de LINQ para SQL. A [página de breaking changes do EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) descreve a reescrita: o método agora é processado em uma etapa posterior, depois do cache. Verifiquei isso contando o evento de log de depuração `Compiling query expression` ao longo de 500 execuções com 500 valores distintos, após um aquecimento de 50 consultas, no SQLite em memória:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.Sqlite
for (int i = 0; i < 500; i++)
{
    using var db = new Ctx(conn, log: s => { if (s.Contains("Compiling query expression")) compiles++; });
    var value = "S" + i;
    db.Orders.Where(o => o.Status == EF.Constant(value)).ToList();
}
```

O resultado foi zero compilações adicionais: o EF reutiliza sua consulta compilada e apenas renderiza novamente o texto SQL. O custo do `EF.Constant` hoje fica inteiramente no lado do banco de dados, um plano por string SQL distinta.

## EF.Parameter: forçar um parâmetro

```csharp
// EF Core 11.0.0-rc.1
db.Orders.Where(o => o.Status == EF.Parameter("Pending"));
// DECLARE @p nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @p
```

Envolver um literal fixo no código raramente é útil por si só. Onde o `EF.Parameter` mostra seu valor é na construção dinâmica de consultas. Quando você monta um predicado com `System.Linq.Expressions`, o natural é escrever `Expression.Constant(value)`, e o EF trata isso exatamente como um literal no código-fonte:

```csharp
// EF Core 11.0.0-rc.1, .NET 11 RC 1
static Expression<Func<T, bool>> Eq<T>(string property, string value, bool wrap)
{
    var p = Expression.Parameter(typeof(T), "e");
    Expression v = Expression.Constant(value);
    if (wrap)
        v = Expression.Call(typeof(EF), nameof(EF.Parameter), [typeof(string)], v);
    return Expression.Lambda<Func<T, bool>>(
        Expression.Equal(Expression.Property(p, property), v), p);
}

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: false));
// WHERE [o].[Status] = N'Shipped'

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: true));
// DECLARE @p nvarchar(4000) = N'Shipped';
// WHERE [o].[Status] = @p
```

Ao contrário do `EF.Constant`, um `Expression.Constant` puro faz parte da árvore que o EF usa como chave de cache, então cada valor distinto é um cache miss e uma compilação completa. É aqui que aparece o custo mensurável. Mesmo harness de antes, 500 valores distintos, um processo por variante, após o aquecimento:

| Variante (EF Core 11 RC 1, SQLite em memória, M4) | Compilações do EF | Tempo para 500 consultas |
| --- | --- | --- |
| Variável capturada (padrão) | 0 | 186-292 ms |
| `EF.Constant(variable)` | 0 | 188-226 ms |
| `Expression.Constant` puro em uma árvore montada | 500 | 2201-2261 ms |
| `Expression.Constant` envolvido em `EF.Parameter` | 0 | 202-355 ms |

Os intervalos são de duas execuções cada. A tabela está vazia, então isso isola o overhead do próprio EF: cerca de 4 ms de compilação por consulta, antes de o banco de dados fazer qualquer coisa. No SQL Server, você somaria a isso uma compilação de plano no banco por string distinta. Uma única chamada `Expression.Call` para `EF.Parameter` traz a árvore dinâmica de volta ao custo de uma consulta LINQ normal.

A outra forma de chegar lá é capturar o valor em um objeto de closure e usar `Expression.Property(Expression.Constant(holder), "Value")`, que é o que o compilador C# faz para uma lambda. Funciona, mas `EF.Parameter` é mais curto e deixa a intenção visível. Abordei o truque da closure com mais profundidade em [como escrever predicados LINQ reutilizáveis que o EF Core consegue traduzir](/pt-br/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).

## Coleções: três estratégias, três marcadores

Para um escalar, a escolha é binária. Para uma coleção usada em `Contains`, o EF Core 10 e 11 têm três traduções, e cada método marcador escolhe uma por consulta:

```csharp
// EF Core 11.0.0-rc.1, SQL Server provider
int[] ids = [1, 2, 3, 4, 5, 6, 7, 8];

db.Orders.Where(o => ids.Contains(o.Id));
// DECLARE @ids1 int = 1; ... DECLARE @ids8 int = 8;
// DECLARE @ids9 int = 8; DECLARE @ids10 int = 8;
// WHERE [o].[Id] IN (@ids1, @ids2, ..., @ids10)

db.Orders.Where(o => EF.Constant(ids).Contains(o.Id));
// WHERE [o].[Id] IN (1, 2, 3, 4, 5, 6, 7, 8)

db.Orders.Where(o => EF.Parameter(ids).Contains(o.Id));
// DECLARE @ids nvarchar(4000) = N'[1,2,3,4,5,6,7,8]';
// WHERE [o].[Id] IN (
//     SELECT [i].[value]
//     FROM OPENJSON(@ids) WITH ([value] int '$') AS [i]
// )

db.Orders.Where(o => EF.MultipleParameters(ids).Contains(o.Id));
// same padded IN (@ids1, ..., @ids10) as the default
```

O padrão desde o EF Core 10 é um parâmetro escalar por elemento, com padding de modo que 8 valores produzam 10 parâmetros (o último valor é repetido). Isso mantém pequeno o número de strings SQL distintas e ainda informa ao otimizador aproximadamente quantos valores existem. `EF.Parameter` em uma coleção traz de volta o comportamento do EF Core 8 e 9: um único parâmetro JSON desempacotado com `OPENJSON`, uma string SQL para qualquer tamanho de lista, mas sem informação de cardinalidade para o planejador. `EF.Constant` embute os valores, que é o comportamento do EF Core 7.

A chave global é `UseParameterizedCollectionMode`:

```csharp
// EF Core 11.0.0-rc.1
options.UseSqlServer(connectionString,
    o => o.UseParameterizedCollectionMode(ParameterTranslationMode.Constant));
```

Com isso configurado, um simples `ids.Contains(...)` produz `IN (1, 2, ...)`, `EF.MultipleParameters(ids)` faz uma única consulta voltar a usar parâmetros com padding, e `EF.Parameter(ids)` a faz usar `OPENJSON`. O modo afeta apenas coleções: uma variável escalar capturada continua `@status` em todos os modos. Os métodos `TranslateParameterizedCollectionsToConstants()` e `TranslateParameterizedCollectionsToParameters()` do EF Core 9 foram marcados como `[Obsolete]` no EF Core 10 e não existem mais no código-fonte do EF Core 11 RC 1, então um projeto que atualiza do EF 9 precisa migrar para `UseParameterizedCollectionMode`. O [passo a passo das breaking changes do EF Core 6 ao 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre o resto desse caminho de atualização.

## Armadilhas que encontrei durante os testes

### O marcador precisa estar dentro da lambda

`EF.Constant` e `EF.Parameter` são marcadores, não funções. Seus corpos reais lançam exceção. Eles só funcionam quando estão dentro de uma árvore de expressão que o EF traduz. Isto compila, mas falha em tempo de execução:

```csharp
// EF Core 11.0.0-rc.1
db.Orders.OrderBy(o => o.Id).Take(EF.Constant(10));
// InvalidOperationException: The 'EF.Constant<T>' method may only be used
// within Entity Framework LINQ queries.
```

`Take(int)` recebe um `int` simples, não uma `Expression`, então o C# avalia `EF.Constant(10)` imediatamente, fora de qualquer consulta. O mesmo vale para qualquer argumento de operador que não seja uma lambda.

### Não em consultas compiladas, nem em filtros de consulta

Desde o EF Core 9, ambos os métodos lançam exceção dentro de `EF.CompileQuery` e `EF.CompileAsyncQuery`. No EF Core 11 RC 1, a mensagem é mais clara do que a `InvalidCastException` documentada para o EF 9:

```text
InvalidOperationException: 'EF.Constant<T>' is not supported when using compiled queries or query filters.
InvalidOperationException: 'EF.Parameter<T>' is not supported when using compiled queries or query filters.
```

Se você precisa de uma constante em um caminho crítico, escreva o literal na lambda da consulta compilada. Se você precisa de planos por valor, uma consulta compilada é a ferramenta errada de qualquer forma, porque ela fixa uma única string SQL. O [guia de consultas compiladas](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) explica quando elas compensam. A mensagem também exclui os filtros de consulta globais, o que importa se você esperava embutir um ID de tenant em um [filtro de consulta nomeado](/pt-br/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/).

### Valores embutidos são ocultados nos logs

Antes do EF Core 10, uma constante embutida era visível no SQL registrado, ao contrário do valor de um parâmetro. Desde o EF Core 10, o EF a oculta. No log do EF Core 11 RC 1, com o log de dados sensíveis desativado:

```text
Executed DbCommand (20ms) [Parameters=[@secret='?' (Size = 17)], ...]
WHERE "o"."Customer" = @secret

Executed DbCommand (0ms) [Parameters=[], ...]
WHERE "o"."Customer" = ?
```

O banco de dados ainda recebe o literal real. Só a linha do log é mascarada. Esse `?` pode confundir na primeira vez que você [registra em log o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) e tenta colá-lo no SSMS. Ative `EnableSensitiveDataLogging()` em desenvolvimento para ver o valor.

### O modo de coleção não faz parte da chave do cache de consultas

Esta me surpreendeu. Dois contextos do mesmo tipo, um configurado com `ParameterTranslationMode.Constant` e outro com o padrão, compartilham um único provedor de serviços interno e um único cache de consultas compiladas. Quem executar primeiro um determinado formato de consulta decide o SQL para ambos:

```csharp
// EF Core 11.0.0-rc.1 and 10.0.12, same process
using (var a = new Ctx(ParameterTranslationMode.Constant))
    a.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)

using (var b = new Ctx(mode: null))   // default MultipleParameters
    b.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)   <- cached translation from context a
```

O código-fonte explica. `RelationalOptionsExtension` retorna `0` em `GetServiceProviderHashCode()`, e `RelationalCompiledQueryCacheKey` inclui `UseRelationalNulls` e `QuerySplittingBehavior`, mas não o modo de coleção. Em um aplicativo normal com uma única configuração, isso nunca importa. Importa se você registra o mesmo `DbContext` duas vezes com modos diferentes, ou alterna o modo em uma fixture de teste e espera que o teste seguinte veja um SQL diferente. Use os marcadores por consulta nesse caso, já que eles fazem parte da árvore de expressão e, portanto, da chave de cache.

## Quando escolher EF.Parameter

- Você monta predicados com `System.Linq.Expressions` (construtores de filtros, busca em grades, endpoints no estilo OData). Envolva todo `Expression.Constant` que carrega entrada do usuário em `EF.Parameter`, ou você paga uma compilação completa por valor distinto.
- Você quer a tradução com `OPENJSON` para uma consulta cujo tamanho de lista varia muito (de 1 a 2.000 IDs), de modo que o banco tenha um plano em vez de várias variantes com padding.
- Você definiu o modo global de coleção como `Constant` e uma consulta precisa voltar atrás.

## Quando escolher EF.Constant

- Uma coluna com poucos valores e dados muito desbalanceados, como um status ou um discriminador de tipo, em que os planos medidos diferem por valor. Confirme a regressão com o plano de execução real antes.
- Uma lista curta e estável de valores em `Contains` (um conjunto fixo de papéis ou regiões) em que o otimizador se beneficia de ver os literais, e você sabe que o conjunto de combinações é pequeno.
- Nunca para IDs, entrada de usuário com variedade ilimitada, ou qualquer coisa dentro de uma consulta compilada.

## A recomendação

Deixe os padrões do EF Core 11 em paz até ter uma medição. A maior parte do benefício no mundo real vem do `EF.Parameter`, porque uma árvore montada dinamicamente com constantes puras é um erro fácil de cometer e custa cerca de 4 ms de compilação do EF por chamada antes mesmo de o banco de dados ver a consulta. `EF.Constant` é uma correção pontual para parameter sniffing em colunas desbalanceadas de baixa cardinalidade. Ele não custa mais uma recompilação do EF, mas cada valor distinto ainda custa um plano no banco. Se você não tem certeza de qual dos dois obteve, `ToQueryString()` mostra na hora. Procure por `DECLARE @`. E se uma consulta regrediu após uma atualização, verifique [o que o nível de compatibilidade do SQL Server muda para o EF Core 11](/pt-br/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/) antes de recorrer a qualquer um dos marcadores.

## Fontes

- [What's new in EF Core 9: force or prevent query parameterization](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [What's new in EF Core 10: improved translation for parameterized collections, redacting inlined constants](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking changes in EF Core 9: EF.Constant and EF.Parameter in compiled queries](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [`EF.cs`, `EFExtensions.cs` and `ParameterTranslationMode.cs` in dotnet/efcore](https://github.com/dotnet/efcore/tree/main/src/EFCore)
- [dotnet/efcore#13617, the original plan cache issue for inlined collections](https://github.com/dotnet/efcore/issues/13617)
