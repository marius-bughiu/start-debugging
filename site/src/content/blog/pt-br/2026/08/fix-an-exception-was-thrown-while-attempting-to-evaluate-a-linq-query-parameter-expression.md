---
title: "Correção: \"An exception was thrown while attempting to evaluate a LINQ query parameter expression\" no EF Core 11"
description: "O EF Core lança isso quando um trecho da sua consulta avaliado no cliente falha enquanto o EF o avalia. Leia InnerException, ative EnableSensitiveDataLogging e mova a checagem de null para fora da lambda."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "linq"
lang: "pt-br"
translationOf: "2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression"
translatedBy: "claude"
translationDate: 2026-08-19
---

Isto não é uma falha de tradução. O EF Core 11 lança `An exception was thrown while attempting to evaluate a LINQ query parameter expression` quando ele já decidiu que uma subárvore da sua consulta é avaliável no cliente (um "parâmetro de consulta") e **o seu próprio código falhou enquanto o EF a avaliava**. Nove em cada dez vezes o erro real é um `NullReferenceException` sobre um objeto capturado, e ele está em `InnerException`. Chame `EnableSensitiveDataLogging()` no seu `DbContextOptionsBuilder` para que o EF imprima a expressão exata que o engasgou, e depois tire a checagem de null da lambda e leve-a para a composição da consulta. Tudo abaixo foi verificado contra o `Microsoft.EntityFrameworkCore` 10.0.11 no .NET 10; o ponto onde a exceção é lançada é idêntico caractere por caractere nas versões prévias do EF Core 11, então o comportamento se mantém inalterado.

## O erro em contexto

Existem duas variantes desta mensagem, e qual delas você recebe depende inteiramente de o log de dados sensíveis estar ligado ou não. Sem ele:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate a LINQ query parameter expression. See the inner exception for more information. To show additional information call 'DbContextOptionsBuilder.EnableSensitiveDataLogging'.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
   at System.Linq.Expressions.Interpreter.Instruction.NullCheck(Object o)
   at System.Linq.Expressions.Interpreter.FuncCallInstruction`2.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.Interpreter.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.LightLambda.Run(Object[] arguments)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.<Evaluate>g__EvaluateCore|74_0(...)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.Evaluate(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.ProcessEvaluatableRoot(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.VisitBinary(BinaryExpression binary)
```

Com `EnableSensitiveDataLogging()` ligado, a mensagem muda para a variante bem mais útil, que nomeia a expressão:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate the LINQ query parameter expression 'value(Program+<>c__DisplayClass0_0).filter.MinRating'. See the inner exception for more information.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
```

Repare no artigo: a mensagem não sensível diz "a LINQ query parameter expression", a sensível diz "the LINQ query parameter expression '...'". Se você pesquisou uma e chegou aqui com a outra, ainda está no lugar certo. Ambas vêm do mesmo par de strings de recurso, `ExpressionParameterizationException` e `ExpressionParameterizationExceptionSensitive`.

O `<>c__DisplayClass0_0` nessa expressão é a classe de closure gerada pelo compilador que guarda suas variáveis locais capturadas. `filter` é a variável capturada, `MinRating` é o acesso a membro que explodiu. Essa string sozinha normalmente já basta para achar a linha.

## Por que isso acontece

Antes de conseguir montar o SQL, o EF percorre sua árvore de expressão e a divide em dois tipos de nó: os que dependem da raiz da consulta (`b.Rating`, que vira uma coluna) e os que não dependem (`filter.MinRating`, que vira um parâmetro SQL). Essa segunda categoria é o que o EF chama de funcletização, e quem cuida dela é o `ExpressionTreeFuncletizer`. Para cada subárvore avaliável, o EF compila um `Func<object>` e o invoca:

```csharp
// Microsoft.EntityFrameworkCore 11, ExpressionTreeFuncletizer.EvaluateCore
try
{
    return Lambda<Func<object>>(Convert(expression, typeof(object)))
        .Compile(preferInterpretation: true)
        .Invoke();
}
catch (Exception exception)
{
    throw new InvalidOperationException(
        _logger.ShouldLogSensitiveData()
            ? CoreStrings.ExpressionParameterizationExceptionSensitive(expression)
            : CoreStrings.ExpressionParameterizationException,
        exception);
}
```

Esse é todo o mecanismo. Qualquer exceção que o seu código lance dentro de uma expressão capturada acaba embrulhada neste `InvalidOperationException` e relançada. O EF não está reclamando da sua consulta, ele está informando que executar um pedaço dela falhou.

Isso importa para a depuração. A mensagem é genérica de propósito, porque o texto da expressão pode conter dados de usuário, e é por isso que a variante detalhada fica atrás do log de dados sensíveis. O erro específico está sempre em `InnerException`, e o stack trace da exceção interna aponta para `System.Linq.Expressions.Interpreter` em vez de apontar para o seu código, porque o EF compila com `preferInterpretation: true`. Não procure os seus próprios frames nessa pilha. Leia o tipo e a mensagem da exceção interna.

Compare com o erro irmão, `The LINQ expression could not be translated`, que dispara quando o EF não consegue converter uma construção em SQL de jeito nenhum. Outra etapa do pipeline, outra correção.

## Reprodução mínima

Um `DbSet<Blog>`, um DTO de filtro anulável e um `Where` que o desreferencia:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

public class Filter { public int MinRating { get; set; } }

public class AppDb(DbContextOptions<AppDb> o) : DbContext(o)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}
```

```csharp
// .NET 10, C# 14, EF Core 10.0.11
Filter? filter = null;                                      // came back null from the request binder
var q = db.Blogs.Where(b => b.Rating >= filter!.MinRating); // no exception yet
var rows = q.ToList();                                      // throws here
```

Dois detalhes que vale a pena internalizar:

- **Compor a consulta não lança nada.** Construir o `IQueryable` é de graça. A funcletização roda quando a consulta é compilada, o que acontece no operador terminal. Confirmei isso construindo a consulta e nunca a enumerando: nenhuma exceção.
- **Todo operador terminal lança, inclusive `ToQueryString()`.** `ToList()`, `ToListAsync()`, `Any()`, `Count()` e `ToQueryString()` passam todos pelo mesmo caminho de compilação. Esse último é prático, porque significa que você consegue reproduzir isso sem nenhuma conexão com banco de dados.

Estas são as exceções internas que medi para os gatilhos mais comuns, todas contra o EF Core 10.0.11 com o provedor SQLite:

| O que você escreveu | `InnerException` |
| --- | --- |
| `b.Rating >= filter!.MinRating` com `filter` nulo | `NullReferenceException` |
| `b.Rating >= config.MinRating` onde o getter lança | sua própria exceção, na íntegra |
| `b.Rating == maybe!.Value` com `int? maybe = null` | `InvalidOperationException: Nullable object must have a value.` |
| `b.Rating == empty.First()` sobre uma `List<int>` vazia | `InvalidOperationException: Sequence contains no elements` |
| `b.Rating == int.Parse(raw)` com `raw = "not-a-number"` | `FormatException` |
| `b.Rating == map["nope"]` sobre um `Dictionary<string, int>` | `KeyNotFoundException` |
| `b.Rating >= Bad.Value` onde o inicializador estático lança | `TargetInvocationException` embrulhando a real |
| `b.Name == s!.Trim()` com `string? s = null` | `NullReferenceException` |

A penúltima linha pega as pessoas duas vezes: um inicializador de campo estático que falha deixa três níveis de aninhamento. O embrulho, depois `TargetInvocationException`, e depois a exceção com que você realmente se importa. Leia `ex.InnerException.InnerException` antes de concluir que a mensagem é inútil.

## Correção, em detalhe

A correção tem sempre a mesma forma: garantir que a expressão capturada não possa lançar quando o EF a avaliar. Há quatro maneiras de fazer isso, em ordem de preferência.

### 1. Compor condicionalmente fora da lambda

Esta é a correção certa para o caso esmagadoramente comum do "filtro opcional", e ainda produz um SQL melhor, porque o predicado some por completo quando o filtro não está presente:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
IQueryable<Blog> q = db.Blogs;

if (filter is not null)
{
    q = q.Where(b => b.Rating >= filter.MinRating);
}

var rows = await q.ToListAsync();
```

Verificado com `filter` nulo: nenhuma exceção, e nenhuma cláusula `WHERE` morta no SQL gerado.

### 2. Extrair o valor para uma variável local antes da consulta

Se o valor é genuinamente opcional mas o predicado não é, projete-o para uma variável local com um valor padrão definido. O EF então captura um `int`, que não tem como lançar:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var min = filter?.MinRating ?? int.MinValue;
var rows = await db.Blogs.Where(b => b.Rating >= min).ToListAsync();
```

Esta é também a correção para `int.Parse`, `Guid.Parse` e buscas em dicionários. Faça o parse ou a busca antes da consulta, onde você consegue tratar a falha direito, em vez de dentro de uma lambda onde a falha chega embrulhada três camadas mais fundo.

### 3. Curto-circuito dentro da lambda

Se você precisa manter tudo em uma expressão só, uma guarda com `&&`, `||` ou um ternário funciona. O funcletizador trata de forma especial os operadores binários de curto-circuito e as `ConditionalExpression`, e não avalia avidamente o ramo morto:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var rows = await db.Blogs
    .Where(b => filter == null || b.Rating >= filter.MinRating)
    .ToListAsync();

// the ternary form behaves identically
var rows2 = await db.Blogs
    .Where(b => filter == null ? true : b.Rating >= filter.MinRating)
    .ToListAsync();
```

As três variantes (`filter != null && ...`, `filter == null || ...` e o ternário) retornaram limpas na minha reprodução com `filter` nulo. Ainda assim, deixe esta em terceiro lugar, por dois motivos: ela manda para o banco de dados uma cláusula `WHERE` sempre verdadeira quando o filtro não está presente, e se apoia em um comportamento do funcletizador que já mudou entre versões maiores. A issue [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883) é exatamente esta forma, um condicional que mistura uma condição do cliente com uma do banco, e ela regrediu para um erro interno de `unbound variable` durante o ciclo do EF Core 9 antes de ser corrigida.

### 4. Consertar o que lança

Se o culpado é um getter de propriedade que lança porque um serviço ainda não foi inicializado (o clássico é um resolvedor de tenant lendo um escopo ambiente vazio), nada do acima ajuda. A consulta está certa; a sua raiz de composição está quebrada. Faça o getter devolver um valor, ou falhar antes com uma mensagem que diga algo útil.

## Pegadinhas e variantes

**Filtros de consulta não são embrulhados.** Se a sua lambda de `HasQueryFilter` lê um campo do `DbContext` e essa leitura lança, você recebe a sua exceção crua, não esta. Montei um contexto com `HasQueryFilter(b => b.TenantId == _tenant.Current)` onde `_tenant.Current` lança, e `db.Blogs.ToList()` mostrou `InvalidOperationException: no tenant in scope` diretamente. O motivo está no funcletizador: expressões que tocam o contexto vão pelo caminho de acesso ao contexto, que devolve uma `Lambda` adiada em vez de invocá-la dentro daquele bloco `try`. Então, se você está depurando uma configuração multi-tenant e realmente vê o embrulho de parametrização, a captura culpada está em um `Where` comum, não no filtro. Chamar `IgnoreQueryFilters()` faz a consulta passar e é um jeito rápido de confirmar qual dos dois casos você tem.

**Uma coleção nula dentro de `Contains` não lança. Ela silenciosamente não retorna nada.** Esta é a variante mais perigosa da página, porque parece uma correção:

```csharp
// .NET 10, C# 14, EF Core 10.0.11, SQLite provider
List<string>? names = null;
var rows = db.Blogs.Where(b => names!.Contains(b.Name)).ToList();
// rows.Count == 0, no exception
// SELECT "b"."Id", "b"."Name", "b"."Rating" FROM "Blogs" AS "b" WHERE 0
```

O EF traduz uma coleção parametrizada nula para um predicado sempre falso, exatamente como faz com uma vazia. Você não recebe um erro, recebe zero linhas, e o bug vai para produção. Se no seu domínio uma lista nula significa "sem filtro", diga isso explicitamente com uma guarda `names is null ||`, ou componha condicionalmente como na correção 1.

**`EF.Constant` não te salva.** Embrulhar a captura como `EF.Constant(filter!.MinRating)` continua lançando. A desreferência acontece enquanto o argumento é avaliado, antes de o EF sequer ver o método marcador.

**Um `NullReferenceException` cru em vez do embrulho significa que a falha foi no seu código, não no do EF.** `db.Blogs.Take(filter!.MinRating)` lança um `NullReferenceException` simples, porque `Take` aceita um `int`: o compilador de C# avalia esse argumento no ponto da chamada e ele nunca chega a fazer parte de uma árvore de expressão. O mesmo vale para `Skip` e para qualquer coisa que você interpole em uma string antes de passar. Só lambdas recebem o embrulho.

**Encadear não ajuda.** Dividir em `db.Blogs.Where(b => b.Id == 0).Where(b => b.Rating >= filter!.MinRating)` continua lançando. A funcletização percorre a árvore composta inteira em tempo de compilação, e não operador por operador, então um filtro anterior não consegue dar curto-circuito em uma captura posterior.

**Lança em toda execução, não só na primeira.** O cache de consultas compiladas é indexado pelo formato da consulta, e a funcletização roda antes da busca no cache para extrair os valores dos parâmetros. Aqui não existe o "funcionou uma vez e depois começou a falhar".

## Relacionado

- A outra exceção de tempo de consulta do EF Core que as pessoas confundem com esta está coberta em [por que o EF Core diz que a expressão LINQ não pôde ser traduzida](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), que trata de construções que o EF não consegue converter em SQL de jeito nenhum.
- Quando a exceção interna é `Sequence contains no elements`, vale ler o comportamento do operador LINQ por trás disso em [o que realmente lança em First e Single](/pt-br/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- Ligar a variante sensível desta mensagem é uma linha da configuração mais ampla descrita em [como ver o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Se você bateu nisso montando multi-tenancy, [filtros de consulta nomeados para soft delete e multi-tenancy](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) cobrem como levar o id do tenant até o contexto sem um getter que lance.
- A parametrização também governa o comportamento do cache, o que importa quando você está atrás de desempenho de consulta com [consultas compiladas em caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Fontes

- [CoreStrings.ExpressionParameterizationException](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.corestrings.expressionparameterizationexception) no MS Learn, para a string de recurso exata.
- [ExpressionTreeFuncletizer.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs) no dotnet/efcore, onde vive o try/catch que embrulha.
- [Avaliação no cliente x no servidor](https://learn.microsoft.com/en-us/ef/core/querying/client-eval) na documentação do EF Core, sobre como o EF divide uma árvore de consulta.
- [DbContextOptionsBuilder.EnableSensitiveDataLogging](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablesensitivedatalogging), que liga a variante da mensagem que nomeia a expressão.
- [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883), a regressão do EF Core 9 em que um condicional misto de cliente e banco produzia esta exceção com um erro interno de `unbound variable`.
- [Discussão #792 do Finbuckle.MultiTenant](https://github.com/Finbuckle/Finbuckle.MultiTenant/discussions/792), um relato representativo deste erro em um contexto multi-tenant.
