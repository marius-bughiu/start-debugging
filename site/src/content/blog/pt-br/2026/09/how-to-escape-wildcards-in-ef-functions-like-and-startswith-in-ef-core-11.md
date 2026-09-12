---
title: "Como escapar os curingas % e _ em consultas com EF.Functions.Like e StartsWith no EF Core 11"
description: "StartsWith, EndsWith e Contains já escapam % e _ para você no EF Core 11, mas EF.Functions.Like não. Veja o SQL que o EF gera, um helper de escape reutilizável e a sobrecarga com escapeCharacter que faz tudo funcionar no SQL Server, no SQLite e no PostgreSQL."
pubDate: 2026-09-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "linq"
lang: "pt-br"
translationOf: "2026/09/how-to-escape-wildcards-in-ef-functions-like-and-startswith-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

**Resposta curta:** no EF Core 11 você não precisa escapar nada para `string.StartsWith`, `EndsWith` ou `Contains`. O EF reescreve o valor da busca em um padrão como `50\%%` e adiciona `ESCAPE N'\'` sozinho. Com `EF.Functions.Like` é diferente: ele repassa o seu padrão sem mexer em nada, então um usuário que digita `50%` ou `a_b` recebe correspondências por curinga. Escape você mesmo a parte fornecida pelo usuário (primeiro a barra invertida, depois `%`, `_` e, no SQL Server, `[`) e chame a sobrecarga de três argumentos, `EF.Functions.Like(p.Name, pattern, "\\")`. Se você escapar mas esquecer esse terceiro argumento, o SQL Server e o SQLite tratam suas barras invertidas como caracteres literais e a consulta silenciosamente não retorna nada.

Tudo o que vem a seguir foi medido no .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`) com `Microsoft.EntityFrameworkCore.SqlServer` e `Microsoft.EntityFrameworkCore.Sqlite` `11.0.0-rc.1.26425.128`. A saída do SQL Server vem de `ToQueryString()`. As consultas no SQLite foram de fato executadas contra um banco de dados em memória, então as listas de linhas são resultados reais.

## Por que um sinal de porcentagem na caixa de busca retorna as linhas erradas

O `LIKE` do SQL tem a sua própria pequena linguagem de padrões. No SQL Server, [a referência do `LIKE`](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql) define quatro curingas: `%` (qualquer sequência de caracteres), `_` (qualquer caractere único), `[abc]` (um conjunto ou intervalo de caracteres) e `[^abc]` (um conjunto negado). O SQLite e o PostgreSQL têm apenas `%` e `_`. Qualquer um desses caracteres em um termo de busca muda o significado da consulta.

Uma busca de produtos que monta o padrão por concatenação de strings mostra o problema na hora:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite in-memory
var term = "50%";   // what the user typed
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, "%" + term + "%"))
    .Select(p => p.Name)
    .ToListAsync();
```

Com as linhas `50% off sale`, `500 widgets`, `done 50%` e `done 500` na tabela, essa consulta retorna **as quatro**. O padrão é `%50%%`, que significa "contém 50", e o sinal de porcentagem que o usuário digitou desaparece. Um sublinhado faz a mesma coisa: buscar `a_b` com `$"%{term}%"` encontrou tanto `a_b adapter` quanto `axb adapter`. No SQL Server, um `[` no termo adiciona um terceiro curinga: `[x]` é uma classe de caracteres que corresponde ao único caractere `x`, então uma busca por `[x]` vira `%[x]%` e encontra todo nome que contenha um `x`.

Isso não é injeção de SQL. O valor continua sendo enviado como parâmetro (`DECLARE @p nvarchar(4000) = N'%50%%'`), então ninguém consegue escapar da string. O problema é que o padrão significa algo diferente do que o usuário pediu, e nenhum erro acontece quando isso ocorre.

## O que o EF Core 11 já escapa para você

Antes de escrever um helper de escape, verifique se você precisa de um. Os métodos de string simples do LINQ já são tratados para você. Isto é o que o EF Core 11 RC 1 gera no SQL Server quando o valor da busca é uma variável capturada:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer
var term = "50%";
var q = db.Products.Where(p => p.Name.StartsWith(term));
Console.WriteLine(q.ToQueryString());
```

```sql
DECLARE @term_startswith nvarchar(4000) = N'50\%%';

SELECT [p].[Id], [p].[Name], [p].[Sku]
FROM [Products] AS [p]
WHERE [p].[Name] LIKE @term_startswith ESCAPE N'\'
```

O EF avaliou a variável no cliente, escapou o valor, acrescentou o `%` e enviou o resultado como um novo parâmetro chamado `@term_startswith`. `EndsWith` gera `N'%50\%'` em `@term_endswith`, e `Contains` gera `N'%a\_b%'` em `@under_contains`. Uma constante como `StartsWith("50%")` é escapada do mesmo jeito e colocada inline como `LIKE N'50\%%' ESCAPE N'\'`.

O escape fica em `SqlServerSqlTranslatingExpressionVisitor`. Na [tag `v11.0.0-rc.1.26425.128`](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), o conjunto de caracteres especiais ocupa uma linha:

```csharp
// EF Core 11.0.0-rc.1, SqlServerSqlTranslatingExpressionVisitor.cs
private static bool IsLikeWildChar(char c)
    => c is '%' or '_' or '['; // See https://docs.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql
```

`EscapeLikePattern` coloca uma barra invertida na frente de cada um desses caracteres e na frente de qualquer barra invertida que já esteja no valor. O provider do SQLite tem o mesmo código, só que o seu `IsLikeWildChar` considera apenas `%` ou `_`, porque o SQLite não tem classes com colchetes.

Dois detalhes de provider podem pegar você de surpresa:

- **O SQLite não usa `LIKE` para `Contains`.** Ele traduz `p.Name.Contains(term)` para `instr("p"."Name", @term) > 0`, então nenhum escape é necessário ali. `StartsWith` e `EndsWith` continuam virando `LIKE ... ESCAPE '\'`.
- **Comparações entre colunas dispensam o `LIKE`.** `p.Name.StartsWith(p.Sku)` vira `LEFT([p].[Name], LEN([p].[Sku])) = [p].[Sku]` no SQL Server e `substr(...)` no SQLite. Como o padrão só é conhecido quando a linha é lida, não há nada para escapar. Um comentário no código-fonte do EF avisa que essa forma é "less efficient than LIKE (i.e. StartsWith does an index scan instead of seek)".

Se tudo o que você precisa é "começa com", "termina com" ou "contém" sobre a entrada do usuário, use os métodos de string e pare por aí. Você só precisa de `EF.Functions.Like` quando quer curingas colocados por você mesmo, como `abc%def`, ou o texto do usuário no meio de um padrão maior.

## Por que o EF.Functions.Like não escapa a sua entrada

`EF.Functions.Like(matchExpression, pattern)` é um mapeamento direto: a [página de mapeamentos de funções do SQL Server](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions) o lista como `@matchExpression LIKE @pattern`, sem nenhuma etapa de escape. Isso é proposital. O padrão deveria conter curingas, e o EF não tem como saber quais caracteres `%` você quis colocar e quais vieram do usuário. Um pedido para o EF escapar automaticamente a entrada do `Like`, [dotnet/efcore#19118](https://github.com/dotnet/efcore/issues/19118), foi fechado como não planejado, e o EF Core 11 ainda não traz nenhum helper público de escape. A sobrecarga de que você precisa é a que tem um terceiro argumento:

```csharp
public static bool Like(this DbFunctions _, string? matchExpression, string? pattern, string? escapeCharacter);
```

Essa sobrecarga é traduzida para `@matchExpression LIKE @pattern ESCAPE @escapeCharacter`. Então o trabalho se divide em dois: escapar o texto do usuário em C# e depois informar ao banco de dados qual caractere de escape você usou.

## Escapando a entrada do usuário para EF.Functions.Like passo a passo

1. **Escolha um caractere de escape e use-o em todo lugar.** A barra invertida coincide com o que o EF usa internamente, então o SQL que você vê nos logs tem a mesma cara para `StartsWith` e `Like`. Qualquer caractere único funciona, desde que o helper de escape e o argumento `escapeCharacter` concordem.
2. **Escape primeiro o próprio caractere de escape.** Se você escapar `%` primeiro e depois duplicar cada barra invertida, vai duplicar as barras que acabou de adicionar. A ordem precisa ser: caractere de escape, depois os curingas.
3. **Escape `%` e `_` em todos os providers, e `[` no SQL Server.** Escapar `[` não causa problema em outros lugares: o SQLite e o PostgreSQL tratam um caractere comum escapado como o próprio caractere, então um único helper funciona nos três.
4. **Adicione os seus curingas depois de escapar.** Só o texto do usuário passa pelo helper. Os caracteres `%` que você coloca ao redor continuam ativos.
5. **Sempre passe `escapeCharacter`.** Sem ele, o SQL Server e o SQLite simplesmente não têm caractere de escape.

Uma pequena classe estática cobre os cinco pontos:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public static class LikePattern
{
    public const string EscapeCharacter = "\\";

    public static string Escape(string value, char escape = '\\')
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(escape.ToString(), $"{escape}{escape}") // must be first
            .Replace("%", $"{escape}%")
            .Replace("_", $"{escape}_")
            .Replace("[", $"{escape}[");                      // SQL Server bracket classes
    }

    public static string Contains(string value) => $"%{Escape(value)}%";
    public static string StartsWith(string value) => $"{Escape(value)}%";
    public static string EndsWith(string value) => $"%{Escape(value)}";
}
```

Use assim:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var term = "a_b";
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, LikePattern.Contains(term), LikePattern.EscapeCharacter))
    .Select(p => p.Name)
    .ToListAsync();
```

No SQLite isso produz `.param set @Contains '%a\_b%'` e `WHERE "p"."Name" LIKE @Contains ESCAPE '\'`, e retorna apenas `a_b adapter`. O mesmo código contra o SQL Server gera `LIKE @Contains ESCAPE N'\'`. Veja como ficaram os demais casos de teste:

| Termo de busca | Linhas com `Like` ingênuo (SQLite) | Linhas com `Like` escapado (SQLite) |
| --- | --- | --- |
| `50%` | `50% off sale`, `500 widgets`, `done 50%`, `done 500` | `50% off sale`, `done 50%` |
| `a_b` | `a_b adapter`, `axb adapter` | `a_b adapter` |

A versão escapada também retornou apenas `[x] marked` para `[x]` (padrão `%\[x]%`), e apenas `C:\temp\logs` para `C:\temp` (padrão `%C:\\temp%`, em que a barra invertida do caminho foi duplicada e não correspondeu a `C:tempxlogs`).

Você pode chamar o helper dentro da lambda. A extração de parâmetros do EF avalia no cliente qualquer subárvore que não toque em uma coluna, então `LikePattern.Contains(term)` roda uma vez no .NET e o resultado vira um parâmetro, com o nome do método (`@Contains`). Nada no helper precisa ser traduzível. Se você prefere nomes de parâmetro legíveis nos seus [logs de SQL](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), calcule o padrão em uma variável local antes. `var pattern = LikePattern.Contains(term);` aparece como `@pattern`.

## Esquecer o escapeCharacter retorna zero linhas em silêncio

Depois que as pessoas descobrem o problema do escape, um erro comum logo em seguida é escapar o termo e chamar a sobrecarga de dois argumentos:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite -- WRONG
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape("a_b") + "%"));
```

```sql
WHERE "p"."Name" LIKE '%a\_b%'
```

Sem cláusula `ESCAPE`, a barra invertida é um caractere comum, então o banco de dados procura um `a\_b` literal (com o `_` ainda funcionando como curinga) e não encontra nada. A [documentação de expressões do SQLite](https://www.sqlite.org/lang_expr.html#like) deixa explícito que não existe caractere de escape padrão, e a referência do SQL Server diz que o caractere de escape "has no default". A consulta não falha, apenas retorna uma lista vazia, o que torna esse bug difícil de perceber em code review.

O PostgreSQL é a exceção. O `LIKE` dele [trata a barra invertida como caractere de escape padrão](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE), então o mesmo código por acaso funciona ali. Essa é a pior combinação possível: os testes contra um PostgreSQL local passam, e a produção no SQL Server não retorna nada. Passar `escapeCharacter` explicitamente garante o mesmo comportamento nos três.

## Escolhendo outro caractere de escape

A barra invertida não é especial para o `LIKE`, é só uma convenção. Se os seus dados estão cheios de caminhos do Windows ou fragmentos de regex, escolha algo mais raro. O helper e o argumento precisam concordar:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite
var term = "!%";
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape(term, '!') + "%", "!"));
// .param set @p '%!!!%%'
// WHERE "p"."Name" LIKE @p ESCAPE '!'
// ROWS: Promo!%
```

`!%` virou `!!!%`: o `!` literal foi duplicado para `!!`, depois o `%` virou `!%`. O argumento `escapeCharacter` precisa ter exatamente um caractere. Passar `"ab"` é traduzido sem problemas, mas falha quando a consulta é executada, com o `SqliteException: SQLite Error 1: 'ESCAPE expression must be a single character'` do SQLite. O SQL Server também rejeita, já que o caractere de escape dele "must evaluate to only one character". Transforme-o em um `const`, como faz `LikePattern.EscapeCharacter`, para que ninguém passe o valor errado.

## Armadilhas que não têm a ver com escape

**A sensibilidade a maiúsculas e minúsculas vem do banco de dados.** No SQL Server, se o `LIKE` diferencia maiúsculas de minúsculas depende da collation da coluna, e o escape não tem nada a ver com isso. O SQLite tem uma armadilha que aparece no teste acima. `StartsWith` vira `LIKE`, que o SQLite compara sem diferenciar maiúsculas de minúsculas para ASCII, enquanto `Contains` vira `instr`, que diferencia. Buscar `50% OFF` com `StartsWith` encontrou `50% off sale`, mas `Contains` com o mesmo termo não encontrou nada. Se você testa contra o SQLite e implanta no SQL Server, saiba que cada método segue regras diferentes de maiúsculas e minúsculas.

**Um `%` no início mata os index seeks.** Um `LIKE @p ESCAPE N'\'` parametrizado cujo valor começa com um prefixo literal pode usar um índice no SQL Server. `%term%` não pode, escapado ou não. Para requisitos reais de "buscar em qualquer parte do texto" em tabelas grandes, considere a busca de texto completo do SQL Server (`EF.Functions.Contains` / `FreeText`) em vez de jogar ainda mais trabalho em cima do `LIKE`.

**Reutilizar uma variável em dois métodos de string.** O EF Core 8.0.0 tinha um bug em que `b.Name.StartsWith(s) || b.Body.Contains(s)` enviava o padrão do `Contains` para as duas comparações ([dotnet/efcore#32432](https://github.com/dotnet/efcore/issues/32432), corrigido no 8.0.2). O EF Core 11 gera dois parâmetros separados, `@term_startswith = N'50\%%'` e `@term_contains = N'%50\%%'`. Se você ainda está no 8.0.0 ou 8.0.1, atualize o pacote.

**Sobrecargas com `StringComparison` não são traduzidas.** `p.Name.StartsWith(term, StringComparison.OrdinalIgnoreCase)` lança `InvalidOperationException: The LINQ expression ... could not be translated` nos dois providers no RC 1. O [guia sobre falhas de tradução](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) cobre as reescritas. Neste caso, a resposta é a sobrecarga simples junto com uma collation que não diferencia maiúsculas de minúsculas, ou `EF.Functions.Collate`.

**Consultas compiladas funcionam normalmente.** Tanto o escape automático do `StartsWith` quanto o helper `LikePattern` produzem parâmetros comuns, então funcionam com `EF.CompileAsyncQuery`. O escape acontece a cada execução, não quando a consulta é compilada. Veja [consultas compiladas para hot paths](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) se você tem um endpoint de busca.

**Agentes e ferramentas que montam filtros.** Se uma ferramenta de LLM ou um servidor MCP transforma texto livre em chamadas a `EF.Functions.Like`, como no [exemplo de EF Core via MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/), trate os argumentos do modelo como qualquer outra entrada de usuário e passe-os pelo mesmo helper.

## Escolhendo a ferramenta certa para cada busca

- Correspondência exata de prefixo, sufixo ou substring sobre a entrada do usuário: `StartsWith` / `EndsWith` / `Contains`. O EF Core 11 escapa para você.
- Um padrão com curingas que você controla, ao redor do texto do usuário: `EF.Functions.Like(col, LikePattern.Contains(term), LikePattern.EscapeCharacter)`.
- Um padrão que o próprio usuário escreve, de propósito: `EF.Functions.Like` de dois argumentos, mas valide a entrada e pense no que um `[` solto faz no SQL Server.
- Busca de texto ordenada por relevância: busca de texto completo, não `LIKE`.

Antes de publicar, confira o SQL gerado uma vez para cada provider que você usa. `ToQueryString()` custa uma linha, e teria pegado todos os bugs deste post antes da produção.

### Leia a seguir

- [Como registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Correção: "The LINQ expression could not be translated" no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Como usar consultas compiladas com EF Core em hot paths](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Como armazenar um enum como string no EF Core 11 com um value converter](/pt-br/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)

### Fontes

- [LIKE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), Microsoft Learn
- [Mapeamentos de funções, provider do SQL Server](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions), documentação do EF Core
- [`SqlServerSqlTranslatingExpressionVisitor.cs` em v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), dotnet/efcore
- [dotnet/efcore#19118: Escape provider-specific symbols in user input when using EF.Functions.Like](https://github.com/dotnet/efcore/issues/19118)
- [dotnet/efcore#32432: Incorrect parameter rewriting for StartsWith/EndsWith/Contains](https://github.com/dotnet/efcore/issues/32432)
- [SQLite: o operador LIKE](https://www.sqlite.org/lang_expr.html#like)
- [PostgreSQL: correspondência de padrões com LIKE](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE)
