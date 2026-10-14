---
title: "FileSystemWatcher vs polling para detectar mudanças em arquivos em um compartilhamento de rede no .NET"
description: "Em um compartilhamento SMB ou NFS, o polling é a fonte da verdade e o FileSystemWatcher é, no máximo, uma dica. O FileSystemWatcher perde mudanças remotas no Linux e no macOS, estoura o buffer de 64 KB de rede e para de vez quando a conexão cai. Use um diff periódico de snapshots e deixe o watcher apenas disparar uma varredura antecipada. Verificado no .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "csharp"
  - "filesystem"
  - "io"
lang: "pt-br"
translationOf: "2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-14
---

Se a pasta que você monitora fica em um compartilhamento de rede, o polling vence. Tire um snapshot periódico do diretório e compare com o anterior: esse é o único mecanismo que enxerga toda mudança em todo sistema operacional, sobrevive a desconexões e permite raciocinar sobre o comportamento. O `FileSystemWatcher` ainda é útil em clientes Windows falando com SMB, mas apenas como uma dica que dispara a próxima varredura mais cedo. Nunca deixe que ele seja o único caminho pelo qual você descobre que um arquivo chegou.

Tudo abaixo vale para `System.IO.FileSystemWatcher` e `Microsoft.Extensions.FileProviders.Physical` como são entregues no .NET 10 (executei o código no .NET 10.0.10, SDK 10.0.302, C# 14) e nos release candidates do .NET 11. O código-fonte relevante não mudou de forma significativa desde o .NET Core 3.1, então o conselho também vale para o .NET 8 e o 9.

## A comparação em resumo

| | `FileSystemWatcher` em um compartilhamento | Polling de um snapshot |
| --- | --- | --- |
| Cliente Windows, compartilhamento SMB 2/3 | Funciona, via `ReadDirectoryChangesW` encaminhado ao servidor | Funciona |
| Cliente Linux, montagem CIFS ou NFS | Vê apenas mudanças feitas pela própria máquina | Funciona |
| Cliente macOS, montagem SMB ou NFS | Na prática, vê apenas mudanças locais | Funciona |
| Latência | Menos de um segundo quando funciona | Seu intervalo de polling, mais o cache de metadados do cliente (até 10 s no SMB do Windows, até 60 s no NFS) |
| Rajada de mudanças | Buffer limitado a 64 KB em caminhos de rede, o estouro descarta todos os detalhes | Não é afetado, o próximo diff vê o estado final |
| Queda de conexão | Evento `Error`, depois `EnableRaisingEvents` vira `false` e permanece assim | A varredura falha, você tenta de novo no próximo tick |
| Mudanças feitas enquanto você estava offline | Perdidas | Vistas na primeira varredura bem-sucedida |
| Custo quando nada muda | Quase zero | Uma listagem de diretório por intervalo |
| Diz *o que* mudou | Sim, por evento | Sim, comparando snapshots |

Toda linha da coluna do "watcher" tem um asterisco, e nenhuma linha da coluna do "polling" tem. Essa assimetria é o argumento inteiro.

## Por que o FileSystemWatcher é frágil em um compartilhamento de rede

O `FileSystemWatcher` é um wrapper fino sobre o que o sistema operacional oferece: `ReadDirectoryChangesW` no Windows, `inotify` no Linux, FSEvents no macOS. Cada um deles foi projetado em torno de um sistema de arquivos local, em que o kernel vê toda escrita porque toda escrita passa por ele. Um compartilhamento de rede quebra essa premissa.

**No Linux e no macOS, escritas remotas são invisíveis.** O `inotify` dispara quando o kernel local executa uma operação no arquivo. Quando outra máquina escreve no mesmo export NFS ou compartilhamento SMB, o seu kernel nunca trata essa escrita, então nenhum evento é gerado. Você recebe eventos das escritas do seu próprio processo e nada das de outros. O desenvolvedor do kernel Linux J. Bruce Fields disse com clareza em [uma discussão no LWN](https://lwn.net/Articles/757833/): a notificação no lado do cliente exigiria um protocolo "very chatty" para saber das mudanças feitas por outros clientes, e o NFS não tem um. O mesmo vale para montagens CIFS. Se o seu consumidor roda em um contêiner Linux e o produtor é uma máquina Windows jogando arquivos em um compartilhamento, um `FileSystemWatcher` ficará ali em silêncio para sempre.

**No Windows, o teto de 64 KB pesa.** Um cliente Windows contra um servidor SMB 2 ou SMB 3 recebe notificações remotas de verdade: o redirecionador envia uma requisição `CHANGE_NOTIFY` ao servidor e o servidor responde quando algo muda. Mas a [documentação do `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) afirma que a chamada "fails with ERROR_INVALID_PARAMETER when the buffer length is greater than 64 KB and the application is monitoring a directory over the network". A [documentação do `FileSystemWatcher`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) repete o limite. O `InternalBufferSize` padrão é 8 KB, cada registro `FILE_NOTIFY_INFORMATION` tem 12 bytes mais o nome do arquivo em UTF-16, então com nomes de 40 caracteres cabem cerca de 90 eventos em 8 KB e cerca de 700 em 64 KB. Um job em lote que joga 2.000 arquivos em um segundo estoura qualquer um dos dois.

Quando o buffer estoura, o sistema operacional descarta o lote inteiro. O `ReadDirectoryChangesW` retorna sucesso com zero bytes, e o runtime transforma isso em um evento `Error` carregando uma `InternalBufferOverflowException` ("Too many changes at once in directory"). Você sabe que perdeu algo, mas não o quê.

**No Windows, uma conexão interrompida desativa o watcher.** Este é o caso que causa o incidente das 3 da manhã. Eis o trecho relevante de `ReadDirectoryChangesCallback` em [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs):

```csharp
// dotnet/runtime main, System.IO.FileSystem.Watcher (unchanged since .NET Core 3.x)
if (errorCode != 0)
{
    const int ERROR_OPERATION_ABORTED = 995;
    if (errorCode != ERROR_OPERATION_ABORTED)
    {
        EnableRaisingEvents = false;
        OnError(new ErrorEventArgs(new Win32Exception((int)errorCode)));
    }
    return;
}
```

Quando o servidor de arquivos reinicia, a VPN oscila ou a sessão SMB expira, a leitura pendente termina com um erro como `ERROR_NETNAME_DELETED` (64, "The specified network name is no longer available"). O watcher dispara `Error` uma vez, define `EnableRaisingEvents = false` e nunca volta sozinho. Se ninguém assinou o `Error`, o processo continua rodando, parece saudável e não processa nada. Note também que uma falha inicial, como um buffer acima de 64 KB em um caminho UNC, aparece da mesma forma: como um evento `Error`, não como uma exceção do setter `EnableRaisingEvents = true`.

## O repro mínimo da falha silenciosa

Este é o código que aparece na maioria das perguntas do tipo "meu watcher parou de funcionar":

```csharp
// .NET 10, C# 14 -- the naive version. Do not ship this against a share.
using var watcher = new FileSystemWatcher(@"\\fileserver\drop", "*.csv");
watcher.Created += (_, e) => Process(e.FullPath);
watcher.EnableRaisingEvents = true;

Console.ReadLine();

static void Process(string path) => Console.WriteLine($"Got {path}");
```

Execute no Windows, jogue um arquivo no compartilhamento, e funciona. Reinicie o servidor de arquivos, ou desconecte o cabo de rede por um minuto, e ele para de imprimir para sempre, sem exceção e sem linha de log. Execute o mesmo código em um contêiner Linux com `/mnt/drop` montado via CIFS e ele nunca imprime nada, a menos que o arquivo seja criado de dentro do próprio contêiner.

## Polling, feito do jeito certo

O polling tem má reputação porque as pessoas o implementam mal: listam o diretório, abrem todos os arquivos e comparam o conteúdo. Um bom poll é uma única listagem de diretório que captura nome, tamanho e hora da última escrita de cada entrada, comparada com a listagem anterior.

A forma mais barata de obter isso no .NET é `FileSystemEnumerable<T>` de `System.IO.Enumeration`. Ela permite projetar cada `FileSystemEntry` direto na tupla de que você precisa, sem alocar um `FileInfo` por arquivo. No Windows, `Length` e `LastWriteTimeUtc` vêm dos próprios dados da enumeração do diretório (`FindFirstFileEx` e afins), então via SMB a listagem inteira são alguns poucos intercâmbios `QUERY_DIRECTORY` em vez de uma ida e volta por arquivo. No Linux e no macOS, o `readdir` só retorna nomes, então cada entrada custa um `stat` extra, que um cliente CIFS ou NFS normalmente atende a partir do seu cache de atributos.

Para ter uma noção do piso de CPU de uma varredura, medi o método `TakeSnapshot` da implementação completa abaixo contra diretórios APFS locais em um Apple M4 (macOS 26.6, .NET 10.0.10, build Release, média de 20 execuções após 3 aquecimentos):

| Arquivos no diretório | Tempo por varredura | Alocado por varredura |
| --- | --- | --- |
| 1.000 | 1,8 ms | 0,29 MB |
| 10.000 | 20,5 ms | 2,83 MB |
| 50.000 | 93,1 ms | 13,39 MB |

Pela rede esses números crescem com a latência e o tamanho da listagem, mas o formato permanece o mesmo: uma listagem por intervalo. Fazer polling em uma pasta de entrada com alguns milhares de arquivos a cada 5 a 30 segundos é uma carga que ninguém vai notar. Fazer polling em 500.000 arquivos a cada segundo é, e a resposta aí é particionar a pasta (uma subpasta por dia ou por produtor), não trocar por um watcher.

## O híbrido: polling como verdade, watcher como dica

O design que se sustenta em produção combina os dois:

1. Mantenha um snapshot (`path -> (length, lastWriteUtc)`) em memória.
2. Refaça a varredura em um intervalo fixo e compare com o snapshot. Este é o único caminho de código que emite `Created`, `Changed` e `Deleted`.
3. Se um `FileSystemWatcher` puder ser iniciado, deixe qualquer evento dele acordar o loop de varredura mais cedo. Em um cliente Windows falando com SMB, isso dá latência abaixo de um segundo no caso comum.
4. Em qualquer `Error` do watcher (estouro ou desconexão), descarte o watcher, force uma nova varredura e tente recriá-lo na próxima passada.
5. Se a própria varredura falhar porque o compartilhamento está inacessível, mantenha o snapshot antigo e tente de novo no próximo tick. Uma indisponibilidade não é o mesmo que "todos os arquivos foram excluídos".

Eis a implementação completa. Ela roda como está no .NET 10 e no .NET 11:

```csharp
// .NET 10 / .NET 11, C# 14
using System.IO.Enumeration;

public enum ShareChangeKind { Created, Changed, Deleted }

public readonly record struct ShareChange(ShareChangeKind Kind, string Path);

public readonly record struct FileStamp(long Length, DateTime LastWriteUtc);

public sealed class ShareWatcher : IAsyncDisposable
{
    private readonly string _root;
    private readonly TimeSpan _reconcileInterval;
    private readonly Action<ShareChange> _onChange;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private Dictionary<string, FileStamp> _snapshot = new(StringComparer.OrdinalIgnoreCase); // SMB is case-insensitive
    private volatile FileSystemWatcher? _watcher; // swapped from the Error callback
    private Task? _loop;

    public ShareWatcher(string root, TimeSpan reconcileInterval, Action<ShareChange> onChange)
    {
        _root = root;
        _reconcileInterval = reconcileInterval;
        _onChange = onChange;
    }

    public void Start()
    {
        // Baseline: whatever exists now is not a change.
        _snapshot = TakeSnapshot(_root) ?? _snapshot;
        TryStartWatcher();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Wake on the reconcile timer OR early when the watcher hints at a change.
            try { await _wake.WaitAsync(_reconcileInterval, ct); }
            catch (OperationCanceledException) { return; }

            // Small settle delay so a burst of hints becomes one scan.
            try { await Task.Delay(250, ct); }
            catch (OperationCanceledException) { return; }

            Reconcile();

            if (_watcher is null) TryStartWatcher();
        }
    }

    private void Reconcile()
    {
        var current = TakeSnapshot(_root);
        if (current is null)
        {
            // Share unreachable. Keep the old snapshot: an outage is not "every file was deleted".
            return;
        }

        foreach (var (path, stamp) in current)
        {
            if (!_snapshot.TryGetValue(path, out var old))
                _onChange(new(ShareChangeKind.Created, path));
            else if (old != stamp)
                _onChange(new(ShareChangeKind.Changed, path));
        }

        foreach (var path in _snapshot.Keys)
        {
            if (!current.ContainsKey(path))
                _onChange(new(ShareChangeKind.Deleted, path));
        }

        _snapshot = current;
    }

    private static Dictionary<string, FileStamp>? TakeSnapshot(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        try
        {
            // Length and LastWriteTimeUtc come from the directory listing itself on Windows,
            // so this is one QUERY_DIRECTORY exchange per batch, not one round trip per file.
            // The constructor opens the directory, so it must sit inside the try.
            var entries = new FileSystemEnumerable<KeyValuePair<string, FileStamp>>(
                root,
                (ref FileSystemEntry e) => new(
                    e.ToFullPath(),
                    new FileStamp(e.Length, e.LastWriteTimeUtc.UtcDateTime)),
                options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
            };

            var result = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
            foreach (var (path, stamp) in entries) result[path] = stamp;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void TryStartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(_root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                InternalBufferSize = 64 * 1024, // hard ceiling for network paths
            };
            w.Created += (_, _) => Hint();
            w.Changed += (_, _) => Hint();
            w.Deleted += (_, _) => Hint();
            w.Renamed += (_, _) => Hint();
            w.Error += (_, e) => OnWatcherError(w, e.GetException());
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // Share offline or path gone. Polling keeps running; we retry on the next pass.
            _watcher = null;
        }
    }

    private void OnWatcherError(FileSystemWatcher w, Exception ex)
    {
        // Overflow or a dropped connection: either way, events were lost.
        // Throw the watcher away, force a full rescan, and rebuild on the next pass.
        if (ReferenceEquals(_watcher, w)) _watcher = null;
        w.Dispose();
        Hint();
    }

    private void Hint()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* a scan is already pending */ }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null) await _loop;
        _watcher?.Dispose();
        _cts.Dispose();
        _wake.Dispose();
    }
}
```

Usando em um worker ou em um aplicativo de console:

```csharp
// .NET 10 / .NET 11, C# 14
await using var watcher = new ShareWatcher(
    @"\\fileserver\drop",
    reconcileInterval: TimeSpan.FromSeconds(15),
    onChange: c => Console.WriteLine($"{c.Kind}: {c.Path}"));

watcher.Start();
await Task.Delay(Timeout.Infinite);
```

Testei isso em um diretório local com intervalo de reconciliação de 3 segundos: um arquivo criado, um append e uma exclusão foram reportados cerca de 265 ms após a operação (a dica do watcher mais o atraso de estabilização de 250 ms). Enquanto o diretório ficou afastado por 4 segundos para simular uma indisponibilidade, nada foi reportado, e o arquivo criado depois que ele voltou foi reportado na passada seguinte. Nada foi reportado por engano como excluído.

Algumas decisões de design que vale destacar:

- **`SemaphoreSlim(0, 1)` como sinal de despertar** coalesce qualquer quantidade de dicas em uma única varredura pendente. O `catch` de `SemaphoreFullException` é a coalescência, não um caminho de erro.
- **O atraso de estabilização de 250 ms** transforma uma rajada de dicas (um lote de 2.000 arquivos) em uma varredura em vez de 2.000.
- **`_onChange` roda no loop de varredura**, uma chamada por vez. Se o processamento for lento, envie a mudança para um `Channel<ShareChange>` e deixe um consumidor separado tratá-la, para que um handler lento não atrase a próxima varredura.
- **Arquivos ocultos e de sistema são ignorados**, o que descarta `Thumbs.db`, `desktop.ini` e os arquivos `.DS_Store` que clientes macOS deixam para trás.

## Armadilhas que o polling não resolve para você

**Caches de metadados do cliente adicionam latência que você não configurou.** O cliente SMB do Windows faz cache de listagens de diretório e de metadados de arquivos. Segundo o [guia de ajuste de servidores de arquivos](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/), `DirectoryCacheLifetime` e `FileInfoCacheLifetime` têm padrão de 10 segundos e `FileNotFoundCacheLifetime` de 5 segundos (todos em `HKLM\System\CurrentControlSet\Services\LanmanWorkstation\Parameters`), e os directory leases do SMB 3 mudam ainda mais o quadro. No Linux, o `mount.cifs` faz cache de atributos por 1 segundo por padrão (`actimeo`), e um cliente NFS por padrão faz cache de atributos de diretório por 30 a 60 segundos (`acdirmin`/`acdirmax`, veja [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html)). Sua latência efetiva é o seu intervalo de polling mais o tempo de vida do cache. Se você precisa de algo mais rápido, ajuste as opções de montagem, não o intervalo de polling.

**"Arquivo novo" não significa "arquivo terminado".** Os dois mecanismos dizem que um arquivo apareceu, não que o escritor terminou de usá-lo. Um arquivo de 2 GB copiado pela rede aparece na listagem no instante em que a cópia começa. Cobri as opções em detalhe em [como detectar quando um arquivo termina de ser gravado](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/): a mais robusta é fazer o produtor escrever com um nome temporário e renomear no final. Com o híbrido acima, você também pode simplesmente tratar um arquivo como pronto apenas depois que o stamp dele ficar inalterado em duas varreduras.

**Cópias que preservam timestamp parecem inalteradas.** `robocopy` com o `/COPY:DAT` padrão, `cp -p` e `rsync -t` preservam a hora da última escrita da origem. Se um arquivo é substituído por outro do mesmo tamanho, o stamp `(Length, LastWriteUtc)` não muda. Se isso importa, adicione a hora de criação no Windows ou um hash de conteúdo para arquivos pequenos, ou peça ao produtor para escrever um nome novo a cada versão.

**Desvio de relógio entre cliente e servidor.** A hora da última escrita que você lê é o timestamp do servidor. Compare stamps apenas com outros stamps do mesmo compartilhamento, nunca com `DateTime.UtcNow` da sua máquina. Lógica do tipo "modificado nos últimos 5 minutos" quebra em silêncio quando o relógio do servidor de arquivos está errado.

**Diferenciação de maiúsculas e minúsculas.** O dicionário do snapshot usa `StringComparer.OrdinalIgnoreCase` porque compartilhamentos SMB não diferenciam maiúsculas de minúsculas. Em um export NFS com sistema de arquivos que diferencia, troque para `StringComparer.Ordinal`, ou dois arquivos que diferem apenas pela caixa colapsarão em uma só entrada.

**Bind mounts de contêiner no Docker Desktop.** A mesma regra vale para uma pasta do host montada via bind mount em um contêiner Linux no Windows ou no macOS: as notificações de mudança vindas do host não são confiáveis, então o polling é o único padrão seguro também ali.

## Recarga de configuração em um compartilhamento: DOTNET_USE_POLLING_FILE_WATCHER

Se a "mudança de arquivo" que importa para você é o `appsettings.json` com `reloadOnChange: true`, ou qualquer outro consumidor do `PhysicalFileProvider`, você não precisa do código acima. O `PhysicalFileProvider` lê a variável de ambiente `DOTNET_USE_POLLING_FILE_WATCHER` no construtor:

```bash
# .NET 8, 9, 10, 11: switches PhysicalFileProvider to polling
export DOTNET_USE_POLLING_FILE_WATCHER=1
```

Com `1` ou `true`, ele define `UsePollingFileWatcher` e `UseActivePolling`, não cria nenhum `FileSystemWatcher` e verifica o `LastWriteTimeUtc` de cada arquivo observado em um timer. O intervalo é `PhysicalFilesWatcher.DefaultPollingInterval`, fixo em 4 segundos. Você também pode optar por isso por provider, no código:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

var provider = new PhysicalFileProvider(@"\\fileserver\config")
{
    UsePollingFileWatcher = true,
    UseActivePolling = true,
};

builder.Configuration.AddJsonFile(provider, "appsettings.shared.json",
    optional: false, reloadOnChange: true);
```

Valem as mesmas ressalvas: ele compara apenas a hora da última escrita, então uma cópia que preserva timestamp é invisível para ele, e o cache de metadados do SMB pode adicionar até 10 segundos sobre o intervalo de 4 segundos. O [post de comparação do `IOptionsMonitor`](/pt-br/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) cobre o que acontece a jusante quando a recarga dispara.

## A recomendação, reafirmada

Use um diff de snapshots por polling como única fonte da verdade para qualquer pasta em um compartilhamento SMB, um export NFS ou um bind mount. Escolha o intervalo a partir do seu orçamento de latência e some a ele o tempo de vida do cache de metadados do cliente. Se você roda no Windows e quer baixa latência, adicione um `FileSystemWatcher` que apenas acorda o poller mais cedo, limite o `InternalBufferSize` a 64 KB e trate todo evento `Error` como "refaça a varredura e reconstrua". O único caso em que um `FileSystemWatcher` puro é aceitável é um disco local, e mesmo ali você deve assinar o `Error`.

## Leitura relacionada

- [Como detectar quando um arquivo termina de ser gravado no .NET](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) cobre a metade do problema do "apareceu, mas não terminou".
- [Como acompanhar um arquivo de log em C# enquanto outro processo escreve nele](/pt-br/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) usa o mesmo raciocínio de polling primeiro para um único arquivo em crescimento.
- [Por que FileInfo.Length retorna um tamanho desatualizado no Windows](/pt-br/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) explica por que os metadados da listagem de diretório podem ficar atrás do arquivo real.
- [Thread.Sleep vs Task.Delay vs SpinWait](/pt-br/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) explica por que o loop de polling usa await em vez de dormir.
- [Channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) para passar mudanças do loop de varredura a um consumidor lento.

## Fontes

- [Classe `FileSystemWatcher`, observações sobre tamanho de buffer e caminhos de rede](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) (Microsoft Learn)
- [Função `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) (Microsoft Learn)
- [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) e [`FileSystemWatcher.Linux.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Linux.cs) (dotnet/runtime)
- [`PhysicalFileProvider.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFileProvider.cs) e [`PhysicalFilesWatcher.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFilesWatcher.cs) (dotnet/runtime)
- [`FileSystemEnumerable<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/system.io.enumeration.filesystemenumerable-1) (Microsoft Learn)
- [Ajuste de desempenho para servidores de arquivos, configurações de cache do cliente SMB](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) (Microsoft Learn)
- Páginas de manual [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) e [`mount.cifs(8)`](https://man7.org/linux/man-pages/man8/mount.cifs.8.html)
- [J. Bruce Fields sobre notificação de mudanças no NFS (comentário no LWN)](https://lwn.net/Articles/757833/)
