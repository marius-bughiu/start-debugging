---
title: "Como adicionar um elemento a um array jsonb do PostgreSQL de forma atômica com EF Core e Npgsql"
description: "Carregar uma entidade, chamar List.Add e salvar reescreve o documento jsonb inteiro e perde silenciosamente as adições concorrentes. Leve a adição para um único UPDATE com o operador jsonb ||, via ExecuteSqlAsync ou via uma função mapeada dentro de ExecuteUpdateAsync, e torne-a idempotente com uma guarda @>."
pubDate: 2026-09-21
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "json"
  - "concurrency"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql"
translatedBy: "claude"
translationDate: 2026-09-21
---

Resposta curta: não carregue a linha, não faça `Add` na lista e não chame `SaveChangesAsync`. O EF Core envia o documento `jsonb` inteiro de volta como parâmetro, então duas requisições que adicionam elementos ao mesmo tempo sobrescrevem uma à outra. Em vez disso, envie um único `UPDATE` que faz a adição dentro do PostgreSQL: `SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]') || to_jsonb(@label::text))`. Você pode emitir isso por meio de `Database.ExecuteSqlAsync`, ou manter tudo em LINQ mapeando uma pequena função com `HasDbFunction` e chamando-a dentro de `ExecuteUpdateAsync`, onde o EF Core 10 escreve o `jsonb_set` para você. Acrescente `.Where(t => !t.Data.Labels.Contains(label))`, que o Npgsql traduz para `@>`, e a adição também passa a ser idempotente.

Tudo o que está abaixo foi executado no .NET 10 (SDK 10.0.302) com `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (que traz o EF Core 10.0.4), contra o PostgreSQL 18.4. A coluna JSON está mapeada do jeito que o EF Core 10 recomenda: um complex type com `ToJson()`. Todo o SQL e todas as contagens citadas aqui vêm de execuções reais, não de reconstrução.

## Vinte adições concorrentes, três sobreviventes

Este é o modelo. Um ticket tem uma coluna `jsonb` que guarda labels e um histórico de eventos:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required TicketData Data { get; set; }
}

public class TicketData
{
    public List<string> Labels { get; set; } = [];
    public List<TicketEvent> Events { get; set; } = [];
}

public class TicketEvent
{
    public required string Kind { get; set; }
    public DateTime At { get; set; }
}

public class AppDb : DbContext
{
    public DbSet<Ticket> Tickets => Set<Ticket>();

    protected override void OnModelCreating(ModelBuilder b)
        => b.Entity<Ticket>().ComplexProperty(t => t.Data, d => d.ToJson());
}
```

O Npgsql cria `"Data" jsonb NOT NULL` para isso. Agora, o código que a maioria das pessoas escreve primeiro, executado a partir de 20 tasks paralelas contra a mesma linha, cada uma com seu próprio `DbContext`:

```csharp
// .NET 10, EF Core 10.0.4 -- the lost-update version
await using var db = new AppDb();
var t = await db.Tickets.SingleAsync(x => x.Id == id);
t.Data.Labels.Add($"l{i}");
await db.SaveChangesAsync();
```

A linha começa com um label, então o resultado esperado é 21. Eu obtive **3**, em três de três execuções. O motivo fica visível no SQL que o `SaveChangesAsync` envia:

```sql
UPDATE "Tickets" SET "Data" = @p0
WHERE "Id" = @p1;
-- @p0='{"Labels":["hardware","urgent","via-savechanges"],"Events":[...]}'
```

O EF Core não envia "adicione este elemento". Ele serializa o complex type inteiro que está em memória e substitui a coluna por ele. Cada task leu o mesmo documento inicial, adicionou seu próprio label e gravou de volta um documento que não sabia nada sobre as outras 19. O último a gravar vence, e o banco de dados não faz ideia de que algo deu errado, porque do ponto de vista dele cada `UPDATE` foi uma substituição perfeitamente válida.

Isso não é um bug do Npgsql. É o problema comum de lost update, e uma coluna JSON o torna pior do que o normal: com colunas escalares, duas requisições que alteram colunas *diferentes* não colidem, mas aqui qualquer alteração em qualquer label ou evento reescreve a única coluna que guarda todos eles.

## Por que uma adição dentro do banco é atômica

O operador `jsonb || jsonb` do PostgreSQL concatena. Quando o lado esquerdo é um array e o lado direito é um escalar ou um objeto, o lado direito é adicionado como um único elemento:

```sql
SELECT '["a"]'::jsonb || to_jsonb('b'::text);     -- ["a", "b"]
SELECT '["a"]'::jsonb || '{"k": 1}'::jsonb;       -- ["a", {"k": 1}]
```

O importante não é o operador, e sim de onde vem o valor antigo. Em `SET "Data" = ... "Data" || ...`, o `"Data"` do lado direito é o valor atual da linha no momento em que o `UPDATE` é executado. Sob o isolamento padrão `READ COMMITTED`, quando duas transações atualizam a mesma linha, a segunda fica bloqueada no lock da linha até a primeira fazer commit, depois relê a versão *nova* da linha e reavalia tanto sua cláusula `WHERE` quanto suas expressões `SET` contra ela. Assim, cada adição se apoia na anterior. Sem loop de retry, sem coluna de versão, sem ida e volta de leitura.

## Opção 1: um único UPDATE via ExecuteSqlAsync

A correção mais direta é escrever o comando você mesmo:

```csharp
// .NET 10, EF Core 10.0.4, PostgreSQL 18.4
var label = "urgent";
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]'::jsonb) || to_jsonb({{label}}::text))
    WHERE "Id" = {{id}}
    """);
```

`ExecuteSqlAsync` recebe um `FormattableString`, então `{{label}}` e `{{id}}` viram parâmetros de verdade (`@p0`, `@p1`), não concatenação de strings. A raw string com `$$` é proposital: ela permite que o literal de caminho jsonb `'{Labels}'` mantenha suas chaves simples, enquanto `{{...}}` marca os buracos. Com as mesmas 20 tasks paralelas, esta versão termina com 21 labels todas as vezes.

Cada uma das três partes desse comando existe por um motivo:

- `jsonb_set(doc, '{Labels}', newArray)` substitui apenas a chave `Labels` e mantém todas as outras chaves do documento como estão *agora*, incluindo uma entrada em `Events` que outra requisição adicionou um milissegundo atrás.
- `COALESCE("Data"->'Labels', '[]'::jsonb)` cobre linhas gravadas antes de `Labels` existir. `NULL || anything` é `NULL`, e `jsonb_set` com um novo valor `NULL` retorna `NULL` para o documento inteiro, o que numa coluna `NOT NULL` é um erro e numa coluna anulável é perda de dados.
- `::text` no parâmetro dá ao `to_jsonb` um tipo concreto. Sem isso, um literal que você mesmo coloca inline falha com `42804: could not determine polymorphic type because input has type unknown`.

Adicionar um objeto, como um novo evento de histórico, funciona do mesmo jeito. Serialize-o e faça o cast para `jsonb`:

```csharp
// .NET 10, EF Core 10.0.4, System.Text.Json
var ev = new TicketEvent { Kind = "escalated", At = DateTime.UtcNow };
var json = JsonSerializer.Serialize(ev);
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Events}', COALESCE("Data"->'Events', '[]'::jsonb) || jsonb_build_array({{json}}::jsonb))
    WHERE "Id" = {{id}}
    """);
```

O resultado foi `{"Events": [{"At": "2026-09-21T08:00:00Z", "Kind": "escalated"}], ...}`, e ao ler o ticket de volta pelo EF o evento foi materializado com `DateTimeKind.Utc`. Use os nomes de propriedade do EF no JSON (aqui `Kind` e `At`, o padrão quando não há `HasJsonPropertyName` no modelo), porque o EF lê o documento por essas chaves.

## Opção 2: ficar no LINQ com uma função mapeada e ExecuteUpdateAsync

SQL puro funciona, mas fixa no código nomes de tabela e de coluna que, fora isso, pertencem ao EF. O EF Core 10 adicionou suporte do `ExecuteUpdateAsync` a propriedades dentro de um complex type com `ToJson()`, então a primeira coisa natural a tentar é:

```csharp
// Does NOT translate in EF Core 10.0.4 / Npgsql 10.0.3
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => t.Data.Labels.Append("x").ToList()));
```

Isso falha com `The LINQ expression '...AsQueryable().Append("x")' could not be translated`, e a variante `Concat(new[] { "y" }).ToList()` falha com `does not represent a valid value`. O Npgsql não traduz operadores de adição de lista sobre uma coleção primitiva JSON dentro de um setter.

O que *funciona* é uma função definida pelo usuário cujo tipo de retorno é o tipo da coleção. O EF permite que ela fique no lado direito do `SetProperty` e a envolve no `jsonb_set` por conta própria. Crie a função numa migração:

```csharp
// EF Core 10 migration
migrationBuilder.Sql("""
    CREATE OR REPLACE FUNCTION jsonb_append_text(arr jsonb, elem text)
    RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $$ SELECT COALESCE(NULLIF(arr, 'null'::jsonb), '[]'::jsonb) || to_jsonb(elem) $$;
    """);
```

Depois declare um stub em C# e mapeie-o:

```csharp
// .NET 10, EF Core 10.0.4
public static class JsonbFn
{
    public static List<string> Append(List<string> array, string element)
        => throw new InvalidOperationException("Only usable in EF Core queries.");
}

// in OnModelCreating
b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Append))!)
    .HasName("jsonb_append_text");
```

O ponto de chamada agora é EF simples e tipado:

```csharp
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => JsonbFn.Append(t.Data.Labels, label)));
```

e o SQL que o EF gera é:

```sql
UPDATE "Tickets" AS t
SET "Data" = jsonb_set(t."Data", '{Labels}', COALESCE(to_jsonb(jsonb_append_text(t."Data" -> 'Labels', @label)), 'null'::jsonb))
WHERE t."Id" = @id
```

Vinte chamadores em paralelo, 21 labels, em todas as execuções. O `to_jsonb(...)` extra em volta de um valor que já é `jsonb` é um no-op que o EF adiciona a toda propriedade JSON que ele define. O `NULLIF(arr, 'null'::jsonb)` na função cobre um documento que contém `"Labels": null` em vez de não ter a chave. Sem ele, `'null'::jsonb || '"x"'` produz silenciosamente `[null, "x"]`.

### A mesma coisa sem migração: HasTranslation

Se você não pode adicionar objetos ao banco de dados, pode fazer o EF emitir funções nativas. `jsonb_insert(array, '{-1}', element, true)` insere depois do último elemento, o que é uma adição ao final:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore.Query.SqlExpressions;

b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Push))!)
    .HasTranslation(a =>
    {
        var jsonb = a[0].TypeMapping;
        var arr = new SqlFunctionExpression("COALESCE",
            [
                new SqlFunctionExpression("NULLIF", [a[0], new SqlFragmentExpression("'null'::jsonb")],
                    nullable: true, argumentsPropagateNullability: [false, false], typeof(string), jsonb),
                new SqlFragmentExpression("'[]'::jsonb"),
            ],
            nullable: false, argumentsPropagateNullability: [false, false], typeof(string), jsonb);
        var elem = new SqlFunctionExpression("to_jsonb",
            [new SqlUnaryExpression(ExpressionType.Convert, a[1], typeof(string), a[1].TypeMapping)],
            nullable: true, argumentsPropagateNullability: [true], typeof(string), jsonb);
        return new SqlFunctionExpression("jsonb_insert",
            [arr, new SqlFragmentExpression("'{-1}'"), elem, new SqlFragmentExpression("true")],
            nullable: true, argumentsPropagateNullability: [false, false, true, false],
            typeof(List<string>), jsonb);
    });
```

que produz:

```sql
SET "Data" = jsonb_set(t."Data", '{Labels}', jsonb_insert(COALESCE(NULLIF(t."Data" -> 'Labels', 'null'::jsonb), '[]'::jsonb), '{-1}', to_jsonb(@lbl::text), true))
```

Dois detalhes dessa tradução vieram de falhas, não de estilo. Minha primeira versão envolvia o array diretamente em `COALESCE(a[0], '[]')`, e o processador de nulabilidade do EF removeu o `COALESCE`, porque o modelo diz que `Labels` é uma coleção obrigatória e não anulável. Envolver primeiro em `NULLIF` torna a expressão anulável, então o `COALESCE` sobrevive, e de quebra trata o `null` do JSON. O nó `Convert` é o cast `::text`. Sem ele, uma chamada com constante (`JsonbFn.Push(t.Data.Labels, "a")`) coloca `'a'` inline sem tipo e esbarra no mesmo erro `42804` de antes. Com uma variável capturada funcionava de qualquer jeito, que é exatamente o tipo de bug que passa no code review.

O caminho da função numa migração tem menos código e é mais fácil de ler. Use `HasTranslation` só quando adicionar uma função ao banco de dados não for uma opção.

## Tornando a adição idempotente

Retries, entrega de mensagens at-least-once e botões clicados duas vezes transformam "adicionar" em "adicionar duas vezes". Coloque a guarda no mesmo comando:

```csharp
// .NET 10, EF Core 10.0.4
var n = await db.Tickets
    .Where(t => t.Id == id && !t.Data.Labels.Contains(label))
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Data.Labels, t => JsonbFn.Push(t.Data.Labels, label)));
// n == 1 when the label was added, 0 when it was already there
```

O Npgsql traduz `Contains` sobre uma coleção primitiva JSON para o operador de contenção:

```sql
WHERE t."Id" = @id AND NOT ((t."Data" -> 'Labels') @> to_jsonb(@l))
```

Como o PostgreSQL reavalia a cláusula `WHERE` depois de esperar pelo lock da linha, isso se mantém sob concorrência, não só em sequência. Vinte tasks paralelas adicionando `"dup"` produziram um total de exatamente uma linha afetada e `["hardware", "dup"]`, em todas as execuções. A contagem de linhas afetadas também é a sua resposta para "eu adicionei?", sem uma segunda consulta. Se você precisa de semântica de conjunto entre linhas *diferentes*, por exemplo "dois tickets não podem compartilhar um id externo", isso pertence a um índice único, não a um array JSON.

## Quando você realmente precisa de read-modify-write

Às vezes o novo elemento depende dos existentes, por exemplo "adicione, a menos que o último evento já seja `closed`", e essa lógica não cabe bem em SQL. Nesse caso, mantenha o `SaveChangesAsync`, mas torne os lost updates detectáveis com um token de concorrência otimista. No PostgreSQL, a coluna de sistema `xmin` muda a cada atualização, e o Npgsql a mapeia com uma propriedade `uint` marcada com `[Timestamp]`:

```csharp
// .NET 10, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required TicketData Data { get; set; }

    [Timestamp]
    public uint Version { get; set; }   // mapped to xmin, no migration column
}
```

Agora uma gravação desatualizada lança `DbUpdateConcurrencyException` em vez de vencer silenciosamente, e você faz o retry recarregando. Com os mesmos 20 escritores paralelos e um loop de recarregar e tentar de novo, todos os 21 labels chegaram, ao custo de **167** conflitos e retries. Esse número é o motivo de a adição dentro do banco ser a recomendação padrão. A concorrência otimista está correta, mas sob contenção numa linha disputada ela vira uma tempestade de retries.

## Armadilhas que vale conhecer antes da produção

- **`ExecuteSqlRawAsync` e `SqlQueryRaw` tratam chaves como buracos de formatação, mesmo com zero parâmetros.** `ExecuteSqlRawAsync("... jsonb_set(\"Data\", '{Labels}', ...)")` lança `FormatException: Input string was not in a correct format` antes de qualquer coisa chegar ao PostgreSQL. Duplique as chaves (`'{{Labels}}'`) ou use o `ExecuteSqlAsync` interpolado com uma raw string `$$`, como mostrado acima.
- **Adicionar um array adiciona os elementos dele, não o array.** `'["a"]' || '["b"]'` é `["a", "b"]`. Se o elemento que você adiciona puder ser ele próprio um array, envolva-o: `|| jsonb_build_array(@x::jsonb)`.
- **`to_jsonb` de uma string JSON devolve uma string.** `'["a"]' || to_jsonb('{"k":1}'::text)` adiciona o *texto* `"{\"k\":1}"`. Objetos serializados precisam de `::jsonb`, não de `to_jsonb`.
- **`jsonb_set` não cria pais inexistentes.** `jsonb_set('{}', '{A,B}', '[1]')` retorna `{}` sem alteração. Para um caminho aninhado, garanta que o objeto pai exista, ou construa-o com `jsonb_set` um nível de cada vez.
- **Coleções complexas não podem ser o tipo de retorno de uma função mapeada.** Mapear `List<TicketEvent> PushEvent(List<TicketEvent>, string)` falha na construção do modelo com `The DbFunction 'JsonbFn.PushEvent(...)' has an invalid return type 'List<TicketEvent>'`. Para arrays de objetos, use a Opção 1.
- **A ordem é a ordem de commit, não a ordem de chamada.** Adições concorrentes chegam na ordem em que suas transações fazem commit, então `l11` pode vir antes de `l10`. Se a ordem importa, adicione um timestamp ou número de sequência e ordene na leitura.
- **Fique de olho no tamanho do documento.** Cada adição reescreve o valor `jsonb` inteiro em disco (o PostgreSQL não tem atualização de JSON in-place, e valores grandes passam por TOAST). Um histórico que cresce sem limite pertence a uma tabela própria.
- **Owned types não ganham isso.** O suporte do EF Core a `ExecuteUpdate` para JSON exige `ComplexProperty(...).ToJson()`. Se você ainda está em `OwnsOne(...).ToJson()`, só a Opção 1 se aplica.

### Leia a seguir

- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre o mapeamento com `ToJson()` sobre o qual este post se apoia.
- [Complex types vs owned entities no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explica por que `ExecuteUpdate` em JSON só funciona para complex types.
- [Como usar ExecuteUpdate e ExecuteDelete para gravações em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) aprofunda as atualizações baseadas em conjunto, incluindo seus pontos cegos no change tracker.
- [EF Core ExecuteUpdate vs carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) compara os dois caminhos de gravação de modo geral.
- [Como implementar concorrência otimista com um token rowversion no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) é o equivalente para SQL Server da abordagem com `xmin` acima.

### Fontes

- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html), documentação do PostgreSQL (`||`, `@>`, `jsonb_set`, `jsonb_insert`)
- [Transaction Isolation: Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), documentação do PostgreSQL
- [JSON Mapping](https://www.npgsql.org/efcore/mapping/json.html), documentação do provider Npgsql para EF Core
- [Concurrency Tokens](https://www.npgsql.org/efcore/modeling/concurrency.html), documentação do provider Npgsql para EF Core (`xmin`)
- [What's New in EF Core 10: ExecuteUpdate support for relational JSON columns](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#executeupdate-support-for-relational-json-columns), Microsoft Learn
- [User-defined function mapping](https://learn.microsoft.com/en-us/ef/core/querying/user-defined-function-mapping), documentação do EF Core
- [`NpgsqlQuerySqlGenerator.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Query/Internal/NpgsqlQuerySqlGenerator.cs), npgsql/efcore.pg
