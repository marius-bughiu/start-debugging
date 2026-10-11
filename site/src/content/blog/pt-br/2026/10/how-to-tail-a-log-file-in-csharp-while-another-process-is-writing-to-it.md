---
title: "Como acompanhar (tail) um arquivo de log em C# enquanto outro processo ainda está escrevendo nele"
description: "Abra o log com FileShare.ReadWrite | FileShare.Delete, vá até o final, faça polling por novos bytes, decodifique-os com seu próprio Decoder UTF-8 em vez de StreamReader e trate truncamento e rotação de forma explícita. Uma implementação testada de tail -F para .NET 10 e .NET 11."
pubDate: 2026-10-11
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "logging"
  - "async"
lang: "pt-br"
translationOf: "2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it"
translatedBy: "claude"
translationDate: 2026-10-11
---

Para ler um arquivo de log que outro processo ainda mantém aberto para escrita, abra-o com `new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)`. `FileShare.ReadWrite` é o que evita o `IOException: The process cannot access the file because it is being used by another process`, porque o escritor já tem acesso de escrita e o seu modo de compartilhamento precisa permitir isso. `FileShare.Delete` permite que o escritor renomeie ou exclua o arquivo durante a rotação de logs sem falhar. Depois, vá até o final, faça polling por novos bytes com um timer e emita texto apenas até o último `\n`. Não leia os bytes por meio de `StreamReader`: ao chegar ao fim do arquivo, ele faz flush do seu decoder, o que corrompe qualquer caractere UTF-8 multibyte que o escritor tenha gravado só pela metade. Por fim, verifique truncamento (`fs.Length < fs.Position`) e rotação (o caminho agora aponta para outro arquivo) toda vez que chegar ao EOF. Tudo abaixo foi executado no macOS com .NET 10.0.10 (SDK 10.0.302) e .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128); as regras de compartilhamento do Windows vêm do código-fonte do runtime e do contrato da Win32.

## Por que File.ReadAllText lança exceção em um arquivo de log ativo

Toda abertura no Windows carrega duas informações: o acesso que você quer (`FileAccess`) e o acesso que você aceita que outros tenham ao mesmo tempo (`FileShare`). Uma segunda abertura só tem sucesso se os dois lados concordarem: o acesso que você pede precisa ser permitido pelo modo de compartilhamento de cada handle existente, e o acesso de cada handle existente precisa ser permitido pelo seu modo de compartilhamento.

Os loggers quase sempre abrem seu arquivo assim. Esta é a linha do [`FileSink` do Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs) com `shared: false` (o padrão):

```csharp
// Serilog.Sinks.File, non-shared mode
System.IO.File.Open(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
```

O escritor mantém `FileAccess.Write` e permite que outros leiam. Agora veja o que as APIs de conveniência fazem. `File.ReadAllText`, `File.ReadAllLines`, `File.ReadLines` e `new StreamReader(path)` terminam todos no mesmo helper em [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs):

```csharp
// dotnet/runtime, StreamReader path constructor
new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileStream.DefaultBufferSize);
```

`FileShare.Read` significa "ninguém mais pode escrever enquanto eu estiver com isto aberto". Mas alguém já está escrevendo, então o Windows recusa a abertura com `ERROR_SHARING_VIOLATION` (erro Win32 32, HResult `0x80070020`), e o .NET o expõe como `IOException: The process cannot access the file 'app.log' because it is being used by another process.` A solução não é um loop de retentativas. A solução é pedir um modo de compartilhamento que tolere o escritor:

```csharp
// .NET 10 / .NET 11, C# 14
using var fs = new FileStream(
    "app.log",
    FileMode.Open,
    FileAccess.Read,
    FileShare.ReadWrite | FileShare.Delete);
```

Se o escritor abriu o arquivo com `FileShare.None`, nenhum modo de compartilhamento do seu lado ajuda. Esse escritor pediu acesso exclusivo, e você só pode esperar até que ele feche o handle.

### O que muda no Linux e no macOS

O Unix não tem modos de compartilhamento obrigatórios, então o .NET os emula. Desde o .NET 6, [`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) adquire um `flock` consultivo: `LOCK_EX` quando você passa `FileShare.None`, `LOCK_SH` para qualquer outro valor de compartilhamento. Duas consequências, ambas reproduzidas por mim no macOS com .NET 10.0.10:

1. `File.ReadAllText` em um arquivo que um escritor .NET mantém aberto com `FileShare.Read` funciona no Unix. Um código que "funciona no meu Mac" ainda pode lançar exceção em produção no Windows.
2. Um escritor .NET que tenta abrir com `FileShare.None` enquanto o seu tailer está com o arquivo aberto falha com `IOException` (HResult `0x23` no macOS), porque o seu lock compartilhado bloqueia o lock exclusivo dele. Escritores que não são .NET não participam do `flock`.

O locking pode ser desativado com a opção de runtime `System.IO.DisableFileLocking` (variável de ambiente `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`), de que algumas equipes precisam em montagens NFS sem um daemon de lock. Passar `FileShare.ReadWrite | FileShare.Delete` continua sendo a escolha certa no Unix: documenta a intenção e se comporta de forma idêntica no Windows.

## Os dois bugs de um loop de tail ingênuo

Com a abertura funcionando, a implementação óbvia é um `StreamReader` e um loop em torno de `ReadLine()`. O `StreamReader` não trava no fim do arquivo, então, quando o escritor acrescenta mais dados, o próximo `ReadLine` os devolve. Essa parte está certa. Duas outras não estão.

Primeiro, linhas parciais. Se o escritor deu flush de `"line1\npart"` e você chama `ReadLine()` duas vezes, recebe `"line1"` e depois `"part"`. Quando o escritor acrescenta `"ial2\n"` mais tarde, você recebe `"ial2"`. Uma linha de log agora são dois registros. Executei exatamente essa sequência e obtive `[line1] [part]`, depois `[ial2]` após o acréscimo.

Segundo, e bem menos conhecido, caracteres divididos. O `StreamReader` entrega bytes a um `Decoder` UTF-8, que pode reter os primeiros bytes de um caractere multibyte até que o restante chegue. Mas quando o stream subjacente devolve 0 bytes, o `StreamReader` trata isso como o fim do stream e chama `_decoder.GetChars(..., flush: true)`. Um decoder com flush transforma qualquer sequência incompleta em `U+FFFD`. Em um arquivo que está crescendo, "o fim do stream" significa apenas "o escritor ainda não terminou". Esta reprodução escreve `"żółć\n"` em dois blocos, dividindo `ó` depois do primeiro byte:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Text;

var path = Path.GetTempFileName();
var bytes = Encoding.UTF8.GetBytes("żółć\n");

using var writer = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
using var reader = new StreamReader(fs, Encoding.UTF8);

var buf = new char[100];
var sb = new StringBuilder();
void Drain() { int n; while ((n = reader.Read(buf, 0, buf.Length)) > 0) sb.Append(buf, 0, n); }

writer.Write(bytes, 0, 3); writer.Flush(); Drain();               // "ż" + first byte of "ó"
writer.Write(bytes, 3, bytes.Length - 3); writer.Flush(); Drain();
Console.WriteLine(sb.ToString()); // prints "ż��łć"
```

A saída é `ż��łć` no .NET 10.0.10 e no .NET 11 RC1, tanto com `Read` quanto com `ReadAsync`. Logs cheios de nomes de usuário, caminhos de arquivo ou mensagens com caracteres não ASCII vão cair nisso assim que um escritor der flush no meio de um caractere, o que escritores com buffer fazem sempre que o limite do buffer cai dentro de um deles.

A correção para os dois problemas é a mesma: leia os bytes do `FileStream` você mesmo, decodifique-os com seu próprio `Decoder` e `flush: false`, e mantenha o texto depois da última quebra de linha em um buffer até que o resto da linha apareça.

## Uma implementação de tail -F que sobrevive à rotação

Aqui está o helper completo. Ele expõe o fluxo de linhas como um `IAsyncEnumerable<string>`, de modo que os consumidores escrevem `await foreach` e cancelam com um token.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Runtime.CompilerServices;
using System.Text;

public static class LogTail
{
    public static async IAsyncEnumerable<string> FollowAsync(
        string path,
        bool fromStart = false,
        TimeSpan? pollInterval = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var interval = pollInterval ?? TimeSpan.FromMilliseconds(250);
        var bytes = new byte[16 * 1024];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        var pending = new StringBuilder();
        FileStream? fs = null;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (fs is null)
                {
                    fs = TryOpen(path);
                    if (fs is null)
                    {
                        await Task.Delay(interval, ct);
                        continue;
                    }
                    if (!fromStart) fs.Seek(0, SeekOrigin.End);
                    fromStart = true; // a rotated-in file is read from the top
                    decoder.Reset();
                    pending.Clear();
                }

                int read = await fs.ReadAsync(bytes, ct);
                if (read > 0)
                {
                    // flush: false keeps a half-written multi-byte character
                    // inside the decoder until the rest of it arrives.
                    int n = decoder.GetChars(bytes, 0, read, chars, 0, flush: false);
                    pending.Append(chars, 0, n);
                    foreach (var line in DrainCompleteLines(pending))
                        yield return line;
                    continue;
                }

                // At EOF. Truncated in place (copytruncate)?
                if (fs.Length < fs.Position)
                {
                    fs.Seek(0, SeekOrigin.Begin);
                    decoder.Reset();
                    pending.Clear();
                    continue;
                }

                // Path now points at a different file (rename-and-recreate)?
                if (WasReplaced(path, fs))
                {
                    await fs.DisposeAsync();
                    fs = null;
                    continue;
                }

                await Task.Delay(interval, ct);
            }
        }
        finally
        {
            if (fs is not null) await fs.DisposeAsync();
        }
    }

    static FileStream? TryOpen(string path)
    {
        try
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 0, FileOptions.Asynchronous);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; } // writer holds FileShare.None right now
    }

    static IEnumerable<string> DrainCompleteLines(StringBuilder pending)
    {
        int start = 0;
        for (int i = 0; i < pending.Length; i++)
        {
            if (pending[i] != '\n') continue;
            int end = i > start && pending[i - 1] == '\r' ? i - 1 : i;
            yield return pending.ToString(start, end - start);
            start = i + 1;
        }
        pending.Remove(0, start);
    }

    static bool WasReplaced(string path, FileStream current)
    {
        // Measure the path through a fresh handle, not FileInfo, and do it
        // before reading the current handle's length.
        using var probe = TryOpen(path);
        if (probe is null) return false; // rotated, new file not created yet
        long pathLength = probe.Length;
        // Same append-only file: pathLength == current.Position (we are at EOF)
        // or current.Length grew past it in the meantime. Anything else means
        // the name now belongs to another file.
        return pathLength < current.Position || pathLength > current.Length;
    }
}
```

Usá-lo em um aplicativo de console ou em um `BackgroundService` fica assim:

```csharp
// .NET 10 / .NET 11, C# 14
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

try
{
    await foreach (var line in LogTail.FollowAsync("/var/log/myapp/app.log", ct: cts.Token))
        Console.WriteLine(line);
}
catch (OperationCanceledException) { }
```

Testei contra um segundo processo que escrevia linhas em dois blocos (divididos dentro de um caractere de dois bytes, com flushes e pausas de 120 ms entre eles), depois renomeava o arquivo para `app.log.1` e iniciava um novo, e então truncava o novo e continuava escrevendo. O tailer imprimiu todas as linhas intactas, sem caracteres de substituição, acompanhou a renomeação para o novo arquivo e recomeçou do início após o truncamento, tanto no .NET 10.0.10 quanto no .NET 11 RC1.

## Como cada peça se justifica

Em ordem, o loop faz cinco coisas:

1. **Abre com `FileShare.ReadWrite | FileShare.Delete`.** `ReadWrite` tolera o escritor. `Delete` importa para a rotação no Windows: loggers que arquivam renomeando `app.log` para `app.log.1` chamam `MoveFile`, que falha com uma violação de compartilhamento se algum handle aberto não tiver `FILE_SHARE_DELETE`. Sem ele, o seu tailer quebra a rotação de logs da aplicação, que é um bug muito pior do que perder uma linha.
2. **Vai até o final na primeira abertura.** Essa é a semântica de `tail -f`: mostrar o que acontece de agora em diante. Passe `fromStart: true` para reproduzir o arquivo inteiro. Depois de uma rotação, o helper sempre lê o novo arquivo desde o início, porque tudo nele é novo.
3. **Faz polling com `Task.Delay`.** Um polling de 250 ms no EOF é uma syscall `read` que devolve 0, mais um `open` e um `fstat` para a verificação de rotação. Isso é desprezível. `FileSystemWatcher` parece tentador, mas não funciona em muitos compartilhamentos de rede e bind mounts de contêiner, seu buffer interno estoura sob rajadas e perde eventos, e as notificações `Changed` de um escritor que acrescenta dados são agrupadas e atrasadas pelo sistema operacional. Use-o, se for o caso, como uma dica para encurtar a espera, nunca como único gatilho.
4. **Decodifica com `flush: false` e mantém linhas parciais em buffer.** `DrainCompleteLines` devolve apenas o texto terminado por `\n`, remove um `\r` final para que logs CRLF saiam limpos e deixa o final incompleto em `pending`.
5. **Verifica truncamento e rotação apenas no EOF.** Enquanto houver bytes para ler, nada mais importa. Quando não há, o `fs.Length < fs.Position` baseado no handle detecta `copytruncate`, e `WasReplaced` detecta renomear-e-recriar.

### Por que a rotação precisa de uma verificação própria

Quando o `logrotate` (ou o arquivamento do NLog, ou seu próprio código) renomeia `app.log` e cria um novo, o seu handle não acompanha o nome. Handles apontam para arquivos, não para caminhos: tanto no Unix quanto no Windows com `FILE_SHARE_DELETE`, o handle antigo continua lendo o arquivo renomeado, que nunca mais vai crescer. O tailer ficaria parado no EOF para sempre enquanto a aplicação escreve alegremente no novo `app.log`.

`WasReplaced` abre o caminho de novo e compara tamanhos. Para um log somente de acréscimo, se o caminho ainda nomeia o arquivo que você está lendo, o tamanho dele é igual à sua posição (você está no EOF) ou o escritor acrescentou dados desde então, caso em que `current.Length` é pelo menos igual, porque é lido depois. Um tamanho do caminho abaixo da sua posição ou acima do tamanho do seu handle significa outro arquivo. Eu meço por um handle novo em vez de `FileInfo.Length` porque, no Windows, as informações de tamanho que vêm da entrada de diretório podem ficar defasadas em relação a um arquivo ainda aberto para escrita.

A verificação tem um ponto cego: um arquivo novo que tenha exatamente o mesmo tamanho do antigo em todas as sondagens. Essa janela se fecha assim que o novo arquivo cresce. Se você precisa de identidade à prova de falhas, compare o ID do arquivo (`GetFileInformationByHandle` no Windows, `st_dev` mais `st_ino` de `fstat` no Unix) via P/Invoke. O .NET não expõe nenhum dos dois publicamente a partir do .NET 11.

## Lendo primeiro apenas as últimas N linhas

`tail -n 50 -f` mostra o contexto recente antes de acompanhar. Ler um arquivo de 2 GB para achar as últimas 50 linhas é um desperdício, então leia uma janela a partir do final:

```csharp
// .NET 10 / .NET 11, C# 14
public static async Task<IReadOnlyList<string>> ReadLastLinesAsync(
    string path, int count, int maxBytes = 64 * 1024)
{
    await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    long start = Math.Max(0, fs.Length - maxBytes);
    fs.Seek(start, SeekOrigin.Begin);
    using var reader = new StreamReader(fs, Encoding.UTF8);
    var lines = new Queue<string>(count + 1);
    bool skipFirst = start > 0; // we probably landed mid-line
    string? line;
    while ((line = await reader.ReadLineAsync()) is not null)
    {
        if (skipFirst) { skipFirst = false; continue; }
        lines.Enqueue(line);
        if (lines.Count > count) lines.Dequeue();
    }
    return lines.ToArray();
}
```

Aqui o `StreamReader` é adequado, porque é uma leitura única: os únicos dados parciais estão bem no início (ignorados) e possivelmente na última linha, que você pode mostrar como está. Posicionar-se no meio do arquivo pode cair dentro de uma sequência UTF-8, o que é mais um motivo para descartar a primeira linha. Se 64 KB não contiverem `count` linhas, dobre `maxBytes` e tente de novo. Chame-o, imprima o resultado e então inicie `FollowAsync` com `fromStart: false`. Algumas linhas escritas entre as duas chamadas podem ser perdidas; se isso importar, faça `ReadLastLinesAsync` devolver o offset em que parou e comece a acompanhar a partir dele.

## Armadilhas que não são culpa do leitor

**O escritor precisa dar flush.** Você só enxerga o que chegou ao sistema operacional. O sink de arquivo do Serilog usa `buffered: false` por padrão, e o target de arquivo do NLog tem `autoFlush="true"` por padrão, mas um `StreamWriter` com `AutoFlush = false` guarda na memória até o tamanho do seu buffer. Muitos relatos de "o tailer perde as últimas linhas" são um escritor que ainda não deu flush.

**`copytruncate` perde dados, por design.** No meu teste, o escritor truncou o arquivo 120 ms depois da última escrita, e o tailer, fazendo polling a cada 250 ms, nunca viu essa linha. A própria documentação do `logrotate` avisa que as linhas escritas entre a cópia e o truncamento são perdidas. Prefira a rotação baseada em renomeação (`create`) com uma aplicação que reabre seu arquivo, ou mantenha o intervalo de polling curto.

**Não abra com `FileAccess.ReadWrite`.** Alguns trechos na internet fazem isso, presumivelmente para "combinar" com o escritor. Você só precisa de acesso de leitura, e no Windows pedir acesso de escrita falha se o escritor abriu com `FileShare.Read`.

**Codificação e BOMs.** O helper assume UTF-8, que é o que Serilog, NLog, o redirecionamento do console do Microsoft.Extensions.Logging e quase toda ferramenta Unix escrevem. Se você acompanha logs UTF-16, troque o `Decoder`, e se reproduz com `fromStart: true` um arquivo que começa com um BOM UTF-8, remova `'\uFEFF'` da primeira linha.

**Linhas muito longas.** `pending` cresce até que uma quebra de linha chegue. Se um escritor pode emitir linhas ilimitadas (lixo binário, um blob JSON minificado), limite `pending.Length` e emita ou descarte o que tiver quando ele ultrapassar o limite.

**Vários escritores.** O `shared: true` do Serilog e vários processos acrescentando dados a um mesmo arquivo só funcionam porque cada escrita vai para o final do arquivo de forma atômica. O tailer não se importa com quantos escritores existem, mas o entrelaçamento entre as escritas parciais deles é problema dos escritores, não seu.

## Leitura relacionada

- Se a pergunta não é "o que foi acrescentado", mas "este arquivo já terminou de ser escrito", veja [como detectar quando um arquivo termina de ser escrito no .NET](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/), que cobre a sondagem com `FileShare.None` e a estabilização de tamanho.
- `FollowAsync` é um stream assíncrono. [O que é `IAsyncEnumerable` e quando usá-lo](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) explica por que `[EnumeratorCancellation]` está no parâmetro do token.
- Para parar o tail de forma limpa a partir de um hosted service, [propague o `CancellationToken` pela cadeia de chamadas assíncronas](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Se você quer distribuir as linhas para vários consumidores, coloque um [`Channel<T>` entre o tailer e os processadores](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).
- Para o lado do escritor, [logging estruturado com Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) mostra a configuração do sink de arquivo que este post lê.

## Fontes

- [`StreamReader.cs` em dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs): o construtor com caminho e `FileShare.Read` e a decodificação com `flush: true` no fim do stream.
- [`SafeFileHandle.Unix.cs` em dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): emulação de `FileShare` com `LOCK_SH` / `LOCK_EX` e a opção `System.IO.DisableFileLocking`.
- [`FileSink.cs` em serilog-sinks-file](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs): como o Serilog abre seu arquivo de log.
- [Enum `FileShare` no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
- [`Decoder.GetChars` no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder.getchars), incluindo o parâmetro `flush`.
- [Issue 48757 do dotnet/runtime](https://github.com/dotnet/runtime/issues/48757): locking de arquivos em NFS e `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`.
