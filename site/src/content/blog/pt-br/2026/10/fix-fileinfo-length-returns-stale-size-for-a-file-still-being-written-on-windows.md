---
title: "Correção: FileInfo.Length retorna um tamanho desatualizado para um arquivo que ainda está sendo gravado no Windows"
description: "FileInfo guarda o tamanho em cache, a enumeração lê a entrada de diretório do NTFS, atualizada de forma preguiçosa, e o escritor ainda pode manter bytes nos próprios buffers. Use Refresh() ou, melhor ainda, leia o tamanho de um handle compartilhado com RandomAccess.GetLength."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "csharp"
  - "filesystem"
lang: "pt-br"
translationOf: "2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows"
translatedBy: "claude"
translationDate: 2026-10-13
---

`FileInfo.Length` mente por três motivos distintos, e eles se acumulam. Primeiro, um `FileInfo` guarda seus dados em cache na primeira vez que você lê qualquer propriedade e nunca os lê de novo até você chamar `Refresh()`. Segundo, um `FileInfo` que veio de `DirectoryInfo.EnumerateFiles` ou `GetFiles` no Windows é preenchido a partir da entrada de diretório do NTFS, e o NTFS só atualiza essa cópia do tamanho quando o escritor fecha seu último handle. Terceiro, o processo que escreve pode ainda manter os bytes nos próprios buffers de `StreamWriter` / `FileStream`, então o sistema operacional realmente ainda não os viu. A correção confiável é parar de perguntar ao caminho e perguntar a um handle: `using var h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); long size = RandomAccess.GetLength(h);`. Se você controla o escritor, faça flush nele. Os números de buffering abaixo foram medidos no .NET 10.0.10 (SDK 10.0.302) e no .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128), e saíram idênticos. Os caminhos de código específicos do Windows foram citados do código-fonte do dotnet/runtime na `main`.

## O sintoma no contexto

Nenhuma exceção é lançada. O relato do bug geralmente se parece com um destes:

```
// what people see, .NET 10 / .NET 11 on Windows
size = 0          // the log file is clearly growing in Notepad++
size = 4096       // the writer has logged 6000 characters
size = 1048576    // Explorer says 1 MB, the copy job says 37 MB
```

O padrão é sempre o mesmo. Um loop de monitoramento, um job de upload ou uma verificação do tipo "espere até o arquivo parar de crescer" lê `FileInfo.Length` enquanto outro processo (ou outra thread) tem o arquivo aberto para escrita. O número está atrasado, às vezes congelado, e salta para o valor correto assim que o escritor fecha o arquivo. O Explorer e o `dir` mostram o mesmo número congelado, o que convence as pessoas de que o problema é do Windows e não do código delas. É parcialmente as duas coisas.

## Por que isso acontece

Há três camadas, e cada uma pode causar o problema sozinha.

**1. `FileInfo` é um instantâneo, não uma visão ao vivo.** `FileSystemInfo` mantém um struct `WIN32_FILE_ATTRIBUTE_DATA` privado e um flag `_dataInitialized`. O primeiro acesso a uma propriedade o preenche, e todo acesso posterior retorna o valor em cache. A [documentação de `FileInfo.Length`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) diz isso diretamente: o valor é pré-armazenado em cache quando a instância veio de `GetFiles` ou `EnumerateFiles`, e você precisa chamar `Refresh` para obter o valor mais recente. Um detalhe sutil: o preenchimento é preguiçoso. Construir `new FileInfo(path)` não toca o disco, então o "momento do instantâneo" é quando seu código lê pela primeira vez `Length`, `Exists` ou qualquer timestamp, o que muitas vezes é bem antes do que você imagina.

**2. A enumeração lê a entrada de diretório, e o NTFS a atualiza de forma preguiçosa.** No Windows, `FileSystemEnumerator` chama `NtQueryDirectoryFile` com `FileFullDirectoryInformation`, e `FileSystemInfo.Init(FILE_FULL_DIR_INFORMATION*)` copia `EndOfFile` direto para o tamanho em cache. Esse número vem do índice do diretório, não do arquivo. Como Raymond Chen explica em [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), o NTFS trata o tamanho como uma propriedade do arquivo e só o replica na entrada de diretório como uma otimização para listagens. Desde o Windows Vista, essa réplica é atualizada quando o último handle do objeto de arquivo é fechado. Um escritor que mantém um log aberto por horas deixa a entrada de diretório com o tamanho que ela tinha quando o arquivo foi aberto, que muitas vezes é 0. É exatamente isso que o Explorer, o `dir`, `Directory.GetFiles` seguido de `new FileInfo(...)` no resultado e `FileSystemEntry.Length` em um `FileSystemEnumerable` personalizado reportam.

**3. O escritor ainda não gravou os bytes.** Um `StreamWriter` guarda caracteres no próprio buffer e depois entrega bytes codificados a um `FileStream`, que tem seu próprio buffer de 4096 bytes por padrão. Até os buffers encherem ou alguém chamar `Flush()`, o sistema operacional não recebeu um único byte, então toda API em toda plataforma reporta corretamente o tamanho antigo. Essa é a camada que a maioria das pessoas esquece, porque vista de fora é idêntica às outras duas.

Uma quarta camada só aparece em compartilhamentos de rede: o redirecionador do cliente SMB guarda metadados de arquivo em cache para consultas baseadas em caminho. `FileInfoCacheLifetime` e `DirectoryCacheLifetime` têm ambos o padrão de 10 segundos nas versões atuais do Windows (veja [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server)), então um caminho UNC pode mostrar um tamanho de até 10 segundos atrás mesmo depois de um `Refresh()`.

## Reprodução mínima

Este app baseado em arquivo escreve por meio de um `StreamWriter` sem fazer flush e amostra o tamanho de quatro formas: um `FileInfo` em cache, o mesmo `FileInfo` após `Refresh()`, um handle novo via `RandomAccess.GetLength` e um `FileInfo` vindo da enumeração de diretório. Execute com `dotnet run probe.cs`.

```csharp
// .NET 10 / .NET 11, C# 14, file-based app: dotnet run probe.cs
#:property PublishAot=false
using Microsoft.Win32.SafeHandles;

string path = Path.Combine(Path.GetTempPath(), "stale-probe.log");
File.Delete(path);

using var writer = new StreamWriter(new FileStream(path, FileMode.Create,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete));
var cached = new FileInfo(path);
Console.WriteLine($"start: cached={cached.Length}");   // first access: snapshot taken here

writer.Write(new string('a', 1000));
Report("after 1000 chars, no flush");
writer.Write(new string('a', 5000));
Report("after 6000 chars, no flush");
writer.Flush();
Report("after StreamWriter.Flush()");

var fromEnum = new DirectoryInfo(Path.GetTempPath())
    .EnumerateFiles("stale-probe.log").Single();
writer.Write(new string('b', 4000)); writer.Flush();
Console.WriteLine($"enumerated FileInfo (no Refresh) after +4000: {fromEnum.Length}");
fromEnum.Refresh();
Console.WriteLine($"enumerated FileInfo after Refresh: {fromEnum.Length}");

void Report(string label)
{
    long stale = cached.Length;
    cached.Refresh();
    long refreshed = cached.Length;
    using SafeFileHandle h = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    Console.WriteLine($"{label}: cached={stale} refreshed={refreshed} " +
        $"handle={RandomAccess.GetLength(h)} writer.BaseStream.Position={writer.BaseStream.Position}");
}
```

Saída, idêntica no .NET 10.0.10 e no .NET 11.0.0 RC1 (macOS arm64, APFS):

```
start: cached=0
after 1000 chars, no flush: cached=0 refreshed=0 handle=0 writer.BaseStream.Position=0
after 6000 chars, no flush: cached=0 refreshed=4096 handle=4096 writer.BaseStream.Position=5120
after StreamWriter.Flush(): cached=4096 refreshed=6000 handle=6000 writer.BaseStream.Position=6000
enumerated FileInfo (no Refresh) after +4000: 6000
enumerated FileInfo after Refresh: 10000
```

Leia linha por linha:

- Depois de 1000 caracteres, nada chegou ao SO. O `StreamWriter` ainda está segurando tudo, então até o handle diz 0. Nenhuma correção do lado do leitor pode ajudar aqui.
- Depois de 6000 caracteres, o `StreamWriter` empurrou 5120 caracteres (cinco blocos de 1024 caracteres) para o `FileStream`, e o `FileStream` gravou um buffer completo de 4096 bytes no SO. Toda API honesta diz 4096. O `FileInfo` em cache ainda diz 0.
- Depois de `Flush()`, o tamanho real é 6000. O `FileInfo` em cache diz 4096, porque a chamada anterior a `Report` o atualizou e nada o atualizou desde então.
- O `FileInfo` enumerado ficou congelado no momento da enumeração e precisou de um `Refresh()` para ver os 4000 bytes extras.

No macOS e no Linux, as camadas 1 e 3 são toda a história, porque `stat` lê o inode e não existe uma cópia separada do tamanho no diretório. No Windows, a camada 2 vem por cima: execute o mesmo programa lá e olhe a pasta no Explorer enquanto ele espera, e a listagem do diretório fica atrás do valor do handle até o escritor ser descartado. Não medi essa metade em uma máquina Windows para este post. O mecanismo está documentado por Raymond Chen, e o caminho de código exato (`NtQueryDirectoryFile` até `FileSystemInfo.Init`) é visível no código-fonte do runtime linkado no final.

## A correção, em detalhes

Escolha a correção que corresponde à camada que você está enfrentando. Na maioria dos códigos reais, você está enfrentando mais de uma.

### 1. Recomendado: leia o tamanho de um handle, não de um caminho

Uma consulta baseada em handle vai ao objeto de arquivo aberto, que é onde o NTFS mantém o fim de arquivo autoritativo. É a única resposta que Raymond Chen descreve como correta (`GetFileSize` em um handle), e ela contorna tanto o cache do `FileInfo` quanto a entrada de diretório. Desde o .NET 6, você pode fazer isso sem um `FileStream`:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Win32.SafeHandles;

static long GetLiveLength(string path)
{
    // FileShare.ReadWrite: the writer already holds write access, so we must allow it.
    // FileShare.Delete: do not break a writer that renames or deletes during rotation.
    using SafeFileHandle handle = File.OpenHandle(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);

    return RandomAccess.GetLength(handle);
}
```

`File.OpenHandle` mais `RandomAccess.GetLength` é mais leve do que `new FileStream(...).Length`: sem alocação de buffer, sem rastreamento de posição, e no Windows `RandomAccess.GetLength` chama `GetFileInformationByHandleEx(FileStandardInfo)` no handle e retorna `EndOfFile`. Se você já tem um `FileStream` aberto no arquivo (por exemplo, está fazendo tail dele), use `stream.Length` nesse stream. Ele passa pela mesma consulta ao handle.

Mais um cache se esconde aqui. No Windows, `SafeFileHandle` define `_lengthCanBeCached` quando o handle foi aberto somente para leitura **e** sem `FileShare.Write`, e a partir daí retorna o primeiro tamanho que obteve. Isso é correto, porque ninguém pode escrever no arquivo enquanto seu handle recusa o compartilhamento de escrita. Significa, porém, que `FileShare.Read` nunca é a escolha certa para observar um arquivo em crescimento. Se o escritor já está em execução, sua abertura falha. Se você abre primeiro, a abertura do escritor falha, o que é pior, porque agora você quebrou o produtor. Use `FileShare.ReadWrite` (mais `FileShare.Delete`), e o runtime consulta o SO a cada chamada.

O modo de compartilhamento importa. Se você abrir com o `FileShare.Read` padrão, a abertura falha com `IOException: The process cannot access the file because it is being used by another process`, porque o escritor já tem acesso de escrita e seu modo de compartilhamento se recusa a permiti-lo. Esse erro é o motivo mais comum pelo qual as pessoas desistem da abordagem com handle e voltam para o `FileInfo`.

Um efeito colateral que vale conhecer: abrir e fechar seu próprio handle também faz o NTFS atualizar a entrada de diretório quando esse handle é fechado, segundo o mesmo post do Old New Thing. Então, depois de uma chamada a `GetLiveLength`, o Explorer e a enumeração também se atualizam, até o escritor acrescentar dados de novo.

### 2. Se precisar usar `FileInfo`, chame `Refresh()` antes de cada leitura

Para um loop de polling, mantenha um único `FileInfo` e atualize-o a cada iteração:

```csharp
// .NET 10 / .NET 11, C# 14
var fi = new FileInfo(path);
long last = -1;
while (!ct.IsCancellationRequested)
{
    fi.Refresh();                       // without this, Length never changes
    if (fi.Exists && fi.Length != last)
    {
        Console.WriteLine($"{fi.Length:N0} bytes");
        last = fi.Length;
    }
    await Task.Delay(TimeSpan.FromSeconds(1), ct);
}
```

No Windows, `Refresh()` em um `FileInfo` construído a partir de um caminho passa por `FileSystem.FillAttributeInfo`, que chama `GetFileAttributesEx` no caminho e recorre a `FindFirstFile` (uma leitura da entrada de diretório) somente quando essa chamada falha com algo como `ERROR_SHARING_VIOLATION` ou `ERROR_ACCESS_DENIED`. Esse fallback existe para `pagefile.sys` e arquivos com exclusão pendente. A Microsoft não documenta se `GetFileAttributesEx` sempre reflete o tamanho ao vivo de um arquivo aberto, então trate `Refresh()` como "corrige a camada 1 e provavelmente corrige a camada 2 em NTFS local" e use a abordagem com handle onde a correção importar.

### 3. Nunca confie em tamanhos vindos da enumeração para arquivos que podem estar abertos

`Directory.EnumerateFiles` retornando caminhos não tem problema. `DirectoryInfo.EnumerateFiles` retornando objetos `FileInfo`, e `FileSystemEntry.Length` dentro de uma transformação de `FileSystemEnumerable<T>`, são rápidos justamente porque reaproveitam a cópia do tamanho na entrada de diretório. Essa é a cópia que o NTFS atualiza de forma preguiçosa. Use a enumeração para encontrar arquivos candidatos e depois consulte cada um que lhe interessa:

```csharp
// .NET 10 / .NET 11, C# 14
foreach (FileInfo fi in new DirectoryInfo(inbox).EnumerateFiles("*.csv"))
{
    long listed = fi.Length;          // directory-entry copy on Windows, may be stale
    long live = GetLiveLength(fi.FullName);
    if (listed != live)
        Console.WriteLine($"{fi.Name}: listing says {listed:N0}, handle says {live:N0}");
}
```

A abertura por arquivo custa alguns acessos de metadados, e é por isso que o Explorer não faz isso. Para uma pasta com milhares de arquivos, consulte apenas os que são novos ou foram modificados recentemente.

### 4. Se você controla o escritor, faça flush (e saiba o que flush significa)

Nenhum truque do lado do leitor consegue ver bytes que nunca saíram do processo do escritor. Se um monitor precisa ver o progresso, o escritor precisa empurrar os bytes para o SO:

```csharp
// .NET 10 / .NET 11, C# 14
using var log = new StreamWriter(new FileStream(path, FileMode.Append,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
{
    AutoFlush = true    // every Write call pushes through StreamWriter and FileStream to the OS
};
```

`AutoFlush = true` custa uma chamada de sistema por `Write`. Para um logger de alto volume, chame `Flush()` em um timer ou após cada registro lógico. `Flush()` (ou `Flush(false)` em um `FileStream`) entrega os bytes ao cache do SO, o que basta para outros processos verem o novo tamanho. `FileStream.Flush(flushToDisk: true)` os força também para o disco físico. Isso serve para durabilidade, não para visibilidade, e é bem mais lento.

### 5. Em compartilhamentos de rede, considere o cache do cliente SMB

Um `Refresh()` em um caminho UNC pode ser atendido pelo cache de informações de arquivo do redirecionador SMB por até `FileInfoCacheLifetime` segundos (10 por padrão). Abrir um handle, como na correção 1, envia uma requisição de abertura ao servidor, então também é a melhor escolha aqui. Se você não pode alterar o código, pode reduzir o tempo de vida no cliente com `Set-SmbClientConfiguration -FileInfoCacheLifetime 0`, mas isso deixa mais lenta toda consulta de metadados baseada em caminho na máquina. Trate isso como um diagnóstico, não como uma correção.

## Armadilhas e casos parecidos

**"O arquivo terminou" é uma pergunta diferente.** Um tamanho estável não prova que o escritor terminou. Ele pode simplesmente estar pausado. Se o que você realmente precisa é saber "posso processar esse arquivo agora", use o padrão de renomear ao concluir ou uma sondagem de abertura exclusiva, de [como detectar quando um arquivo termina de ser gravado no .NET](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/).

**Ler os novos bytes conforme chegam** também é um problema separado. Para isso, mantenha um `FileStream` de leitura compartilhada aberto e compare `fs.Length` com `fs.Position`, como mostrado em [como fazer tail de um arquivo de log em C# enquanto outro processo está escrevendo nele](/pt-br/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/). Esse post também cobre truncamento e rotação, em que um tamanho menor significa "recomeçar", não "desatualizado".

**`LastWriteTime` fica desatualizado dos mesmos modos.** O timestamp da entrada de diretório é replicado exatamente como o tamanho, e o `FileInfo` o guarda em cache no mesmo struct. Tudo o que foi dito acima vale para `LastWriteTimeUtc`, e o NTFS ainda pode adiar atualizações de timestamp por conta própria. Não use apenas um timestamp para detectar crescimento.

**Arquivos pré-alocados.** Alguns escritores (bancos de dados, gerenciadores de download, `FileStream` com `preallocationSize`, chamadas a `SetLength`) estendem o arquivo até o tamanho final logo no início e o preenchem depois. O handle reporta o fim de arquivo verdadeiro, que já é o tamanho final. Aqui, "o tamanho não mudou" não diz nada sobre o progresso. Use o sinal de progresso do próprio escritor.

**Escritores com arquivo mapeado em memória.** Um escritor que mapeia o arquivo e escreve pela view muda o conteúdo sem mudar o tamanho, e o fim de arquivo foi fixado quando o mapeamento foi criado. O polling baseado em tamanho não consegue detectar essas escritas de forma alguma.

**`IOException` ao abrir o handle.** Se o escritor abriu o arquivo com `FileShare.None` (o padrão de `File.Create` / `File.OpenWrite`), nenhuma outra abertura é permitida, nem a sua com `FileShare.ReadWrite`. Então você só consegue ler o tamanho possivelmente desatualizado baseado em caminho, ou mudar o escritor. Capturar essa violação de compartilhamento é a base da sondagem "ainda está sendo gravado?" no post relacionado acima.

## Relacionados

- [Como detectar quando um arquivo termina de ser gravado no .NET](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) cobre polling de estabilidade, sondagens de abertura exclusiva e o truque de renomear no lado do produtor.
- [Como fazer tail de um arquivo de log em C# enquanto outro processo está escrevendo nele](/pt-br/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) é o leitor baseado em handle completo, com tratamento de rotação.
- [Como ler um CSV grande no .NET 11 sem estourar a memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) é útil quando o arquivo já está completo e você precisa processá-lo.
- [Como executar um app C# baseado em arquivo com dotnet run no .NET 11](/pt-br/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) explica as diretivas `#:property` usadas na sonda acima.

## Fontes

- Raymond Chen, [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), The Old New Thing.
- [Propriedade `FileInfo.Length`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) e [`FileSystemInfo.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.refresh), Microsoft Learn.
- [`RandomAccess.GetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.getlength) e [`File.OpenHandle`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.openhandle), Microsoft Learn.
- Código-fonte do dotnet/runtime: [`FileSystem.Attributes.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Common/src/System/IO/FileSystem.Attributes.Windows.cs) (`FillAttributeInfo`), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs) (`Init` a partir de `FILE_FULL_DIR_INFORMATION`), [`FileSystemEnumerator.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/Enumeration/FileSystemEnumerator.Windows.cs) (`NtQueryDirectoryFile`).
- [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server), `FileInfoCacheLifetime` e `DirectoryCacheLifetime` do cliente SMB.
