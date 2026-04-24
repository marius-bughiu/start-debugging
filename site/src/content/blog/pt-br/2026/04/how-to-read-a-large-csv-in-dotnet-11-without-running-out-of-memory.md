---
title: "Como ler um CSV grande no .NET 11 sem estourar a memória"
description: "Faça streaming de um CSV de vários gigabytes no .NET 11 sem OutOfMemoryException. File.ReadLines, CsvHelper, Sylvan e Pipelines comparados com código e medições."
pubDate: 2026-04-24
tags:
  - ".NET 11"
  - "C# 14"
  - "Performance"
  - "CSV"
  - "Streaming"
lang: "pt-br"
translationOf: "2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory"
translatedBy: "claude"
translationDate: 2026-04-24
---

Se seu processo morre com `OutOfMemoryException` lendo um CSV, o conserto é quase sempre a mesma frase: pare de materializar o arquivo, comece a fazer streaming. No .NET 11 e C# 14, `File.ReadLines` cobre 80% dos casos, `CsvHelper.GetRecords<T>()` cobre parsing tipado sem buffering, e `Sylvan.Data.Csv` mais `System.IO.Pipelines` te dão a última ordem de magnitude quando o arquivo está na faixa de 5-50 GB. A pior coisa a fazer é chamar `File.ReadAllLines` ou `File.ReadAllText` em qualquer coisa maior que poucos megabytes, porque ambos carregam o payload inteiro em uma `string[]` que precisa viver no Large Object Heap até o GC se convencer de que ninguém mais a toca.

Este post percorre as quatro técnicas em ordem de complexidade, mostra o que cada uma de fato aloca, e destaca as pegadinhas que vão te morder quando o CSV tiver campos com aspas multilinha, um BOM, ou precisar ser cancelado no meio da leitura. Versões usadas: .NET 11, C# 14, `CsvHelper 33.x`, `Sylvan.Data.Csv 1.4.x`.

## Por que seu leitor de CSV está alocando gigabytes

Um CSV UTF-8 de 2 GB vira uma `string` de aproximadamente 4 GB em memória, porque strings do .NET são UTF-16. `File.ReadAllLines` vai além e ainda aloca uma `string` por linha, mais o array `string[]` que as guarda. Em um arquivo com 20 milhões de linhas você termina com 20 milhões de objetos no heap, o array de topo no Large Object Heap, e uma pausa de GC geração 2 de dezenas de segundos quando a pressão finalmente força uma coleta. Em processos 32 bits ou containers restritos o processo simplesmente morre.

O conserto é ler um registro por vez e deixar cada registro virar elegível para coleta de lixo antes do próximo ser parseado. Essa é a definição de streaming, e cada técnica abaixo é um ponto diferente na curva de ergonomia vs throughput.

## O upgrade de uma linha: `File.ReadLines`

`File.ReadAllLines` retorna `string[]`. `File.ReadLines` retorna `IEnumerable<string>` e lê preguiçosamente. Trocar um pelo outro frequentemente já basta.

```csharp
// .NET 11, C# 14
using System.Globalization;

int rowCount = 0;
decimal total = 0m;

foreach (string line in File.ReadLines("orders.csv"))
{
    if (rowCount++ == 0) continue; // header

    ReadOnlySpan<char> span = line;
    int firstComma = span.IndexOf(',');
    int secondComma = span[(firstComma + 1)..].IndexOf(',') + firstComma + 1;

    ReadOnlySpan<char> amountSlice = span[(secondComma + 1)..];
    total += decimal.Parse(amountSlice, CultureInfo.InvariantCulture);
}

Console.WriteLine($"{rowCount - 1} rows, total = {total}");
```

A alocação em estado estável aqui é uma `string` por linha mais o que a sobrecarga de `decimal.Parse` precisar. O working set de pico fica plano em poucos megabytes independente do tamanho do arquivo, porque o enumerator lê através de um buffer interno de `StreamReader` de 4 KB.

Duas ressalvas que vão te morder se você confiar nisso para dados reais.

Primeiro, `File.ReadLines` não tem ciência de aspas CSV. Uma célula contendo `"first line\r\nsecond line"` vira dois registros. Se seus dados vêm de Excel, exports de Salesforce, ou qualquer lugar onde humanos digitam, você bate nisso em uma semana.

Segundo, o enumerator abre o arquivo e segura o handle até você descartar o enumerator ou iterar até o fim. Se você der `break` no loop antes, o handle é liberado quando o enumerator é finalizado, o que é não-determinístico. Envolva o uso em um `IEnumerator<string>` explícito com `using` se isso importar para o seu cenário.

## Streaming assíncrono com `StreamReader.ReadLineAsync`

Se você lê de um share de rede, um bucket S3 ou qualquer lugar com latência, o `foreach` síncrono bloqueia uma thread por arquivo. `StreamReader.ReadLineAsync` (sobrecarregado no .NET 7+ para retornar `ValueTask<string?>`) e `IAsyncEnumerable<string>` são as primitivas certas.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var stream = new FileStream(
        path,
        new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    using var reader = new StreamReader(stream);

    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Dois ajustes relevantes em produção estão setados aqui. `FileOptions.SequentialScan` diz ao SO para usar read-ahead agressivo e descartar páginas depois que você passa, o que evita o page cache de bater quando o arquivo é maior que a RAM. `BufferSize = 64 * 1024` é quatro vezes o default e reduz mensuravelmente a contagem de syscalls em armazenamento NVMe; ir além de 64 KB raramente ajuda.

Se você precisa honrar cancelamento de forma determinística, combine isso com um `CancellationTokenSource` que tenha um timeout. Para uma discussão mais longa sobre como fiar cancelamento por um pipeline async sem deadlock, veja [como cancelar uma Task de longa duração em C# sem causar deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Parsing tipado sem buffering: `GetRecords<T>()` do CsvHelper

Linhas cruas servem para dados de forma trivial. Para qualquer coisa com colunas anuláveis, delimitadores entre aspas, ou cabeçalhos que você quer mapear para uma POCO, CsvHelper é o default. O ponto chave é que `GetRecords<T>()` retorna `IEnumerable<T>` e reusa uma única instância de registro pela enumeração inteira. Se você materializar esse enumerable com `.ToList()`, você anulou a biblioteca inteira.

```csharp
// .NET 11, C# 14, CsvHelper 33.x
using System.Globalization;
using CsvHelper;
using CsvHelper.Configuration;

public sealed record Order(int Id, string Sku, decimal Amount, DateTime PlacedAt);

static async Task ProcessAsync(string path, CancellationToken ct)
{
    var config = new CsvConfiguration(CultureInfo.InvariantCulture)
    {
        HasHeaderRecord = true,
        MissingFieldFound = null,   // tolerate missing optional columns
        BadDataFound = null,        // silently skip malformed quotes; log these in prod
    };

    using var reader = new StreamReader(path);
    using var csv = new CsvReader(reader, config);

    await foreach (Order order in csv.GetRecordsAsync<Order>(ct))
    {
        // process one record; do NOT cache `order`, it is reused under synchronous mode
    }
}
```

`GetRecordsAsync<T>` retorna `IAsyncEnumerable<T>` e internamente usa `ReadAsync`, então um disco lento ou stream de rede não mata o thread pool de fome. Como o tipo é um `record` com construtor explícito, CsvHelper gera setters por coluna uma vez via reflection e depois reusa o caminho para cada linha. Em um arquivo de orders de 1 GB com 12 colunas isso parseia a aproximadamente 600 K linhas por segundo num laptop moderno com working set fixado abaixo de 30 MB.

A ressalva que pega gente vinda de `DataTable`: o objeto que você recebe dentro do loop é a mesma instância em cada iteração quando CsvHelper usa o caminho de reuso. Se você precisa capturar linhas em uma fila downstream, clone-as explicitamente ou projete para um novo record com expressões `with`.

## Throughput máximo: Sylvan.Data.Csv e `DbDataReader`

CsvHelper é conveniente. Não é o mais rápido. Quando você precisa empurrar 100 MB/s por um único core, `Sylvan.Data.Csv` é a biblioteca que entrega um `DbDataReader` sobre um CSV com quase nenhuma alocação por célula. Evita a `string` por campo expondo `GetFieldSpan` e parseia números diretamente do buffer subjacente de `char`.

```csharp
// .NET 11, C# 14, Sylvan.Data.Csv 1.4.x
using Sylvan.Data.Csv;

using var reader = CsvDataReader.Create(
    "orders.csv",
    new CsvDataReaderOptions
    {
        HasHeaders = true,
        BufferSize = 0x10000, // 64 KB
    });

int idOrd     = reader.GetOrdinal("id");
int skuOrd    = reader.GetOrdinal("sku");
int amountOrd = reader.GetOrdinal("amount");

long rows = 0;
decimal total = 0m;

while (reader.Read())
{
    rows++;
    // GetFieldSpan avoids allocating a string for fields you never need as a string
    ReadOnlySpan<char> amountSpan = reader.GetFieldSpan(amountOrd);
    total += decimal.Parse(amountSpan, provider: CultureInfo.InvariantCulture);

    // GetString only when you actually need the managed string
    string sku = reader.GetString(skuOrd);
    _ = sku;
}
```

No mesmo arquivo de 1 GB isso atinge aproximadamente 2.5 M linhas/s e aloca menos de 1 MB para a execução inteira, dominado pelo próprio buffer. O truque é `GetFieldSpan` mais sobrecargas como `decimal.Parse(ReadOnlySpan<char>, ...)` que não exigem uma string intermediária. As primitivas de parsing do .NET 11 são desenhadas em torno desse padrão, e combiná-las com um reader que expõe spans diretamente elimina por completo a alocação por célula.

Como `CsvDataReader` herda de `DbDataReader`, você também pode alimentá-lo direto em um `SqlBulkCopy`, em um `Execute` do Dapper, ou em um `ExecuteSqlRaw` do EF Core, que é como você move um CSV de 10 GB para SQL Server sem nunca materializá-lo em memória gerenciada. Se seu estado final é um banco de dados, frequentemente você pode pular o loop de parsing por completo.

## Os últimos 10%: `System.IO.Pipelines` com parsing UTF-8

Quando o gargalo se torna a própria conversão UTF-16, desça para parsing em nível de byte com `System.IO.Pipelines`. A ideia é manter os bytes do arquivo como UTF-8 o caminho todo, fatiar o buffer em fronteiras de `,` e `\n`, e usar `Utf8Parser.TryParse` ou `int.TryParse(ReadOnlySpan<byte>, ...)` (adicionado no .NET 7 e ajustado mais ainda no .NET 11) para parsear valores sem nenhuma alocação.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Buffers.Text;
using System.IO.Pipelines;

static async Task<decimal> SumAmountsAsync(Stream source, CancellationToken ct)
{
    var reader = PipeReader.Create(source);
    decimal total = 0m;
    bool headerSkipped = false;

    while (true)
    {
        ReadResult result = await reader.ReadAsync(ct);
        ReadOnlySequence<byte> buffer = result.Buffer;

        while (TryReadLine(ref buffer, out ReadOnlySequence<byte> line))
        {
            if (!headerSkipped) { headerSkipped = true; continue; }
            total += ParseAmount(line);
        }

        reader.AdvanceTo(buffer.Start, buffer.End);

        if (result.IsCompleted) break;
    }

    await reader.CompleteAsync();
    return total;
}

static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
{
    SequencePosition? position = buffer.PositionOf((byte)'\n');
    if (position is null) { line = default; return false; }

    line = buffer.Slice(0, position.Value);
    buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
    return true;
}

static decimal ParseAmount(ReadOnlySequence<byte> line)
{
    ReadOnlySpan<byte> span = line.IsSingleSegment ? line.FirstSpan : line.ToArray();
    int c1 = span.IndexOf((byte)',');
    int c2 = span[(c1 + 1)..].IndexOf((byte)',') + c1 + 1;
    ReadOnlySpan<byte> amount = span[(c2 + 1)..];

    Utf8Parser.TryParse(amount, out decimal value, out _);
    return value;
}
```

Isso é verboso, não trata campos com aspas, e você não deve recorrer a isso a menos que tenha medido um gargalo real. O que você ganha em troca é throughput dentro de 10% do que o armazenamento subjacente consegue entregar, porque o código gerenciado essencialmente não faz trabalho além de caçar vírgulas. Um truque relacionado que ajuda quando o caminho quente tem um conjunto pequeno de delimitadores ou bytes sentinela é [`SearchValues<T>` introduzido no .NET 10](/2026/01/net-10-performance-searchvalues/), que vetoriza o scan para qualquer byte de um conjunto.

## Pegadinhas que vão te morder em produção

Campos com aspas multilinha quebram qualquer abordagem baseada em linha. Um parser CSV correto rastreia um estado "dentro de aspas" através das fronteiras de linha. `File.ReadLines`, `StreamReader.ReadLine`, e o exemplo artesanal de `Pipelines` acima erram nisso. CsvHelper e Sylvan tratam. Se você está escrevendo seu próprio parser por motivos de performance, também está se inscrevendo para implementar a RFC 4180 sozinho.

O BOM UTF-8 (`0xEF 0xBB 0xBF`) aparece no início de arquivos produzidos pelo Excel e várias ferramentas Windows. `StreamReader` o remove por padrão; `PipeReader.Create(FileStream)` não. Cheque explicitamente antes do parse do primeiro campo, ou o primeiro nome de cabeçalho vai parecer `\uFEFFid` e seu lookup de ordinal vai lançar.

`File.ReadLines` e o fluxo do CsvHelper acima seguram o handle do arquivo aberto pela vida do enumerator. Se você precisa apagar ou renomear o arquivo enquanto o chamador está iterando (por exemplo, um diretório de inbox monitorado), passe `FileShare.ReadWrite | FileShare.Delete` quando abrir o `FileStream` manualmente.

Processamento paralelo de linhas CSV é tentador e geralmente errado a menos que seu trabalho por linha seja genuinamente CPU-bound. Parsing é I/O-bound, e o parser em si não é thread-safe. O padrão correto é parsear em uma thread só e publicar linhas em um `Channel<T>` que faz fan-out para workers. O [walkthrough de `IAsyncEnumerable<T>` para EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) mostra o mesmo padrão de produtor único e múltiplos consumidores contra uma fonte de banco; o formato se transfere direto.

Se o arquivo está comprimido, não descomprima para disco antes. Encadeie o stream de descompressão no seu parser:

```csharp
// .NET 11, C# 14
using var file = File.OpenRead("orders.csv.zst");
using var zstd = new ZstandardStream(file, CompressionMode.Decompress);
using var reader = new StreamReader(zstd);
// feed `reader` to CsvReader or parse lines directly
```

Para contexto sobre o novo suporte built-in do Zstandard, veja [a compressão nativa Zstandard do .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/). Antes do .NET 11 você precisava do pacote NuGet `ZstdNet`; a versão do System.IO.Compression é significativamente mais rápida e evita uma dependência P/Invoke.

Cancelamento importa mais do que você pensa. Um parsing de 20 GB de CSV é uma operação de vários minutos. Se o chamador desistir, você quer que o enumerator note no próximo registro e lance `OperationCanceledException`, não que rode até o fim. Todas as variantes async acima passam um `CancellationToken`; para o loop síncrono de `File.ReadLines`, cheque `ct.ThrowIfCancellationRequested()` dentro do corpo do loop em um intervalo razoável (a cada 1000 linhas, não a cada linha).

## Escolhendo a ferramenta certa

Se seu CSV tem menos de 100 MB e formato trivial, use `File.ReadLines` mais `string.Split` ou slicing com `ReadOnlySpan<char>`. Se tem aspas, nullability, ou você quer registros tipados, use `GetRecordsAsync<T>` do CsvHelper. Se throughput domina e seus dados são bem formados, use o `CsvDataReader` do Sylvan e parseie direto de spans. Só desça para `System.IO.Pipelines` quando você tiver medido um gargalo específico na conversão UTF-16 e tiver orçamento para manter um parser custom.

A linha comum às quatro: nunca buferize o arquivo inteiro. No momento em que você chama `ToList`, `ReadAllLines` ou `ReadAllText`, você abriu mão da propriedade de streaming e sua pegada de memória agora cresce com a entrada. Em um arquivo de 20 GB num container de 4 GB, isso termina de um jeito só.

## Fontes

- [File.ReadLines no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.readlines)
- [FileStreamOptions no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions)
- [Documentação do CsvHelper](https://joshclose.github.io/CsvHelper/)
- [Sylvan.Data.Csv no GitHub](https://github.com/MarkPflug/Sylvan)
- [System.IO.Pipelines no .NET](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [Utf8Parser no MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.text.utf8parser)
