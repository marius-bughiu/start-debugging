---
title: "IEnumerable vs IAsyncEnumerable vs IQueryable em C#: qual o método deve retornar?"
description: "Três interfaces de sequência, três modelos de execução. Use IQueryable quando um banco de dados puder traduzir a consulta, IAsyncEnumerable quando o produtor for assíncrono e você quiser transmitir, IEnumerable para tudo o mais em memória."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "linq"
  - "ef-core"
  - "async"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-21
---

Se você está escolhendo entre `IEnumerable<T>`, `IAsyncEnumerable<T>` e `IQueryable<T>` para a assinatura de um método em C# 14 / .NET 11, a regra é quase mecânica. Retorne `IQueryable<T>` apenas quando o consumidor puder compor mais chamadas `Where`/`Select`/`OrderBy` e o provedor subjacente (EF Core 11, LINQ to SQL, um cliente OData) puder traduzi-las na consulta remota. Retorne `IAsyncEnumerable<T>` quando o produtor faz E/S por item ou por lote e você quer que o consumidor comece a processar antes do produtor terminar. Retorne `IEnumerable<T>` para tudo o que já está em memória ou que você decidiu materializar completamente na fronteira. O erro a evitar é vazar `IQueryable<T>` para fora de um repositório: cada `.Where(...)` subsequente passa a fazer parte do SQL, queira você ou não, e "onde essa consulta realmente executa" vira uma pergunta que você precisa responder com o depurador.

Esta publicação é a versão longa. Todos os exemplos têm como alvo `<TargetFramework>net11.0</TargetFramework>` com `<LangVersion>14.0</LangVersion>` e, quando relevante, `Microsoft.EntityFrameworkCore 11.0.0`.

## Três interfaces, três modelos de execução

As três interfaces parecem semelhantes no papel. Todas expõem uma única sequência de `T`. A diferença é onde o trabalho acontece e quando.

- `IEnumerable<T>` é uma sequência síncrona baseada em pull. `MoveNext` executa na thread chamadora. O produtor é um método que entrega itens, um `List<T>`, um `T[]` ou uma cadeia LINQ to Objects. O produtor não pode aguardar nada com `await`.
- `IAsyncEnumerable<T>` é uma sequência assíncrona baseada em pull. `MoveNextAsync` retorna um `ValueTask<bool>`, o que permite ao produtor aguardar entre itens. O consumidor itera com `await foreach`. Introduzido no C# 8 / .NET Core 3.0; de primeira classe no LINQ moderno via o pacote `System.Linq.Async` e o `AsAsyncEnumerable` do EF Core.
- `IQueryable<T>` é um construtor de árvore de expressões. Cada `Where`, `Select` ou `OrderBy` que você encadeia em um `IQueryable<T>` anexa um nó à árvore de expressões. A árvore só é traduzida em algo executável (uma instrução SQL, uma URL OData, uma consulta do Cosmos) quando você chama um operador terminal (`ToList`, `FirstOrDefault`, `Count`, `ToListAsync`). Até lá, nenhuma E/S aconteceu.

A consequência mais importante: um `IEnumerable<T>` retornado por uma chamada do EF Core já saiu do banco de dados. Um `IQueryable<T>` retornado pela mesma chamada não saiu. Esse único fato é responsável por mais tickets de "por que essa consulta está lenta" do que qualquer outra causa única em código de EF Core.

## Matriz de recursos

| Capacidade                                      | `IEnumerable<T>`         | `IAsyncEnumerable<T>`        | `IQueryable<T>`                     |
| ----------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------------- |
| Modelo de execução                              | pull síncrono            | pull assíncrono              | adiado, traduzido por um provedor   |
| Onde o trabalho executa                         | thread chamadora, em memória| lado do produtor, aguardável | provedor remoto (BD, OData, Cosmos) |
| Pode usar `await` entre itens                   | não                      | sim                          | n/a (sem trabalho por item)         |
| Operadores LINQ disponíveis                     | LINQ to Objects          | LINQ to Objects (Async)      | subconjunto específico do provedor  |
| Componível após o retorno                       | sim (em memória)         | sim (em memória)             | sim (traduzido remotamente)         |
| Transmite sem buffer                            | sim (`yield return` lazy)| sim                          | depende do provedor                 |
| Cancelamento                                    | nenhum, o loop é síncrono| `CancellationToken` por item | por consulta via `ToListAsync(token)`|
| Risco ao retornar de um repositório             | baixo                    | médio (vida do provedor)     | alto (o chamador pode anexar SQL)   |
| Melhor encaixe                                  | coleções em memória      | streams remotos, server-sent | objetos de consulta internos ao repo|
| Materializa quando                              | em cada `MoveNext`       | em cada `await MoveNextAsync`| no operador terminal                |

A matriz é a publicação. Tudo abaixo é o raciocínio.

## Quando `IEnumerable<T>` é o tipo de retorno certo

`IEnumerable<T>` é o padrão para "eu tenho itens, me dê uma sequência". É síncrono, tem todos os operadores LINQ to Objects e compõe barato. Use-o para:

- Um método que entrega de uma coleção em memória ou uma computação pura.
- Um método que já materializou os dados e agora retorna uma visão sobre eles (`return list.Where(x => x.IsActive);`).
- Um método que percorre uma fonte síncrona como um arquivo que você lê com `File.ReadLines` ou um DOM desserializado.

A armadilha é usar `IEnumerable<T>` como tipo de retorno de um método de repositório que envolve uma chamada de E/S assíncrona. Isso força o repositório a fazer `.ToList()` internamente e perder a propriedade de streaming, ou força o chamador a usar `.Result` e um bloqueio do thread pool. Ambos estão errados. Se a fonte é assíncrona, a assinatura deve ser `IAsyncEnumerable<T>` ou `Task<List<T>>`, não `IEnumerable<T>`.

```csharp
// .NET 11, C# 14
public static IEnumerable<string> ReadLowercaseLines(string path)
{
    foreach (var line in File.ReadLines(path))
    {
        yield return line.ToLowerInvariant();
    }
}
```

`File.ReadLines` retorna um `IEnumerable<string>` que lê o arquivo de forma lazy. A transformação permanece lazy. Nada força o arquivo a ser carregado por completo antes que o primeiro item chegue ao chamador.

A palavra-chave `yield return` é o que faz isso funcionar. Ela diz ao compilador para gerar uma máquina de estados que retorna itens um de cada vez, suspendendo o método entre yields. É o espelho síncrono de `await foreach` mais `yield return` juntos.

## Quando `IAsyncEnumerable<T>` é o tipo de retorno certo

`IAsyncEnumerable<T>` é o que você usa quando o produtor precisa aguardar com `await` entre itens. O exemplo cardinal é um endpoint HTTP paginado: você busca a página 1, entrega cada item, busca a página 2, entrega cada item. Você quer que o consumidor comece a trabalhar na página 1 enquanto a página 2 ainda está em voo. Você também quer um `CancellationToken` conectado para que o consumidor possa parar o produtor de forma limpa.

Use-o para:

- Fontes remotas paginadas (APIs HTTP que retornam páginas, Server-Sent Events, consumidores de fila de mensagens).
- Consultas EF Core 11 que transmitem resultados para um CSV ou para outra resposta HTTP sem materializar em memória.
- Qualquer produtor onde a contrapressão importa: o consumidor lê, processa, e só então pede o próximo item.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<Order> FetchAllAsync(
    HttpClient http,
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    string? next = "/api/orders?page=1";
    while (next is not null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = await http.GetFromJsonAsync<PageOf<Order>>(next, cancellationToken)
                   ?? throw new InvalidOperationException("page was null");
        foreach (var order in page.Items)
        {
            yield return order;
        }
        next = page.NextLink;
    }
}
```

Dois detalhes que pegam as pessoas. Primeiro, `[EnumeratorCancellation]` é obrigatório para conectar o token de `WithCancellation(...)` no local da chamada ao iterador. Sem ele, chamar `await foreach (var x in source.WithCancellation(token))` silenciosamente descarta o token. Segundo, um método iterador assíncrono não pode usar `try/catch` ao redor de um `yield return` para uma exceção que vem de um operador downstream; a exceção flui pelo consumidor, não pelo produtor. Envolva as chamadas de E/S explicitamente quando precisar de lógica de retry.

Para EF Core 11, o equivalente em um `DbSet<T>` é `AsAsyncEnumerable`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
await foreach (var order in db.Orders
    .Where(o => o.Status == "shipped")
    .AsAsyncEnumerable()
    .WithCancellation(cancellationToken))
{
    await sink.WriteAsync(order, cancellationToken);
}
```

Isso mantém o leitor de dados SQL aberto e puxa linhas sob demanda. O conjunto completo nunca fica em `List<Order>`. Para os detalhes específicos do EF Core, veja [como usar IAsyncEnumerable com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

## Quando `IQueryable<T>` é o tipo de retorno certo

`IQueryable<T>` é a forma certa dentro de um repositório ou de um helper de construção de consultas, onde o chamador ainda é esperado para compor. É a forma errada cruzando uma fronteira de rede ou saindo de uma camada que o próximo chamador pode não entender.

Use-o para:

- Uma extensão `Queryable` que recebe um `IQueryable<T>` existente e adiciona uma cláusula `Where`: `q.WhereActive()`. O provedor traduz o predicado; você nunca executa sobre dados materializados.
- Um método de repositório que expõe uma consulta estreita e específica do projeto que o chamador vai filtrar, paginar ou contar adicionalmente: `IQueryable<Invoice> Unpaid(int customerId)`.
- Uma API de biblioteca onde o consumidor é esperado para construir expressões, como um controlador OData ou um DSL de busca personalizado.

O padrão que morde é expor `IQueryable<T>` de uma camada de serviço que o chamador assume que retorna dados em memória:

```csharp
// Antipadrão: não retorne IQueryable<T> de um serviço público
public IQueryable<Order> GetRecentOrders() => _db.Orders.Where(o => o.At > _start);

// Chamador, a quilômetros de distância
var bad = service.GetRecentOrders()
                 .Where(o => SomeLocalMethod(o))   // EF Core lança: não traduzível
                 .OrderBy(o => o.Total)
                 .Take(50)
                 .ToList();
```

`SomeLocalMethod` é um método C# que o EF Core não consegue traduzir. A chamada `Where` anexa uma expressão que o provedor não consegue rebaixar para SQL, e na materialização você obtém uma exceção. Ou pior, em um provedor que cai silenciosamente para avaliação em cliente, você acidentalmente puxa todas as linhas pela rede para filtrar em processo. O EF Core 11 lança por padrão; código mais antigo com mudanças `AsEnumerable` inseridas no meio de uma cadeia é ainda mais difícil de ler.

A correção é materializar na fronteira:

```csharp
// .NET 11, C# 14
public async Task<IReadOnlyList<Order>> GetRecentOrdersAsync(
    int count, CancellationToken ct)
{
    return await _db.Orders
        .Where(o => o.At > _start)
        .OrderByDescending(o => o.At)
        .Take(count)
        .ToListAsync(ct);
}
```

O método agora retorna uma coleção concreta e materializada. O chamador não pode acidentalmente anexar SQL. Se o chamador quer um filtro diferente, ele pede explicitamente via um parâmetro ou um novo método. Esta é a mesma razão que motiva [como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): seja explícito sobre onde fica a fronteira da consulta.

## O benchmark: transmitindo um milhão de linhas de três formas

Um número real. A configuração: 1.000.000 de linhas estreitas (um `Guid Id`, um `int Status`, um `DateTime At`) no SQL Server 2022. O consumidor conta linhas que passam um filtro (`Status == 1`) e escreve uma soma de timestamps. Fazemos isso de três formas:

- `IEnumerable<T>` produzido por `ToList()` e depois enumerado.
- `IAsyncEnumerable<T>` produzido por `AsAsyncEnumerable()`.
- `IQueryable<T>` consumido dentro do mesmo método via `await Where(...).CountAsync()`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, BenchmarkDotNet 0.14.0
[MemoryDiagnoser]
public class SequenceShapes
{
    private AppDb _db = null!;

    [GlobalSetup] public void Setup() => _db = AppDb.Connect();

    [Benchmark]
    public long Materialize_Then_Enumerate()
    {
        var rows = _db.Events.ToList();              // pull all 1,000,000
        long sum = 0; long count = 0;
        foreach (var r in rows)
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark]
    public async Task<long> StreamAsync()
    {
        long sum = 0; long count = 0;
        await foreach (var r in _db.Events.AsAsyncEnumerable())
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark(Baseline = true)]
    public async Task<long> Queryable_Aggregate()
    {
        var count = await _db.Events.Where(e => e.Status == 1).CountAsync();
        var sum   = await _db.Events.Where(e => e.Status == 1)
                                    .SumAsync(e => (long)e.At.Ticks);
        return sum + count;
    }
}
```

Metodologia: BenchmarkDotNet 0.14.0, .NET 11.0.0 RTM, EF Core 11.0.0, SQL Server 2022 16.0.4135 na mesma máquina sobre loopback. Windows 11 24H2, AMD Ryzen 9 7900X, 64 GB DDR5. Os números são uma execução representativa.

| Método                          | Média        | Alocado     |
| ------------------------------- | ------------ | ----------- |
| Queryable_Aggregate (baseline)  | 38 ms        | 1,4 KB      |
| StreamAsync                     | 1.210 ms     | 410 MB      |
| Materialize_Then_Enumerate      | 1.380 ms     | 432 MB      |

O padrão é consistente com como as três interfaces funcionam. `IQueryable<T>` deixa o banco de dados fazer a contagem e a soma e enviar dois escalares de volta. `IAsyncEnumerable<T>` te economiza cerca de 12 por cento do tempo total em relação a `ToList`-e-loop, e te economiza o perfil de memória em forma de pico (a alocação de `List<Event>` em `Materialize_Then_Enumerate` é visível em `dotnet-counters` como um único pico `gen2`). Mas ambas perdem para a forma queryable por 30x porque o trabalho pertencia ao banco de dados, não ao cliente.

A conclusão não é "sempre use IQueryable". É: se a operação pode ser expressa na linguagem de consulta do provedor, não retire as linhas. Se você precisa retirar as linhas (exportação CSV, uma transformação que não traduz, um serviço downstream que quer itens individuais), prefira `IAsyncEnumerable<T>` em vez de um `IEnumerable<T>` materializado.

## As armadilhas que decidem por você

Algumas coisas tomam a decisão por você, independente de preferência.

- **`IQueryable<T>` requer um provedor vivo.** Retornar `IQueryable<T>` de um método cujo `DbContext` é descartado quando o método retorna é um use-after-free disfarçado. A árvore de expressões ainda existe, mas no momento em que o chamador a materializar, voa um `ObjectDisposedException`. Ou mantenha o contexto vivo durante a vida do queryable, ou materialize antes de retornar.

- **`IAsyncEnumerable<T>` requer `[EnumeratorCancellation]`.** Sem ele, o token de cancelamento que um chamador passa via `.WithCancellation(token)` nunca chega ao produtor. O compilador não vai te avisar; o bug é silencioso e o token é ignorado. O analisador do Roslyn `CA1068` detecta o parâmetro faltante; `CA2016` detecta a falta de propagação do token para as chamadas assíncronas internas.

- **Os operadores LINQ diferem.** `Skip`, `Take`, `OrderBy`, `Select`, `Where`, `First`, `Count` existem nos três. Mas `IAsyncEnumerable<T>` precisa do pacote `System.Linq.Async` para `WhereAsync`, `SelectAwait`, `SelectMany`, `GroupBy` e companhia. `IQueryable<T>` só suporta o subconjunto que seu provedor consegue traduzir; tudo o mais ou lança (EF Core 11) ou cai silenciosamente para avaliação em cliente (alguns provedores mais antigos).

- **`IQueryable<T>` vaza o modelo de persistência.** Se o chamador pode escrever `.Where(...)`, o chamador está escrevendo SQL. Refatorar o nome de uma coluna na entidade vira uma mudança de busca-em-todo-o-código porque todo consumidor queryable está tocando aquela coluna. Um repositório que retorna DTOs materializados esconde o esquema; um que retorna `IQueryable<Entity>` não.

- **Misturá-los dentro de uma cadeia.** Chamar `.AsEnumerable()` ou `.AsAsyncEnumerable()` no meio de uma cadeia `IQueryable<T>` converte o resto para avaliação em memória. Cada `Where` depois desse ponto executa no cliente. Às vezes é o que você quer (um predicado complexo que não traduz); muitas vezes é um bug de desempenho. Faça a troca explícita e coloque um comentário ao lado.

- **`yield return` dentro de `using` está ok, mas o recurso vive enquanto o iterador viver.** Um iterador síncrono que abre um `FileStream` e entrega linhas mantém o arquivo aberto até o consumidor descartar o enumerador ou terminar de iterar. O mesmo se aplica, com piores modos de falha, a iteradores assíncronos que seguram um `DbDataReader`. Itere sempre até o fim ou chame `await foreach` dentro de um bloco using/awaiting.

## A recomendação opinativa, reformulada

Por padrão, use `IEnumerable<T>` para trabalho em memória. Vá para `IAsyncEnumerable<T>` no momento em que o produtor precisa usar `await`, e conecte `[EnumeratorCancellation]` desde o primeiro dia. Mantenha `IQueryable<T>` dentro da camada de repositório ou construtor de consultas; converta para um `IReadOnlyList<T>` materializado ou para `IAsyncEnumerable<T>` antes de cruzar uma fronteira de serviço.

Dois corolários que vale a pena memorizar:

- "Retorne o menor poder de que o chamador precisa". Um método que conceitualmente retorna uma lista deve retornar `IReadOnlyList<T>`, não `IQueryable<T>`. Poder do qual o chamador não precisa é poder que o chamador pode usar mal.
- "Materialização é uma fronteira". Decida onde acontece uma vez, em um único lugar, e escreva o resto da camada para esse contrato. Bases de código onde todo método retorna `IQueryable<T>` "por garantia" acabam com chamadas `.ToList()` espalhadas aleatoriamente e um orçamento de consultas lentas que ninguém é dono.

## Relacionados

- [Como usar IAsyncEnumerable com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [EF Core 11 vs Dapper para inserções em massa: um benchmark real](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Como usar consultas compiladas com EF Core em caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Como transmitir um arquivo de um endpoint do ASP.NET Core sem buffer](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Fontes

- [IQueryable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.linq.iqueryable-1)
- [IAsyncEnumerable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1)
- [Generate asynchronous streams (async iterators) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream)
- [EnumeratorCancellationAttribute -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Client vs server evaluation -- EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [System.Linq.Async on NuGet](https://www.nuget.org/packages/System.Linq.Async)
