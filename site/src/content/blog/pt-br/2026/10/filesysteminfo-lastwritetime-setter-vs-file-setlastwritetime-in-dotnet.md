---
title: "Setter FileSystemInfo.LastWriteTime vs File.SetLastWriteTime no .NET"
description: "Os dois terminam na mesma chamada do SO, então o timestamp gravado é idêntico. As diferenças estão ao redor: qual cache é invalidado, se diretórios funcionam no Windows, como um DateTime que não é UTC é convertido e se você pode usar um handle aberto. Use File.SetLastWriteTimeUtc, por handle quando o arquivo está aberto. Verificado no .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "filesystem"
  - "io"
lang: "pt-br"
translationOf: "2026/10/filesysteminfo-lastwritetime-setter-vs-file-setlastwritetime-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-30
---

Use `File.SetLastWriteTimeUtc` (ou `Directory.SetLastWriteTimeUtc` para pastas), e use a sobrecarga com `SafeFileHandle` se você estiver definindo o horário de um arquivo no qual ainda está gravando. Use o setter de `FileInfo.LastWriteTimeUtc` apenas quando você já tem esse `FileInfo` em mãos e vai ler suas propriedades novamente depois, porque o setter é a única API que também atualiza o cache daquela instância. Os dois caminhos chamam exatamente o mesmo `FileSystem.SetLastWriteTime` interno, então os bits que chegam ao disco são idênticos. O que muda é tudo ao redor dessa chamada. Em qualquer caso, passe um `DateTime` com `Kind = Utc` para o membro `...Utc`, nunca um horário local ou não especificado para o membro que não é UTC.

Tudo abaixo foi executado no .NET 10.0.10 (SDK 10.0.302, C# 14) no macOS 27 com APFS, em uma máquina cujo fuso horário local é `Europe/Bucharest` (UTC+2 na data do teste). O comportamento no Windows é citado do branch `release/10.0` do dotnet/runtime. O código envolvido mal mudou desde o .NET 7, quando as sobrecargas com handle foram adicionadas, então as mesmas regras valem para o .NET 8, 9 e as previews do .NET 11.

## A comparação em resumo

| | `fileInfo.LastWriteTimeUtc = t` | `File.SetLastWriteTimeUtc(path, t)` |
| --- | --- | --- |
| Chamada do SO (Windows) | `SetFileInformationByHandle(FileBasicInfo)` | igual |
| Chamada do SO (Unix) | `utimensat(..., AT_SYMLINK_NOFOLLOW)` | igual |
| Invalida o cache de | somente aquela instância de `FileInfo` | nada (nenhum cache envolvido) |
| Outros objetos `FileInfo` para o mesmo caminho | desatualizados até `Refresh()` | desatualizados até `Refresh()` |
| Diretório como alvo no Windows | somente via `DirectoryInfo` | falha, use `Directory.SetLastWriteTimeUtc` |
| Aceita um `SafeFileHandle` aberto | não | sim, desde o .NET 7 |
| `DateTime.MinValue` com setter de horário local, fuso UTC+ | limita silenciosamente | lança `ArgumentOutOfRangeException` |
| Arquivo inexistente | `FileNotFoundException` | `FileNotFoundException` |
| Custo por chamada (10 mil chamadas, APFS, M4) | 10,4 us | 10,7 us (por handle: 8,6 us) |

## O que as duas APIs realmente fazem

Tirando a superfície pública, as duas se encontram em um único ponto. Aqui está o lado de `FileSystemInfo`, de `FileSystemInfo.cs` e `FileSystemInfo.Windows.cs`:

```csharp
// dotnet/runtime release/10.0, System.Private.CoreLib
public DateTime LastWriteTime
{
    get => LastWriteTimeUtc.ToLocalTime();
    set => LastWriteTimeUtc = value.ToUniversalTime();
}

public DateTime LastWriteTimeUtc
{
    get => LastWriteTimeCore.UtcDateTime;
    set => LastWriteTimeCore = File.GetUtcDateTimeOffset(value);
}

internal DateTimeOffset LastWriteTimeCore   // Windows
{
    set
    {
        FileSystem.SetLastWriteTime(FullPath, value, (this is DirectoryInfo));
        _dataInitialized = -1;   // invalidate this instance's cache
    }
}
```

E o lado de `File`:

```csharp
// dotnet/runtime release/10.0, File.cs
public static void SetLastWriteTime(string path, DateTime lastWriteTime)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), lastWriteTime, false);

public static void SetLastWriteTimeUtc(string path, DateTime lastWriteTimeUtc)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), GetUtcDateTimeOffset(lastWriteTimeUtc), false);
```

Esse `false` no final é o flag `asDirectory`, e ele importa no Windows (mais adiante). No Unix, o setter de `FileInfo` passa pela sua própria struct `FileStatus`, enquanto `File` usa um `default(FileStatus)` descartável, mas os dois chamam o mesmo `SetAccessOrWriteTimeCore`. Esse método primeiro executa um novo stat no arquivo para poder gravar de volta o horário de acesso atual sem alterações, depois chama `utimensat` com `AT_SYMLINK_NOFOLLOW` e então invalida o cache de status. No Windows, ambos abrem o caminho com `FILE_WRITE_ATTRIBUTES` e chamam `SetFileInformationByHandle` com um `FILE_BASIC_INFO` em que todos os campos exceto `LastWriteTime` são zero, o que o Windows interpreta como "deixar inalterado".

Portanto, não existe um comportamento do tipo "o setter de `FileInfo` é preguiçoso" ou "ele só altera o objeto em memória", que é uma suposição comum. O setter grava no disco imediatamente, exatamente como o método estático.

## Invalidação de cache: a diferença que você realmente vai encontrar

`FileSystemInfo` guarda em cache tudo o que lê. O primeiro acesso a uma propriedade faz um stat no arquivo, e os acessos seguintes retornam o snapshot até que algo chame `Refresh()`. O setter invalida o cache da instância em que você o chamou, e de mais nenhuma. Este probe torna os três casos visíveis:

```csharp
// .NET 10.0.10, C# 14 - run with: dotnet run probe.cs
var path = Path.Combine(Path.GetTempPath(), "a.txt");
File.WriteAllText(path, "hello");
var target = new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);

var fi1 = new FileInfo(path);
var fi2 = new FileInfo(path);
_ = fi1.LastWriteTimeUtc; _ = fi2.LastWriteTimeUtc; // populate both caches

fi1.LastWriteTimeUtc = target;
Console.WriteLine(fi1.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2026-10-30T12:04:26.3262150Z (stale)
fi2.Refresh();
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z

var fi3 = new FileInfo(path); _ = fi3.Length;          // snapshot now
File.SetLastWriteTimeUtc(path, target.AddYears(1));
Console.WriteLine(fi3.LastWriteTimeUtc.ToString("O")); // 2020-01-02... (stale)
Console.WriteLine(File.GetLastWriteTimeUtc(path).ToString("O")); // 2021-01-02...
```

Esse é o único motivo real para preferir o setter. Se um método recebe um `FileInfo`, define seu timestamp e depois quem chamou registra em log `fileInfo.LastWriteTime` ou o compara com outro arquivo, o setter mantém esse objeto correto. Chamar `File.SetLastWriteTimeUtc(fileInfo.FullName, t)` no mesmo ponto deixa quem chamou com um valor desatualizado, e esse bug só aparece quando alguém lê a propriedade novamente. Se você seguir esse caminho, adicione `fileInfo.Refresh()` depois.

O inverso é igualmente importante: o setter não alcança outras instâncias de `FileInfo`, incluindo as que vieram de `DirectoryInfo.EnumerateFiles`. Elas foram preenchidas durante a enumeração e permanecem congeladas. O mesmo comportamento de snapshot é o que faz `FileInfo.Length` mentir sobre arquivos que estão crescendo, o que abordei em detalhes em [por que FileInfo.Length retorna um tamanho desatualizado no Windows](/pt-br/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/).

## Diretórios: a armadilha exclusiva do Windows em File.SetLastWriteTime

`File.SetLastWriteTime` sempre passa `asDirectory: false`. No Windows, esse flag decide se `OpenHandleToWriteAttributes` adiciona `FILE_FLAG_BACKUP_SEMANTICS` à chamada de `CreateFile`:

```csharp
// dotnet/runtime release/10.0, FileSystem.Windows.cs
int dwFlagsAndAttributes = Interop.Kernel32.FileOperations.FILE_FLAG_OPEN_REPARSE_POINT;
if (asDirectory)
{
    dwFlagsAndAttributes |= Interop.Kernel32.FileOperations.FILE_FLAG_BACKUP_SEMANTICS;
}
```

A [documentação de `CreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) é explícita ao dizer que você deve definir `FILE_FLAG_BACKUP_SEMANTICS` para obter um handle de um diretório, então `File.SetLastWriteTimeUtc(@"C:\data\folder", t)` falha com um erro de acesso negado no Windows. `DirectoryInfo.LastWriteTimeUtc = t` passa `this is DirectoryInfo` e funciona, assim como `Directory.SetLastWriteTimeUtc`.

No Linux e no macOS, o flag só afeta qual tipo de exceção é lançado para um caminho inexistente, então a mesma chamada de `File` em um diretório funciona. Meu probe confirmou isso no APFS. É exatamente o tipo de código que passa no CI em um runner Linux e depois falha no notebook Windows de um desenvolvedor. Se o seu código pode receber tanto um arquivo quanto uma pasta, faça um branch com `Directory.Exists` e chame a classe estática correspondente, ou construa o subtipo correto de `FileSystemInfo`.

Uma estranheza relacionada: `new FileInfo(directoryPath).Exists` é `false`, mas no Unix `new FileInfo(directoryPath).LastWriteTimeUtc = t` funciona e altera o horário do diretório. Não conte com isso.

## Local vs UTC: onde os dois caminhos divergem em valores extremos

Os membros que não são UTC são onde as duas APIs deixam de ser simétricas. `File.SetLastWriteTime(string, DateTime)` passa o `DateTime` diretamente para um parâmetro `DateTimeOffset`, então a conversão implícita de `DateTime` para `DateTimeOffset` é executada. O setter de `FileInfo.LastWriteTime` chama `value.ToUniversalTime()`. Para datas normais, os dois concordam, e ambos tratam `DateTimeKind.Unspecified` como horário local:

```text
File.SetLastWriteTime(Unspecified 12:00)    -> 09:00Z   (treated as local, UTC+3 in June)
File.SetLastWriteTimeUtc(Unspecified 12:00) -> 12:00Z   (treated as UTC)
File.SetLastWriteTime(Utc-kind 03:04:05Z)   -> 03:04:05Z (Kind honoured)
fi.LastWriteTime = Unspecified 12:00        -> 09:00Z
fi.LastWriteTimeUtc = Local-kind 12:00      -> 09:00Z   (Local converted, not reinterpreted)
```

Os extremos são diferentes. Em qualquer fuso horário a leste do UTC, `DateTime.MinValue` não tem equivalente UTC válido. `ToUniversalTime()` limita silenciosamente em `DateTime.MinValue`, enquanto a conversão implícita para `DateTimeOffset` recusa:

```csharp
// .NET 10.0.10, Europe/Bucharest (UTC+2)
File.SetLastWriteTime(path, DateTime.MinValue);
// ArgumentOutOfRangeException: The UTC time represented when the offset is applied
// must be between year 0 and 10,000. (Parameter 'offset')

new FileInfo(path).LastWriteTime = DateTime.MinValue; // no exception here
```

A oeste do UTC, `DateTime.MaxValue` lança exceção da mesma forma. Você não usaria esses valores de propósito, mas caminhos de código de "voltar ao padrão" e campos não inicializados os colocam ali com mais frequência do que você imagina.

Passar pela conversão não significa que o valor possa ser armazenado. O `FILETIME` do Windows começa em 1601, e `DateTimeOffset.ToFileTime()` lança `ArgumentOutOfRangeException: Not a valid Win32 FileTime.` para qualquer valor anterior, então no Windows as duas APIs lançam exceção para `DateTime.MinValue`. O APFS armazena uma contagem de nanossegundos com sinal de 64 bits desde 1970, então no macOS a gravação "bem-sucedida" de `DateTime.MinValue` resulta em `1677-09-21T00:12:43.1452241Z`, o instante mais antigo que o APFS consegue representar. Nenhum dos dois é o que você queria. Valide o intervalo você mesmo antes de chamar qualquer uma das APIs.

O horário de verão é o outro motivo para ficar nos membros `...Utc`. Um horário local durante a hora de recuo do outono é ambíguo, e `ToUniversalTime()` escolhe a interpretação do horário padrão sem avisar. Se o timestamp veio de outra máquina, de um banco de dados ou de uma entrada de arquivo compactado, ele quase certamente era UTC desde o início. Mantenha-o assim até chegar ao disco. O mesmo conselho vale para [valores `DateTime` em payloads JSON](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

## A sobrecarga com handle, e por que arquivos abertos desfazem seu timestamp

Somente a classe estática tem `File.SetLastWriteTime(SafeFileHandle, DateTime)` e `File.SetLastWriteTimeUtc(SafeFileHandle, DateTime)`, adicionadas no .NET 7. Elas chamam `SetFileInformationByHandle` ou `futimens` no handle que você já possui, o que dispensa a busca pelo caminho e a abertura extra.

O motivo mais importante para usá-las é a ordem das operações. Definir o timestamp enquanto o seu próprio `FileStream` ainda mantém bytes em buffer é um bug clássico, porque o SO atualiza o horário de modificação novamente quando esses bytes são descarregados no `Dispose`:

```csharp
// .NET 10.0.10, C# 14
using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);               // sits in FileStream's 4 KB buffer
    File.SetLastWriteTimeUtc(p, target);
    // File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z
}
// File.GetLastWriteTimeUtc(p) here: 2026-10-30T12:04:26Z  <- your value is gone

using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);
    fs.Flush();                            // all writes reach the OS first
    File.SetLastWriteTimeUtc(fs.SafeFileHandle, target);
}
// File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z  <- kept
```

A regra é "a última gravação vence": o timestamp deve ser a última coisa a tocar o arquivo. Descarregue (flush), defina por handle e feche. Definir depois do bloco `using` por caminho também funciona, mas custa uma segunda abertura e deixa uma janela em que outro processo pode ver o arquivo com o horário errado. Isso importa se um consumidor está [observando o arquivo até terminar de ser gravado](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) ou consultando timestamps periodicamente, como faz a [abordagem de diff de snapshots para compartilhamentos de rede](/pt-br/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/).

`FileSystemInfo` não tem um equivalente baseado em handle, então, se você precisa desse padrão, você está em `File`, independentemente da preferência.

## Symlinks, horário de criação e precisão

Três coisas são iguais nos dois caminhos, mas as pessoas costumam errá-las:

- **Symlinks**: o Windows abre com `FILE_FLAG_OPEN_REPARSE_POINT` e o Unix chama `utimensat` com `AT_SYMLINK_NOFOLLOW`, então as duas APIs alteram o próprio link e deixam o alvo intacto. Se você quer o alvo, resolva-o primeiro com `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)` e defina o horário no resultado.
- **Horário de criação no macOS**: definir um horário de modificação anterior ao horário de nascimento faz o kernel recuar o horário de nascimento para coincidir. O .NET detecta isso no macOS e restaura o horário de criação original com `setattrlist`, então `File.GetCreationTimeUtc` não muda depois de você retroceder `LastWriteTime`. No Linux não existe horário de nascimento configurável, e o .NET informa o mais antigo entre `ctime` e `mtime` como horário de criação.
- **Precisão**: `DateTime` tem ticks de 100 ns. NTFS, APFS e ext4 mantêm todos eles (meu round-trip de `...07.1234567Z` voltou exatamente igual), FAT32 arredonda para 2 segundos e exFAT mantém 10 ms. Se você compara timestamps entre volumes, por exemplo em uma ferramenta de backup ou sincronização, compare com uma tolerância em vez de `==`.

As duas APIs lançam `FileNotFoundException` para um arquivo inexistente. Isso é assimétrico em relação aos getters, que retornam `1601-01-01T00:00:00Z` em vez de lançar exceção. Um código que lê o horário, decide e depois grava pode, portanto, ver um arquivo desaparecer entre as duas chamadas e receber uma exceção de um método que parecia inofensivo. Se o arquivo pode ser excluído concorrentemente, capture `FileNotFoundException` em volta da gravação.

## O benchmark que não importa

Para completar: 10.000 chamadas cada em um volume APFS aquecido (Apple M4, .NET 10.0.10, Release, `Stopwatch` em volta de um loop) custam 10,72 us por chamada para `File.SetLastWriteTimeUtc(path, t)`, 10,40 us para o setter de `FileInfo` e 8,60 us para a sobrecarga com handle em um handle já aberto. As variantes por caminho são iguais dentro do ruído, porque cada uma faz um stat, um `utimensat` e, no lado de `FileInfo`, um reset de cache. O handle economiza a resolução do caminho. Nada disso deve guiar sua escolha. Se você está alterando o horário de milhares de arquivos, o stat dentro de cada chamada de definição domina, e paralelizar sobre os arquivos ajudará muito mais do que trocar de API.

## A recomendação, repetida

Use por padrão `File.SetLastWriteTimeUtc(path, utc)` e `Directory.SetLastWriteTimeUtc(path, utc)`. Elas são explícitas sobre o tipo de entrada que você está atingindo, não podem deixar um objeto em cache para trás e têm uma sobrecarga com handle para o caso "definir no arquivo que acabei de gravar", que é de onde vêm a maioria dos bugs de timestamp. Passe para `fileInfo.LastWriteTimeUtc = utc` quando o `FileInfo` for a unidade de trabalho no seu código e alguém for ler suas propriedades novamente, porque o setter é a única API que mantém essa instância sincronizada. Evite os membros que não são UTC em ambos e valide que o valor cabe no intervalo do sistema de arquivos de destino antes de gravá-lo.

## Leitura relacionada

- [Por que FileInfo.Length retorna um tamanho desatualizado no Windows](/pt-br/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) aprofunda o mesmo cache de `FileSystemInfo` pelo ângulo do tamanho.
- [Como detectar quando um arquivo termina de ser gravado no .NET](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) cobre o lado do consumidor de "a última gravação vence".
- [FileSystemWatcher vs polling em um compartilhamento de rede](/pt-br/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) depende de timestamps que você acabou de aprender a definir corretamente.
- [Como acompanhar um arquivo de log enquanto outro processo grava nele](/pt-br/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) mostra os flags de `FileShare` usados nos probes acima.
- [Como executar um app C# baseado em arquivo com dotnet run](/pt-br/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) se você quiser executar `probe.cs` novamente por conta própria.

## Fontes

- [`FileSystemInfo.LastWriteTime`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetime) e [`File.SetLastWriteTimeUtc`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.setlastwritetimeutc) (Microsoft Learn)
- [`FileSystemInfo.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.cs), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs), [`File.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs) (dotnet/runtime)
- [`FileSystem.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystem.Windows.cs), [`FileStatus.Unix.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileStatus.Unix.cs), [`pal_time.c`](https://github.com/dotnet/runtime/blob/release/10.0/src/native/libs/System.Native/pal_time.c) (dotnet/runtime)
- [`CreateFileW`, `FILE_FLAG_BACKUP_SEMANTICS`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) e [`FILE_BASIC_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info) (Microsoft Learn)
- [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) (páginas de manual do Linux)
- [File times, resolution per file system](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times) (Microsoft Learn)
