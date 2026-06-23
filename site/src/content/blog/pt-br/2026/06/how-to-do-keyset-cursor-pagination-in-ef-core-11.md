---
title: "Como fazer paginação por keyset (cursor) no EF Core 11"
description: "Substitua Skip/Take por uma cláusula WHERE que avança além da última linha que você viu. Ordene por uma chave totalmente única, carregue os valores da última linha como um cursor, e o EF Core 11 transforma a próxima página em um index seek em vez de um scan com OFFSET."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Resposta curta: pare de paginar com `Skip(n).Take(pageSize)` e comece a paginar com uma cláusula `WHERE`. A paginação por keyset (também chamada de paginação por cursor ou por seek) lembra os valores de ordenação da última linha da página que você acabou de exibir e então pede ao banco de dados as linhas que vêm depois dela na ordenação: `OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Where(x => x.CreatedAt > lastDate || (x.CreatedAt == lastDate && x.Id > lastId)).Take(pageSize)`. Com um índice nas colunas de ordenação, cada página é um index seek de custo constante, em vez de um `OFFSET` que re-escaneia e descarta todas as linhas antes da página. O único requisito rígido: ordene por algo totalmente único, o que na prática significa uma chave de ordenação real mais a chave primária como critério de desempate.

Este post usa `Microsoft.EntityFrameworkCore` 11.0.0 no .NET 11 com C# 14, contra o SQL Server 2025. Tudo aqui funciona da mesma forma no PostgreSQL e no SQLite; a única observação específica de provedor está no final. Se você já assistiu a página 500 de um grid demorar dez vezes mais que a página 1, esta é a correção.

## Por que Skip/Take fica mais lento quanto mais fundo você pagina

A paginação por offset é a primeira coisa óbvia que todo mundo escreve. Tamanho de página 20, página 30, pular 580 linhas:

```csharp
// .NET 11, EF Core 11.0.0 - offset pagination, the slow way
var page = 30;
var pageSize = 20;

var posts = await context.Posts
    .OrderBy(p => p.PostId)
    .Skip((page - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync();
```

O EF Core traduz `Skip`/`Take` para SQL `OFFSET`/`FETCH` (ou `LIMIT`/`OFFSET` no PostgreSQL e SQLite):

```sql
SELECT [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
ORDER BY [p].[PostId]
OFFSET 580 ROWS FETCH NEXT 20 ROWS ONLY;
```

O problema é o que `OFFSET 580` de fato faz. O banco de dados não pula para a linha 581. Ele produz todas as 600 linhas em ordem, conta as primeiras 580, descarta-as e retorna as últimas 20. O trabalho escala com o offset, não com o tamanho da página, então páginas profundas ficam progressivamente mais caras. Em uma tabela quente isso é exatamente o oposto do que os usuários esperam: quanto mais eles rolam, mais lento fica.

Há um segundo bug, mais silencioso. A paginação por offset não é estável sob escritas concorrentes. O [guia oficial de paginação](https://learn.microsoft.com/en-us/ef/core/querying/pagination) do EF Core deixa isso claro: se uma linha é inserida ou excluída entre duas requisições de página, todo o conjunto de resultados se desloca em uma posição, e um usuário indo da página 2 para a página 3 ou vê uma linha duas vezes ou pula uma inteiramente. Para um grid de administração, ninguém percebe. Para um feed de scroll infinito onde linhas estão constantemente sendo adicionadas no topo, é um defeito visível e reproduzível.

## O que uma consulta por keyset faz no lugar

A paginação por keyset descarta a ideia de um offset. Em vez de "pular 580 linhas", você diz "me dê as linhas que vêm depois desta linha específica que eu já tenho". Você lembra os valores de ordenação da última linha, e a próxima página é um `WHERE` que avança direto além deles:

```csharp
// .NET 11, EF Core 11.0.0 - keyset pagination, single unique key
var pageSize = 20;
int? lastPostId = 580; // the PostId of the last row on the previous page; null for page 1

var query = context.Posts.OrderBy(p => p.PostId).AsQueryable();

if (lastPostId is int cursor)
{
    query = query.Where(p => p.PostId > cursor);
}

var posts = await query.Take(pageSize).ToListAsync();
```

Isso traduz para:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[PostId] > 580
ORDER BY [p].[PostId];
```

Com um índice em `PostId` (a chave primária clusterizada já é um), o banco de dados avança diretamente para a primeira linha maior que 580 e lê 20 linhas. Não há scan-e-descarte. A página 1 e a página 10.000 custam o mesmo. E como o cursor é um valor, não uma posição, uma inserção ou exclusão em outro lugar da tabela não pode deslocar sua janela: você sempre continua da exata linha que viu por último.

A pegadinha está no nome: a paginação por keyset precisa de uma *chave*. A coluna (ou colunas) pela qual você ordena precisa produzir uma ordem total e estrita entre as linhas. Se duas linhas podem empatar na chave de ordenação, a comparação `>` não consegue dizer ao banco de dados de que lado da fronteira uma linha empatada pertence, e você vai silenciosamente pular ou repetir linhas. `PostId` é único, então funciona sozinho. Um timestamp `CreatedAt` quase nunca é único, então não funciona, e é aí que a maioria das consultas reais vive.

## Ordenando por uma coluna não única: adicione um critério de desempate

O caso realista é "mais recentes primeiro", ordenando por um `CreatedAt` que pode colidir até no milissegundo. A correção que a documentação aponta em um aviso no topo da [página de paginação](https://learn.microsoft.com/en-us/ef/core/querying/pagination) é tornar a ordenação totalmente única acrescentando uma coluna única, quase sempre a chave primária:

```csharp
// .NET 11, EF Core 11.0.0 - keyset over (CreatedAt DESC, PostId DESC)
var pageSize = 20;

// Cursor carried from the last row of the previous page (null on page 1).
DateTime? lastCreatedAt = previousCursor?.CreatedAt;
int? lastPostId = previousCursor?.PostId;

var query = context.Posts
    .OrderByDescending(p => p.CreatedAt)
    .ThenByDescending(p => p.PostId)
    .AsQueryable();

if (lastCreatedAt is DateTime ca && lastPostId is int id)
{
    // Rows that sort strictly after the cursor in (CreatedAt DESC, PostId DESC).
    query = query.Where(p =>
        p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
}

var posts = await query.Take(pageSize).ToListAsync();
```

A cláusula `WHERE` é todo o truque, então leia com cuidado. Você está ordenando de forma descendente, então "depois do cursor" significa menor. Uma linha pertence à próxima página se seu `CreatedAt` for estritamente mais antigo que o do cursor (`p.CreatedAt < ca`), ou se seu `CreatedAt` empata exatamente e seu `PostId` desempata na mesma direção (`p.CreatedAt == ca && p.PostId < id`). Esse ramo `==` é a parte que as pessoas esquecem, e esquecê-lo é exatamente como linhas que compartilham um timestamp acabam sendo puladas nas fronteiras de página. A direção da comparação no `WHERE` precisa espelhar a direção do `OrderBy` com precisão: ordem ascendente usa `>`, descendente usa `<`. Misture-as e suas páginas ou se sobrepõem ou deixam lacunas.

O SQL gerado é um único seek:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[CreatedAt] < @ca OR ([p].[CreatedAt] = @ca AND [p].[PostId] < @id)
ORDER BY [p].[CreatedAt] DESC, [p].[PostId] DESC;
```

## Montando tudo de ponta a ponta

Aqui está o ciclo completo: codifique o cursor, retorne-o com a página, decodifique-o na próxima requisição. Os passos são os mesmos quer o cursor viaje em uma query string ou no corpo de uma resposta de API.

1. **Escolha uma ordenação totalmente única.** Uma coluna de ordenação significativa mais a chave primária como critério final de desempate. A ordem das colunas aqui é a ordem que todo o resto precisa seguir.
2. **Defina um índice que corresponda exatamente à ordenação.** Um índice composto sobre `(CreatedAt DESC, PostId DESC)` permite que o seek leia linhas já em ordem. Sem ele, o banco de dados ordena a tabela inteira a cada página e o ganho evapora.
3. **Construa o `WHERE` a partir dos valores da última linha.** Um ramo `OR` por coluna de ordenação, com a direção da comparação correspondendo à direção de ordenação de cada coluna.
4. **Pegue `pageSize` linhas.** Opcionalmente `pageSize + 1` para que você possa dizer se existe uma próxima página sem uma segunda consulta.
5. **Emita um cursor a partir da última linha retornada** e devolva-o ao chamador para enviar com a próxima requisição.

Um endpoint mínimo que retorna uma página mais um cursor opaco:

```csharp
// .NET 11, EF Core 11.0.0, C# 14 - minimal API keyset endpoint
app.MapGet("/posts", async (string? cursor, AppDbContext db) =>
{
    const int pageSize = 20;

    var query = db.Posts
        .AsNoTracking()
        .OrderByDescending(p => p.CreatedAt)
        .ThenByDescending(p => p.PostId)
        .AsQueryable();

    if (Cursor.TryDecode(cursor, out var ca, out var id))
    {
        query = query.Where(p =>
            p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
    }

    // Fetch one extra row to detect whether a further page exists.
    var rows = await query.Take(pageSize + 1).ToListAsync();

    var hasMore = rows.Count > pageSize;
    var page = rows.Take(pageSize).ToList();

    var next = hasMore && page.Count > 0
        ? Cursor.Encode(page[^1].CreatedAt, page[^1].PostId)
        : null;

    return Results.Ok(new { items = page, nextCursor = next });
});
```

O helper `Cursor` apenas empacota os dois valores em um token seguro para URL, para que os chamadores o tratem como opaco e não possam adulterar a semântica da paginação:

```csharp
// .NET 11, C# 14 - opaque cursor encode/decode
static class Cursor
{
    public static string Encode(DateTime createdAt, int id) =>
        Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{createdAt.Ticks}:{id}"));

    public static bool TryDecode(string? token, out DateTime createdAt, out int id)
    {
        createdAt = default;
        id = default;
        if (string.IsNullOrEmpty(token)) return false;

        var parts = Encoding.UTF8
            .GetString(Convert.FromBase64String(token))
            .Split(':');
        if (parts.Length != 2) return false;

        createdAt = new DateTime(long.Parse(parts[0]), DateTimeKind.Utc);
        id = int.Parse(parts[1]);
        return true;
    }
}
```

Note o `AsNoTracking()` na consulta. Estas são linhas de lista somente leitura, então não há razão para pagar pelo rastreador de mudanças; se você não tem certeza de quando isso importa, veja [AsNoTracking vs AsNoTrackingWithIdentityResolution no EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/). Para um endpoint de lista quente, esta consulta também é forte candidata a uma [consulta compilada](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), já que o formato nunca muda entre requisições.

## O índice não é opcional

A paginação por keyset só é rápida se o banco de dados puder fazer o seek. Isso exige um índice cujas colunas de chave e direções correspondam exatamente ao seu `OrderBy`:

```csharp
// .NET 11, EF Core 11.0.0 - composite index matching the page order
modelBuilder.Entity<Post>()
    .HasIndex(p => new { p.CreatedAt, p.PostId })
    .IsDescending(true, true);
```

O guia oficial é categórico sobre isso na [seção de índices](https://learn.microsoft.com/en-us/ef/core/querying/pagination): seu índice precisa corresponder à sua ordenação de paginação. Se você ordena por `(CreatedAt DESC, PostId DESC)` mas indexa `(CreatedAt ASC, PostId ASC)`, muitos bancos de dados ainda conseguem escanear o índice para trás, mas no momento em que você adiciona uma terceira coluna ou uma direção incompatível, o planejador recorre a uma ordenação sobre o conjunto filtrado inteiro e sua página de custo constante se foi. A direção do índice é parte do contrato, não um detalhe. Esta é a mesma classe de problema de "o plano de consulta está fazendo algo que você não pediu" que uma [consulta N+1](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) acidental: o LINQ parece bom, mas o plano conta a história real, então verifique o plano de execução real uma vez antes de colocar em produção.

## Por que não a sintaxe de tupla que você já viu em SQL puro

Se você já escreveu paginação por keyset em SQL feito à mão, provavelmente usou comparação de valores de linha: `WHERE (CreatedAt, PostId) < (@ca, @id)`. É a forma mais limpa de expressar a mesma fronteira, a maioria dos bancos de dados relacionais a suporta, e tende a produzir um plano melhor que a cadeia de `OR` desdobrada. A má notícia para o EF Core 11: você ainda não pode escrevê-la em LINQ. A documentação observa isso explicitamente, e está sendo acompanhado em [dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822), que permanece aberto a partir do EF Core 11.0.0. Então a expansão manual de `OR` acima não é uma gambiarra que você vai descartar na próxima versão; é a abordagem suportada atual.

Se você ordena por três ou mais colunas, a cadeia de `OR` cresce rápido e fica propensa a erros. O padrão generaliza de forma mecânica: para chaves de ordenação `a, b, c`, o predicado é `a > a0 || (a == a0 && b > b0) || (a == a0 && b == b0 && c > c0)`. Quando você tem mais de duas chaves, recorra a um helper mantido como `MR.EntityFrameworkCore.KeysetPagination`, que constrói essa árvore de expressão para você a partir da mesma definição de `OrderBy` e mantém o `WHERE` em sincronia com a ordenação. Escrever à mão cadeias de `OR` com quatro níveis de profundidade é como o ramo `==` acaba sendo esquecido.

## Paginando para trás e outros casos extremos

Algumas coisas mordem as pessoas depois que o caminho feliz funciona:

- **Página anterior.** Para paginar para trás, inverta cada comparação e cada direção de `OrderBy`, pegue uma página e então reverta a lista em memória antes de retorná-la. Você não pode reutilizar a consulta para frente com um cursor "antes" e a mesma ordenação; as linhas voltariam na ordem errada.
- **O usuário não tem acesso aleatório.** A paginação por keyset suporta próxima e anterior, não "pular para a página 47". Isso é inerente, não um bug. Se você realmente precisa de saltos por número de página, a documentação sugere um híbrido: keyset para próxima/anterior, offset apenas para o salto aleatório raro. A maioria dos feeds e scrolls infinitos nunca precisa do salto.
- **Contagem total.** O keyset te dá linhas, não uma contagem de páginas restantes. Se a UI precisa de "página 3 de 200", essa contagem é uma consulta `COUNT(*)` separada, e em uma tabela grande costuma ser a parte cara, então faça cache dela ou abandone o requisito.
- **Colunas de ordenação anuláveis.** Se sua coluna de ordenação é anulável, comparações com `NULL` não vão se comportar como `>`/`<`, e linhas com `NULL` podem sumir da paginação. Ou ordene por colunas não anuláveis ou adicione um ramo explícito de ordenação de `NULL`.
- **Estabilidade do cursor.** O cursor codifica valores, então permanece válido mesmo se linhas forem inseridas ou excluídas ao redor dele, que é todo o ponto. Ele quebra se a *linha para a qual aponta* é excluída e você depende de ler essa linha de volta; como você só compara contra os valores dela, isso é tranquilo, mas não assuma que a linha do cursor ainda existe.

A paginação por offset nem sempre está errada. Para uma tabela de administração pequena, ou qualquer grid onde os usuários realmente clicam em números de página, `Skip`/`Take` é mais simples e a diferença de desempenho é invisível. No momento em que a tabela é grande, intensiva em inserções, ou rolada profundamente, o keyset é a versão que permanece rápida e permanece correta. Ordene por uma chave única, construa o `WHERE` para corresponder a ela exatamente, indexe essas colunas na mesma direção, e sua página mais profunda custa o mesmo que a primeira.

## Relacionados

- [How to use query splitting to avoid a cartesian explosion in EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)

## Fontes

- [Pagination - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/pagination)
- [Indexes - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/modeling/indexes)
- [Support row value comparisons for keyset pagination - dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822)
- [MR.EntityFrameworkCore.KeysetPagination (GitHub)](https://github.com/mrahhal/MR.EntityFrameworkCore.KeysetPagination)
