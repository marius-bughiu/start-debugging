---
title: "Como detectar quando um arquivo termina de ser escrito no .NET"
description: "FileSystemWatcher dispara Changed antes do escritor terminar. Tres padroes confiaveis para .NET 11 para saber quando um arquivo esta totalmente escrito: abrir com FileShare.None, fazer debounce com estabilizacao de tamanho e o truque de renomeacao do lado do produtor que evita o problema completamente."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "filesystem"
  - "io"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet"
translatedBy: "claude"
translationDate: 2026-04-29
---

`FileSystemWatcher` nao avisa quando um arquivo esta "pronto". Ele avisa que o sistema operacional observou uma mudanca. No Windows, cada chamada de `WriteFile` dispara um evento `Changed`, e `Created` dispara no momento em que o arquivo aparece, normalmente antes de um unico byte ser escrito. Os padroes confiaveis sao: (1) tentar abrir o arquivo com `FileShare.None` e tratar `IOException` 0x20 / 0x21 como "ainda esta sendo escrito", repetindo com backoff; (2) fazer polling de `FileInfo.Length` e `LastWriteTimeUtc` ate que ambos estabilizem em duas amostras consecutivas; ou (3) cooperar com o produtor para que ele escreva em `name.tmp` e depois faca `File.Move` para o nome final, o que e atomico no mesmo volume. O padrao 3 e o unico correto sem condicoes de corrida. Os padroes 1 e 2 sao como sobreviver quando voce nao controla o produtor.

Este post tem como alvo o .NET 11 (preview 4) e Windows / Linux / macOS. A semantica do `FileSystemWatcher` descrita abaixo nao mudou desde o .NET Core 3.1 em nenhuma plataforma, e o truque da renomeacao cooperativa e o mesmo no POSIX e no NTFS.

## Por que a abordagem obvia esta errada

O codigo ingenuo se parece com isso e esta em producao em lugares demais:

```csharp
// .NET 11 -- BROKEN, do not ship
var watcher = new FileSystemWatcher(@"C:\inbox", "*.csv");
watcher.Created += (_, e) =>
{
    var rows = File.ReadAllLines(e.FullPath); // throws IOException
    Process(rows);
};
watcher.EnableRaisingEvents = true;
```

`Created` dispara quando o sistema operacional reporta que a entrada de diretorio existe. O processo de escrita nao necessariamente fez flush nem mesmo de um byte. No Windows o arquivo pode estar aberto com `FileShare.Read` (entao sua leitura retorna um arquivo parcial) ou com `FileShare.None` (entao sua leitura lanca `IOException: The process cannot access the file because it is being used by another process`, HRESULT `0x80070020`, win32 error 32). No Linux voce quase sempre obtem uma leitura parcial porque nao ha bloqueio mandatorio por padrao; voce vai processar silenciosamente metade de um CSV.

`Changed` e pior. Dependendo de como o produtor escreve, voce pode receber um evento por chamada de `WriteFile`, o que significa que um arquivo de 1 MB escrito em blocos de 4 KB dispara 256 eventos. Nenhum deles avisa que o escritor terminou. Nao existe uma notificacao `WriteFileLastTimeIPromise` porque o kernel nao conhece a intencao do escritor.

Um terceiro problema: muitas ferramentas de copia (Explorer, `robocopy`, rsync) escrevem primeiro em um nome temporario oculto e depois renomeiam. Voce vera `Created` para o temporario, depois `Renamed` para o arquivo final. O evento `Renamed` e aquele em que voce quer reagir nesses casos, mas os padroes do `FileSystemWatcher.NotifyFilter` excluem `LastWrite` no .NET 11 e em algumas plataformas excluem `FileName`, entao voce precisa ativar explicitamente.

## Padrao 1: Abrir com FileShare.None e aplicar backoff

Se voce nao controla o produtor, seu unico canal de observacao e "consigo abrir o arquivo de forma exclusiva". O produtor mantem um handle aberto enquanto escreve; quando ele fecha o handle, uma abertura exclusiva tem sucesso. Isso funciona no Windows, Linux e macOS (o Linux oferece bloqueios consultivos via `flock`, mas a semantica de abertura sem bloqueio para um `FileStream` regular e suficiente porque estamos lendo apenas para confirmar que o escritor sumiu).

```csharp
// .NET 11, C# 14
using System.IO;

static async Task<FileStream?> WaitForFileAsync(
    string path,
    TimeSpan timeout,
    CancellationToken ct)
{
    var deadline = DateTime.UtcNow + timeout;
    var delay = TimeSpan.FromMilliseconds(50);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            await Task.Delay(delay, ct);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 1000));
        }
        catch (UnauthorizedAccessException)
        {
            // ACL problem, not a sharing problem -- do not retry
            throw;
        }
    }
    return null;
}

static bool IsSharingViolation(IOException ex)
{
    // ERROR_SHARING_VIOLATION = 0x20, ERROR_LOCK_VIOLATION = 0x21
    var hr = ex.HResult & 0xFFFF;
    return hr is 0x20 or 0x21;
}
```

Tres detalhes sutis:

- **Capture `IOException`, nao `Exception`**. `UnauthorizedAccessException` (ACLs) e `FileNotFoundException` (o produtor abortou e deletou o arquivo) sao bugs diferentes e nao devem ser repetidos.
- **Inspecione `HResult`**. No .NET Core e posteriores, `IOException.HResult` e o erro win32 padrao envolvido em `0x8007xxxx` no Windows, e os mesmos codigos numericos sao expostos em sistemas POSIX via a camada de traducao do runtime. A violacao de compartilhamento e `0x20`; a de bloqueio e `0x21`. Nao faca match contra a string da mensagem -- ela e localizada.
- **Backoff exponencial com teto**. Se o produtor travar (upload de rede, USB lento), fazer polling a cada 50ms gasta CPU a toa. Limitar a 1 segundo mantem o worker quieto sem prejudicar a latencia para escritas rapidas.

Esse padrao falha em um caso especifico: um produtor que abre com `FileShare.Read | FileShare.Write` (alguns uploaders bugados fazem isso). Sua abertura exclusiva tera sucesso no meio da escrita e voce vai ler lixo. Se voce suspeitar disso, combine o padrao 1 com o padrao 2.

## Padrao 2: Debounce na estabilizacao do tamanho

Quando voce nao pode confiar nos bloqueios de arquivo (alguns produtores Linux, alguns shares SMB, alguns dumps de camera), faca polling do tamanho e de `LastWriteTimeUtc`. A regra pratica: se o tamanho nao mudar em duas amostragens consecutivas separadas por um intervalo razoavel, o escritor provavelmente terminou.

```csharp
// .NET 11, C# 14
static async Task<bool> WaitForStableSizeAsync(
    string path,
    TimeSpan pollInterval,
    int requiredStableSamples,
    CancellationToken ct)
{
    var fi = new FileInfo(path);
    long lastSize = -1;
    DateTime lastWrite = default;
    int stable = 0;

    while (stable < requiredStableSamples)
    {
        await Task.Delay(pollInterval, ct);
        fi.Refresh(); // FileInfo caches; Refresh forces a fresh stat call
        if (!fi.Exists) return false;

        if (fi.Length == lastSize && fi.LastWriteTimeUtc == lastWrite)
        {
            stable++;
        }
        else
        {
            stable = 0;
            lastSize = fi.Length;
            lastWrite = fi.LastWriteTimeUtc;
        }
    }
    return true;
}
```

Escolha `pollInterval` baseado no que voce sabe sobre o escritor:

- Disco local rapido, arquivo pequeno: 100ms, 2 amostras.
- Upload de rede em link de 100 Mb: 1s, 3 amostras.
- USB / cartao SD / SMB: 2s, 3 amostras (o cache do sistema de arquivos pode mascarar a conclusao momentanea).

A pegadinha e `FileInfo.Refresh()`. Sem ele, `FileInfo.Length` retorna o valor cacheado quando o `FileInfo` foi construido, e seu loop gira para sempre. Nao ha aviso do compilador para isso; e um bug silencioso comum.

Combine com o padrao 1 em producao: faca polling para tamanho estavel, depois tente uma abertura exclusiva como confirmacao final. A combinacao lida tanto com produtores bem-comportados quanto mal-comportados.

## Padrao 3: O produtor coopera -- escreva e depois renomeie

Se voce controla o escritor, nao precisa detectar nada. Escreva em `final.csv.tmp`, faca fsync, feche e renomeie para `final.csv`. O `FileSystemWatcher` do consumidor observa `Renamed` (ou `Created` da extensao final) e reage. No mesmo volume NTFS ou ext4, `File.Move` e atomico: ou o destino existe com o conteudo completo, ou nao existe.

```csharp
// .NET 11, C# 14 -- producer side
static async Task WriteAtomicallyAsync(
    string finalPath,
    Func<Stream, Task> writeBody,
    CancellationToken ct)
{
    var tmpPath = finalPath + ".tmp";

    await using (var fs = new FileStream(
        tmpPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        bufferSize: 81920,
        useAsync: true))
    {
        await writeBody(fs, ct);
        await fs.FlushAsync(ct);
        // FlushAsync flushes the .NET buffer; FlushToDisk forces fsync.
        // For most use cases FlushAsync + closing the handle is enough,
        // because Windows Cached Manager and the Linux page cache will
        // serialize the rename after the writes. If you must survive a
        // crash mid-write, also call:
        //   fs.Flush(flushToDisk: true);
    }

    // File.Move with overwrite=true uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    // on Windows and rename(2) on POSIX. Both are atomic on the same volume.
    File.Move(tmpPath, finalPath, overwrite: true);
}
```

Duas regras nao obvias:

- **Mesmo volume**. A renomeacao atomica so funciona dentro de um sistema de arquivos. Escrever o temporario em `C:\temp\x.tmp` e renomear para `D:\inbox\x.csv` e uma copia-e-delete por baixo dos panos, e o consumidor pode pegar o arquivo no meio da copia. Sempre coloque o `.tmp` no diretorio de destino.
- **Mesma familia de extensoes**. Se o filtro do seu watcher e `*.csv` e o produtor cria `x.csv.tmp`, o watcher nao vai disparar para o arquivo temporario, que e o que voce quer. Se o filtro do watcher e `*` voce vai receber um evento `Created` para o temporario; ignore qualquer coisa terminada em `.tmp` no seu handler.

Esse e o mesmo padrao que o Git usa para atualizar refs, o mesmo que o SQLite usa para o seu journal e o mesmo que recarregadores de configuracao atomicos (nginx, HAProxy) usam. Existe um motivo. Se voce pode mudar o produtor, faca isso e pare de ler.

## Conectando corretamente ao FileSystemWatcher

O handler precisa ser barato e delegar para uma fila. `FileSystemWatcher` levanta eventos em uma thread do thread pool com um buffer interno pequeno (padrao 8 KB no Windows). Se voce bloqueia no handler, o buffer transborda e voce recebe eventos `Error` com `InternalBufferOverflowException`, descartando eventos silenciosamente.

```csharp
// .NET 11, C# 14
using System.IO;
using System.Threading.Channels;

var channel = Channel.CreateUnbounded<string>(
    new UnboundedChannelOptions { SingleReader = true });

var watcher = new FileSystemWatcher(@"C:\inbox")
{
    Filter = "*.csv",
    NotifyFilter = NotifyFilters.FileName
                 | NotifyFilters.LastWrite
                 | NotifyFilters.Size,
    InternalBufferSize = 64 * 1024, // 64 KB, max is 64 KB on most platforms
};

watcher.Created += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.Renamed += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.EnableRaisingEvents = true;

// Dedicated consumer
_ = Task.Run(async () =>
{
    await foreach (var path in channel.Reader.ReadAllAsync())
    {
        if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
        if (!await WaitForStableSizeAsync(path, TimeSpan.FromMilliseconds(250), 2, default))
            continue;
        await using var fs = await WaitForFileAsync(path, TimeSpan.FromSeconds(30), default);
        if (fs is null) continue;
        await ProcessAsync(fs);
    }
});
```

Tres coisas nesse codigo que pegam as pessoas:

- **`InternalBufferSize`**. O padrao de 8 KB e pequeno demais para qualquer carga real. Aumente para o maximo da plataforma (64 KB no Windows; o backend inotify do Linux puxa de `/proc/sys/fs/inotify/max_queued_events`). O custo e memoria de processo que voce nunca vai notar.
- **`NotifyFilter`**. O padrao no .NET 11 e `LastWrite | FileName | DirectoryName`, mas no macOS o backend kqueue ignora algumas flags; ative `Size` explicitamente para que mudancas apenas de tamanho (um escritor usando `WriteFile` sem mudanca de metadados) disparem eventos.
- **Um `Channel<T>` desacopla o watcher do consumidor**. Se o consumidor leva 5 segundos para processar um arquivo e 100 eventos chegam nessa janela, o channel armazena enquanto o watcher retorna imediatamente. Veja [por que Channels superam BlockingCollection para esse tipo de divisao produtor / consumidor](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Quando o arquivo esta em um share de rede

SMB e NFS adicionam seu proprio timing. `FileSystemWatcher` em um caminho UNC no Windows usa `ReadDirectoryChangesW` contra o share, mas os eventos sao coalescentes pelo redirecionador SMB. Voce pode ver um evento `Changed` por minuto mesmo para um arquivo de 1 GB sendo escrito continuamente. Os padroes 1 e 2 ainda funcionam, mas voce deveria definir `pollInterval` na ordem de 5-10 segundos; fazer polling de um `FileInfo.Length` remoto a cada 100ms gera um round-trip de metadados por polling e satura o link.

NFS e pior: `inotify` nao dispara para mudancas feitas em outros clientes, somente para mudancas no mount local feitas por processos locais. Se seu consumidor esta no host A e o produtor esta no host B escrevendo via NFS, `FileSystemWatcher` nao vai ver nada. A solucao e somente polling -- `Directory.EnumerateFiles` em um timer, com os padroes 1 e 2 aplicados a cada nova entrada. Nao ha caminho de notificacao do kernel que va te salvar aqui.

## Casos limite comuns

- **O produtor trunca e reescreve no mesmo lugar**. `FileSystemWatcher` vai disparar um unico evento `Changed` quando o novo conteudo chegar. A verificacao de tamanho estavel do padrao 2 lida com isso corretamente porque o tamanho so estabiliza depois que a reescrita termina. O padrao 1 pode ter sucesso brevemente durante a janela de truncamento quando o arquivo esta vazio; combine com uma verificacao de tamanho minimo esperado se seu dominio tiver uma.
- **O antivirus bloqueia o arquivo apos a criacao**. O Defender (Windows) e a maioria dos produtos AV corporativos abrem o arquivo para escanear quando ele aparece, mantendo `FileShare.Read` por dezenas a centenas de milissegundos. O loop de retry do padrao 1 absorve isso de forma transparente; so nao defina o timeout em 100ms.
- **O arquivo e criado por um processo que cai**. Voce vai ver `Created`, possivelmente `Changed`, e depois nada. A verificacao de tamanho estavel do padrao 2 retorna true depois da janela de polling porque nao ha mais escritas. Voce vai entao processar um arquivo parcial. Faca o produtor cooperar (padrao 3) ou tenha um arquivo sentinela (`final.csv.done`) que o produtor toca no final.
- **Multiplos arquivos escritos em sincronia** (por exemplo, `data.csv` mais `data.idx`). Observe a aparicao do arquivo secundario, nao do primario. O produtor e responsavel por escrever o indice depois dos dados, entao a aparicao do indice implica que os dados estao completos.

## Leitura relacionada

- [Streaming de um arquivo do ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cobre o lado da leitura uma vez que voce confirmou que o arquivo esta completo.
- [Lendo CSVs grandes sem OOM](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) e o seguimento natural se os arquivos do seu inbox sao grandes.
- [Cancelando tarefas longas sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) se aplica aos loops de espera acima quando voce quer que eles respeitem o shutdown.
- [Channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) e o transporte certo entre o watcher e o worker.

## Fontes

- [Referencia do `FileSystemWatcher`, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) -- a secao de notas de plataforma e a mais util.
- [`File.Move(string, string, bool)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.move) -- documenta a sobrecarga de renomeacao atomica adicionada no .NET Core 3.0.
- [Documentacao do Win32 `MoveFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) -- a primitiva subjacente usada por `File.Move(overwrite: true)`.
- [API `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) -- explica as condicoes de buffer overflow que se traduzem em `InternalBufferOverflowException`.
