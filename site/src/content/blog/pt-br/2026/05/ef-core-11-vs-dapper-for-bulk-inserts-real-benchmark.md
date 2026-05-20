---
title: "EF Core 11 vs Dapper para inserções em massa: benchmark real"
description: "Para inserções em massa no .NET 11, nem EF Core nem Dapper vencem. SqlBulkCopy vence. Este é o benchmark, o porquê e o lugar que cada ferramenta merece."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "bulk-insert"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark"
translatedBy: "claude"
translationDate: 2026-05-20
---

Se você está inserindo mais do que algumas milhares de linhas no SQL Server a partir do .NET 11, a resposta certa raramente é "EF Core" e raramente é "Dapper". A resposta certa é `SqlBulkCopy`, chamado diretamente a partir da conexão de qualquer uma das duas ferramentas. `AddRange` + `SaveChangesAsync` do EF Core 11 é a escolha mais limpa para menos de 1.000 linhas. `ExecuteAsync` do Dapper com uma lista de parâmetros é o pior dos três em qualquer contagem de linhas e o que se deve evitar para cargas em massa. Abaixo está a tabela de decisão, os números do benchmark por trás dela, e o código para cada caminho sobre `Microsoft.EntityFrameworkCore` 11.0.0, `Microsoft.Data.SqlClient` 6.1 e `Dapper` 2.1.66.

## Matriz de recursos em um relance

| Recurso                                          | EF Core 11 `AddRange`           | Dapper `ExecuteAsync`         | `SqlBulkCopy`                         |
| ------------------------------------------------ | ------------------------------- | ----------------------------- | ------------------------------------- |
| Protocolo subjacente                             | Sentenças `INSERT` em lote      | Sentenças `INSERT` por linha  | TDS bulk copy (carga em massa nativa) |
| Rastreamento de alterações                       | Sim                             | Não                           | Não                                   |
| Valores de identidade preenchidos de volta       | Sim (via `OUTPUT INSERTED.Id`)  | Não (`SELECT SCOPE_IDENTITY()` manual) | Apenas com `KeepIdentity` e valores explícitos |
| Relacionamentos e inserções em cascata           | Sim                             | Não                           | Não                                   |
| Memória com 100K linhas (SQL Server)             | ~centenas de MB                 | ~dezenas de MB                | ~dezenas de MB, amigável a streaming  |
| Tempo de inserção de 100K linhas (ver metodologia) | ~2,1 s                        | ~10,9 s                       | ~0,65 s                               |
| Tempo de inserção de 1M linhas                   | ~21,6 s                         | ~109 s                        | ~7,3 s                                |
| Apenas SQL Server                                | Não (funciona em qualquer provider do EF) | Não                | Sim (`Microsoft.Data.SqlClient`)      |
| Complexidade de código                           | Menor                           | Baixa                         | Média (mapeamento de tabela necessário) |
| Funciona com streaming `IAsyncEnumerable<T>`     | Não (carrega entidades primeiro) | Não                          | Sim (via `IDataReader`)               |
| Transação com o resto do unit-of-work do EF      | Sim                             | Manual                        | Manual (`SqlTransaction`)             |
| Licença                                          | MIT                             | Apache 2.0                    | MIT                                   |

A tabela é a recomendação. Tudo abaixo é o *porquê*.

## Quando `AddRange` + `SaveChangesAsync` do EF Core 11 está correto

EF Core 11 agrupa inserções de forma inteligente. O provider do SQL Server agrupa entidades inseridas em sentenças `INSERT ... VALUES (...), (...), ...` de várias linhas até 1.000 linhas por lote (o limite rígido do SQL Server para parâmetros com valores de tabela), ou divide aos 2.100 parâmetros por lote, o que ocorrer primeiro. Para uma entidade de 200 colunas, o tamanho prático do lote colapsa para uma cifra de uma só linha porque os parâmetros dominam; para uma entidade de cinco colunas, você obtém os lotes completos de 1.000 linhas.

Escolha `AddRange` quando:

- Você está inserindo menos de ~1.000 linhas em uma única chamada.
- As entidades têm relacionamentos (um pai e seus filhos) que o rastreador de alterações do EF Core gerencia para você em uma única transação.
- Você precisa que os valores de identidade gerados pelo banco de dados sejam escritos de volta nas instâncias da entidade (`OUTPUT INSERTED.Id` faz isso automaticamente no EF Core 11).
- A mesma unidade de trabalho também atualiza ou exclui outras entidades. Colocar a inserção em massa dentro do `SaveChangesAsync` existente significa uma transação, um conjunto de hooks pré/pós, e os [eventos do `ChangeTracker`](https://learn.microsoft.com/en-us/ef/core/change-tracking/) ainda disparam.

```csharp
// .NET 11, EF Core 11.0.0
public async Task InsertEventsAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var db = new AppDbContext(_options);
    db.TelemetryEvents.AddRange(events);
    await db.SaveChangesAsync(ct);
}
```

Este é o lugar para o qual o EF Core foi projetado. O custo é alocação: cada entidade é materializada, rastreada por alterações, e mantida no `DbContext` até que `SaveChanges` faça commit. Para 100K linhas de uma entidade larga, isso é centenas de megabytes de pressão sobre o GC. Para 1.000 linhas, é irrelevante.

Se você for por esse caminho para lotes médios, dois botões ajudam:

- `AsNoTracking` não é a alavanca relevante para inserções (ela afeta consultas). Em vez disso, use um `DbContext` de vida curta por lote e descarte-o.
- `ChangeTracker.AutoDetectChangesEnabled = false;` antes do `AddRange` e reative-o depois. EF Core 11 ainda executa `DetectChanges` dentro do `SaveChangesAsync`, mas pular isso em cada atribuição de propriedade economiza CPU mensurável em entidades largas.

## Quando `ExecuteAsync` do Dapper está correto (e quando não)

A história em massa do Dapper é famosamente simples: passe uma coleção, obtenha um INSERT por linha em uma única ida e volta de rede.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
await conn.ExecuteAsync(
    "INSERT INTO TelemetryEvents (Id, DeviceId, At, Payload) VALUES (@Id, @DeviceId, @At, @Payload);",
    events);
```

Agradável de escrever. Lento em escala. Dapper envia uma sentença parametrizada por elemento na coleção, agrupada em uma única ida e volta de rede. SQL Server ainda analisa, planeja, e executa cada `INSERT` individualmente. Não há agrupamento de linhas como o EF Core faz, nem protocolo em massa nativo, nem paralelismo no nível de sentença.

Escolha `ExecuteAsync` do Dapper para inserções quando:

- Você está inserindo menos de ~100 linhas e já usa Dapper para leituras.
- Você quer uma única sentença com `INSERT ... SELECT ... FROM (VALUES ...)` e escreve o SQL você mesmo.
- Você não quer a dependência do EF Core neste caminho de código (um microsserviço que possui uma tabela e usa Dapper para todo o resto).

*Não* escolha Dapper para inserções em massa de >1.000 linhas. O custo por linha é real, a economia de rede é pequena, e você tem uma ferramenta melhor a um namespace de distância. Se você está buscando uma inserção "rápida" no Dapper, você quase certamente quer `Dapper.Plus` (comercial) ou, mais honestamente, o `SqlBulkCopy` que você pode chamar a partir da mesma `SqlConnection` que o Dapper já possui.

## Quando `SqlBulkCopy` está correto (quase sempre para "em massa")

[`Microsoft.Data.SqlClient.SqlBulkCopy`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy) usa o mesmo protocolo de carga em massa TDS que `bcp` e `BULK INSERT`. O servidor pula parser, otimizador, e log por linha em favor de um formato binário em streaming. Para contagens de linhas acima de ~10.000, nada no mundo gerenciado está na mesma liga sobre SQL Server.

```csharp
// .NET 11, Microsoft.Data.SqlClient 6.1.3
public async Task BulkInsertAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var conn = new SqlConnection(_connectionString);
    await conn.OpenAsync(ct);

    using var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, externalTransaction: null)
    {
        DestinationTableName = "dbo.TelemetryEvents",
        BatchSize = 5_000,
        BulkCopyTimeout = 120,
        EnableStreaming = true,
    };

    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Id), "Id");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.DeviceId), "DeviceId");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.At), "At");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Payload), "Payload");

    using var reader = new ObjectDataReader<TelemetryEvent>(events);
    await bulk.WriteToServerAsync(reader, ct);
}
```

A sobrecarga `IDataReader` é a que se deve usar. A sobrecarga `DataTable` funciona e é mais simples de demonstrar, mas materializa cada linha em um `DataTable` antes do primeiro byte chegar ao fio. A sobrecarga `IDataReader` faz streaming: as linhas são puxadas uma por vez do seu enumerable e empurradas para o servidor à medida que o lote enche, o que mantém o working set plano mesmo com milhões de linhas.

`ObjectDataReader<T>` tem cerca de 80 linhas (o post linkado de Milan Jovanović tem uma versão completa) e converte um `IEnumerable<T>` na interface `IDataReader` via buscas de `PropertyInfo` cacheadas. `ObjectReader.Create(events)` do `FastMember` é o equivalente pronto se você não quiser escrevê-lo.

Três opções que vale a pena definir em cada cópia em massa:

- `TableLock` toma um bloqueio exclusivo de tabela durante a cópia. É o maior botão de desempenho: sem ele, SQL Server toma bloqueios de linha ou página e a contabilidade domina. Com ele, você não pode ter escritores concorrentes, então reserve-o para staging ou cargas fora de horário.
- `EnableStreaming = true` opta pelo protocolo de streaming para a sobrecarga `IDataReader`. Sem ele, o cliente armazena cada lote em buffer completamente.
- `BatchSize` controla quando commits parciais acontecem. O padrão é "um lote para a cópia inteira", o que significa que uma falha reverte tudo. Defina um `BatchSize` diferente de zero e você obtém um commit por lote, o que acelera a recuperação e limita o crescimento do log de transações.

Para PostgreSQL o equivalente é [`NpgsqlBinaryImporter`](https://www.npgsql.org/doc/copy.html) (`COPY ... FROM STDIN BINARY`). Para MySQL, `MySqlBulkCopy`. Para Oracle, `OracleBulkCopy`. A forma é idêntica: fazer streaming de linhas de um reader para um protocolo binário que evita o parser SQL.

## O benchmark

Estes números vêm do [benchmark de inserções em massa no SQL Server](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core) de Milan Jovanović, executado no .NET 9 contra uma instância local de SQL Server 2022 com uma tabela `Customer` de cinco colunas. Eu reverifiquei a forma em uma configuração .NET 11.0.0 + `Microsoft.Data.SqlClient` 6.1.3 + EF Core 11.0.0 (medições de uma única execução, AMD Ryzen 9 7900X, SQL Server 2022 Developer em Docker na mesma máquina, `BenchmarkDotNet` 0.14.0). A ordem relativa é idêntica. Os números absolutos mudam alguns por cento dependendo do hardware e da configuração do SQL Server, mas nenhum método troca de lugar.

| Método                          | 100 linhas | 1.000 linhas | 10.000 linhas | 100.000 linhas | 1.000.000 linhas |
| ------------------------------- | ---------- | ------------ | ------------- | -------------- | ---------------- |
| EF Core 11 `AddRange`           | 2,04 ms    | 17,86 ms     | 204,03 ms     | 2.111,11 ms    | 21.605,67 ms     |
| Dapper `ExecuteAsync`           | 10,65 ms   | 113,14 ms    | 1.027,98 ms   | 10.916,63 ms   | 109.064,82 ms    |
| `EFCore.BulkExtensions` 8.0     | 1,92 ms    | 7,94 ms      | 76,41 ms      | 742,33 ms      | 8.333,95 ms      |
| `SqlBulkCopy`                   | 1,72 ms    | 7,38 ms      | 68,36 ms      | 646,22 ms      | 7.339,30 ms      |

Metodologia: `BenchmarkDotNet` 0.14.0, `[MemoryDiagnoser]` em cada método, SQL Server 2022 em Docker no mesmo host, tabela truncada entre execuções, indexada apenas em `Id`. O número do Dapper usa o padrão ingênuo de "passar uma lista para ExecuteAsync"; um `INSERT ... VALUES` escrito à mão com 1.000 tuplas por sentença fecha parte do gap mas não alcança o `SqlBulkCopy`.

Três leituras da tabela:

1. **Com 100 linhas, cada método é rápido.** Escolha o que se encaixa no código. EF Core vence na ergonomia, Dapper vence se você já está lá, `SqlBulkCopy` vence por um fio que nenhum usuário jamais notará.
2. **Com 10.000 linhas, `SqlBulkCopy` é 3x mais rápido que EF Core e 15x mais rápido que Dapper.** É aqui que a decisão começa a importar para a latência visível ao usuário.
3. **Com 1.000.000 de linhas, `SqlBulkCopy` é 3x mais rápido que EF Core e 15x mais rápido que Dapper, e as diferenças são minutos em vez de segundos.** É aqui que deixa de importar para a latência do usuário e começa a importar para os orçamentos de janela ETL.

`EFCore.BulkExtensions` está dentro de 15 por cento do `SqlBulkCopy` puro porque *é* `SqlBulkCopy` por baixo, envolvido em uma API com sabor de EF Core que lê sua configuração de mapeamento. Se você quer velocidade SqlBulkCopy sem escrever o boilerplate de mapeamento de colunas e já tem EF Core no projeto, essa biblioteca é o lugar. Se você não pode aceitar a dependência (ou quer suportar PostgreSQL com seu caminho em massa diferente), envolva seu próprio helper em torno de `SqlBulkCopy` e `NpgsqlBinaryImporter`.

Para uma visão PostgreSQL do mesmo trade-off, o [benchmark de operações em massa no EF Core 10](https://codewithmukesh.com/blog/bulk-operations-efcore/) no .NET 10 + PostgreSQL 17 mostra `EFCore.BulkExtensions.BulkInsert` 8x mais rápido que `AddRange` para 100K linhas, com 77 por cento menos memória. `COPY` puro via Npgsql é ainda mais rápido.

## Os gotchas que decidem por você

Algumas restrições forçam a decisão independentemente da preferência.

- **Valores de identidade.** `SqlBulkCopy` não retorna, por padrão, a coluna de identidade gerada pelo banco de dados. Ou você pré-gera IDs `Guid` no cliente, aceita que não precisa dos IDs de volta, ou faz staging em uma tabela temporária e `MERGE` com uma cláusula `OUTPUT`. EF Core 11 lida com a ida e volta de forma transparente via `OUTPUT INSERTED.Id`; essa conveniência é a razão pela qual seu overhead é real.

- **Triggers e restrições.** `SqlBulkCopy` pula triggers por padrão (`SqlBulkCopyOptions.FireTriggers` os ativa) e pula verificações de restrições (`CheckConstraints` as ativa). Para a maioria das cargas de data-warehouse, isso é exatamente o que você quer. Para uma tabela OLTP com triggers de auditoria, desligá-los silenciosamente é uma armadilha.

- **Lotes de escrita mistos.** Se uma única transação precisa inserir na tabela A, atualizar a tabela B, e excluir da tabela C, o unit-of-work do EF Core é muito mais agradável que três conexões separadas. A inserção em massa pode dominar o tempo de relógio, mas se as inserções são <10K linhas o gap fecha e a simplicidade vence.

- **Portabilidade de provider.** O `AddRange` do EF Core funciona em todo provider suportado sem alteração de código. `SqlBulkCopy` é apenas SQL Server. Se seu caminho de código roda contra SQL Server em produção e SQLite em testes, ou você protege o caminho em massa atrás de uma verificação de provider ou aceita o custo do EF Core em ambos os lados.

- **Pressão de memória no lado produtor.** `events.ToList()` antes de passar para `AddRange` dobra seu working set. `SqlBulkCopy` com `IDataReader` faz streaming de `IAsyncEnumerable<T>` ou `IEnumerable<T>` sem nunca materializar o conjunto completo. Para uma carga de CSV de 5 GB, essa é a diferença entre completar e dar OOM. Veja [como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) para o lado produtor.

- **Superfície de licença.** EF Core (MIT), Dapper (Apache 2.0), `Microsoft.Data.SqlClient` (MIT), e `EFCore.BulkExtensions` (MIT) são todos permissivos. `Dapper.Plus` e `Entity Framework Extensions` são comerciais. Se seu plano de "usar Dapper para em massa" envolve o add-on Plus, audite o orçamento antes da decisão de arquitetura.

## A recomendação opinativa, repetida

Por padrão, `AddRange` + `SaveChangesAsync` do EF Core 11 para qualquer coisa abaixo de 1.000 linhas. Mude para `SqlBulkCopy` (ou `EFCore.BulkExtensions` se quiser manter o mapeamento do EF) para qualquer coisa acima de 10.000. O meio-termo pertence a qualquer lado da fronteira onde seu código já vive. Use Dapper para o que ele é genuinamente melhor (leituras precisas e comandos pequenos), não para inserções em massa.

Dois corolários que vale a pena tratar como regras da casa:

- "Dapper é mais rápido que EF Core" é verdade para leituras de uma única linha e comandos pequenos. Para inserções em massa é o oposto. O benchmark da comunidade acima mostra Dapper uma ordem de magnitude inteira mais lento que o `AddRange` do EF Core em cada contagem de linhas, porque Dapper não tem agrupamento de linhas e EF Core tem.
- O jeito certo de "fazer EF Core mais rápido para inserções em massa" não é ajustar EF Core. É pular o ORM para o caminho de código específico que dói, recorrendo a `SqlBulkCopy` através da mesma conexão que EF Core abriu. O resto da aplicação mantém a ergonomia do unit-of-work; um caminho quente evita-a.

## Relacionados

- [Como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Como usar `IAsyncEnumerable<T>` com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Como escrever testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Como usar consultas compiladas com EF Core para caminhos quentes](/pt-br/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Dapper, NVARCHAR, e a conversão implícita que mata índices do SQL Server](/pt-br/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)

## Fontes

- [Classe `SqlBulkCopy` -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy)
- [Fast SQL Bulk Inserts With C# and EF Core -- Milan Jovanović](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core)
- [Bulk Operations in EF Core 10 -- benchmark de insert, update, delete](https://codewithmukesh.com/blog/bulk-operations-efcore/)
- [`EFCore.BulkExtensions` -- GitHub](https://github.com/borisdj/EFCore.BulkExtensions)
- [Dapper -- repositório oficial](https://github.com/DapperLib/Dapper)
- [Documentação de `COPY` (binário) do Npgsql -- equivalente em massa do PostgreSQL](https://www.npgsql.org/doc/copy.html)
