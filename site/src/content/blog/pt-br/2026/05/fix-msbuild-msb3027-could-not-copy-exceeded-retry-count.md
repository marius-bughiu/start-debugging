---
title: "Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed"
description: "MSB3027 significa que o MSBuild tentou copiar um arquivo 10 vezes e algum processo ainda retinha o destino. Mate o processo bloqueador, exclua bin/obj do antivírus ou aumente CopyRetryCount."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "pt-br"
translationOf: "2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count"
translatedBy: "claude"
translationDate: 2026-05-11
---

A correção: a task `Copy` do MSBuild tentou dez vezes, com pausas de um segundo, sobrescrever um arquivo no seu diretório `bin/` e algum processo ainda mantinha um handle aberto sobre ele. Encontre o processo responsável com `handle.exe` ou o Monitor de Recursos, mate-o e compile de novo. No Windows, o processo bloqueador é quase sempre a execução anterior do seu próprio programa (`apphost.exe`, `MyApp.exe`, um worker do IIS Express ou um filho de `dotnet watch`), o build-server `MSBuild.exe` que continua residente sob o Visual Studio, ou um antivírus em tempo real que abriu a DLL recém-produzida para inspeção alguns milissegundos antes de o MSBuild tentar sobrescrevê-la. Se você não conseguir corrigir a origem do bloqueio, aumente `CopyRetryCount` e `CopyRetryDelayMilliseconds` no `Directory.Build.props` e siga em frente.

```text
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed. The file is locked by: ".NET Host (4176)"  [C:\src\MyApp\MyApp.csproj]
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' because it is being used by another process.
```

Este artigo foi escrito contra o .NET SDK 11.0.100-preview.4, MSBuild 17.13 e Visual Studio 17.14. A task `Copy` e a string da mensagem MSB3027 estão estáveis desde o MSBuild 15 (Visual Studio 2017), então a mesma lista de verificação se aplica a qualquer projeto SDK-style moderno, de `net6.0` a `net11.0`. O que mudou recentemente foi o comportamento de retry: entre os SDKs 7.0.306 e 7.0.400 o caminho de retry para algumas subclasses de `IOException` foi apertado, e por isso falhas de CI que antes eram invisíveis (o retry tinha sucesso) agora aparecem como MSB3027.

## O que MSB3027 realmente significa

`MSB3027` é lançado pela task `Copy` do MSBuild no fim do loop de retries. A task é conectada pelos targets padrão `_CopyFilesMarkedCopyLocal` e `CopyFilesToOutputDirectory` dentro de `Microsoft.Common.CurrentVersion.targets`, que disparam perto do fim de cada `dotnet build`. O loop é governado por duas propriedades:

- `CopyRetryCount` por padrão vale `10`. A task falha após esse número de falhas consecutivas.
- `CopyRetryDelayMilliseconds` por padrão vale `1000`. A task dorme esse tempo entre tentativas.

Assim, a janela completa de dez tentativas é de cerca de dez segundos. Se um processo retém o arquivo de destino por mais de dez segundos, o MSB3027 dispara. O MSBuild imprime a exception interna (`System.IO.IOException`) na linha seguinte como `MSB3021`, e por isso os dois códigos de erro quase sempre andam juntos.

A entrada do Microsoft Learn sobre [MSB3027](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) cita as quatro causas canônicas: outro programa retém o arquivo, sua conta não consegue escrever no destino, falta espaço no drive, ou o compartilhamento de rede caiu. Na prática, em uma estação de desenvolvimento, a primeira causa responde por bem mais de 95 por cento do tráfego.

## Por que isso acontece (em ordem de prioridade)

Estas são as sete causas recorrentes, classificadas pela frequência com que explicam a falha em um projeto real de .NET 11.

1. **A execução anterior do seu próprio programa ainda está viva.** Aplicações de console travadas em `Console.ReadKey`, workers `IHostedService` esperando um shutdown gracioso e processos órfãos `apphost.exe` de uma sessão de depuração que caiu mantêm um bloqueio sobre o executável principal. A mensagem de erro nomeia o processo diretamente, por exemplo `The file is locked by: ".NET Host (4176)"`.
2. **IIS Express ou o pool de aplicativos do Kestrel está segurando o assembly.** `dotnet run`, `iisexpress.exe` e o processo worker do IIS (`w3wp.exe`) mantêm um read share exclusivo sobre a DLL carregada. Uma compilação iniciada pelo Visual Studio enquanto a sessão F5 anterior ainda roda cai nisso toda vez.
3. **`dotnet watch` está no meio de um rebuild.** Hot reload troca assemblies em vivo, mas em um rude edit dispara um restart completo e existe uma pequena janela em que o processo antigo e o novo build tocam o mesmo arquivo. Projetos com muitos geradores de código-fonte amplificam isso porque a DLL de saída do gerador é copiada duas vezes. O SDK do dotnet acompanha isso em [dotnet/sdk#40911](https://github.com/dotnet/sdk/issues/40911) desde a época do .NET 8.
4. **O antivírus em tempo real escaneou o arquivo no exato momento em que o MSBuild o escreveu.** Windows Defender, CrowdStrike Falcon, SentinelOne e similares abrem todo `.exe` e `.dll` novo para inspeção. O scan termina em algumas centenas de milissegundos, mas se o próximo projeto em uma compilação paralela precisa copiar o mesmo arquivo, a cópia pode correr contra o scanner. Exclusões do Defender para a raiz do repo eliminam esse modo de falha inteiro.
5. **OneDrive ou outro cliente de sincronização abriu o arquivo.** O recurso "Files On-Demand" do OneDrive abre um handle de escrita em qualquer arquivo sob uma pasta sincronizada quando desidrata ou reidrata conteúdo. Se sua árvore de código está em `C:\Users\<você>\OneDrive\...`, isso dispara MSB3027 de forma aleatória em compilações longas.
6. **O build server do MSBuild (ou VS BuildHost) continua conectado.** Com `MSBUILDDISABLENODEREUSE=0` (o padrão), o MSBuild mantém nós `MSBuild.exe` vivos entre builds. Dentro do Visual Studio, o equivalente são `VBCSCompiler.exe` e o build server do Roslyn. Quase nunca seguram targets de cópia, mas um nó travado pode prender um assembly recém-compilado.
7. **Projetos paralelos em uma única solução copiam o mesmo arquivo no mesmo instante.** Dois projetos no mesmo `.sln` que dependem de uma biblioteca compartilhada tentam cada um copiar essa biblioteca para sua própria saída. Com paralelismo `/m`, a segunda cópia pode bater em MSB3021 no `OpenWrite` e esgotar o orçamento de retries. Isso regrediu no SDK 7.0.400 e é rastreado em [dotnet/msbuild#9169](https://github.com/dotnet/msbuild/issues/9169).

## Reprodução mínima: um app de console que mantém o próprio binário aberto

O menor reprodutor é um app de console que não termina. Salve como `MyApp/Program.cs` e `MyApp/MyApp.csproj`:

```xml
<!-- MyApp.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// Program.cs - .NET 11, C# 14
Console.WriteLine("running, press any key to exit");
Console.ReadKey();
```

Inicie-o em um terminal:

```text
dotnet run
```

Depois mude `Program.cs` (adicione um espaço) e de um segundo terminal:

```text
dotnet build
```

A segunda compilação imprime:

```text
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file because it is being used by another process.
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed.
```

Este é o caso canônico. O primeiro terminal é dono da DLL porque o host do .NET a abriu apenas com `FILE_SHARE_READ`, o que exclui escritas.

## A correção, em detalhe

### 1. Encontre o processo bloqueador e mate-o

A mensagem após `MSB3027` lista o processo quando o MSBuild consegue resolvê-lo. Quando não consegue (tipicamente dentro de containers ou em máquinas travadas), recorra a uma destas opções:

```text
:: sysinternals handle.exe - https://learn.microsoft.com/sysinternals/downloads/handle
handle64.exe -nobanner -accepteula C:\src\MyApp\bin\Debug\net11.0\MyApp.dll
```

```powershell
# Get-Process by module path (PowerShell 7.4+)
Get-Process | Where-Object { $_.Modules.FileName -contains 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' }
```

```text
:: Kill by image name
taskkill /im MyApp.exe /f
:: Or by PID from handle.exe output
taskkill /pid 4176 /f
```

Para IIS Express: clique com o botão direito no ícone da bandeja do sistema e `Exit All`, ou `iisexpress /stop /siteid:<id>`. Para IIS completo, um `iisreset` é a opção bruta; um `Stop-WebAppPool -Name "<pool>"` é a cirúrgica.

### 2. Pare de executar o programa no mesmo terminal de onde você compila

A correção mais limpa é de fluxo de trabalho: não deixe uma sessão de depuração anexada enquanto recompila. No Visual Studio, os caminhos `Edit and Continue` e `Hot Reload` normalmente cuidam disso. Pela linha de comando, prefira `dotnet watch` (que está ciente do rebuild) em vez de um loop manual de `dotnet run` mais um `dotnet build` separado.

Se você está no `dotnet watch` e vendo MSB3027 a cada rebuild, o sintoma geralmente é um gerador de código-fonte cuja DLL de saída é reescrita a cada compilação. O workaround documentado no repo do SDK é mover o gerador para um `.csproj` separado com `<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>` e `<EmitCompilerGeneratedFiles>false</EmitCompilerGeneratedFiles>`, e referenciar o projeto do gerador com `OutputItemType="Analyzer" ReferenceOutputAssembly="false"`. A DLL do gerador deixa de ser um destino de cópia.

### 3. Adicione exclusões de antivírus para o repositório

Para o Microsoft Defender abra `Windows Security` > `Virus & threat protection` > `Manage settings` > `Exclusions` > `Add or remove exclusions` > `Add an exclusion` > `Folder`, e adicione:

- A raiz do repo, ou no mínimo cada subdiretório `bin/` e `obj/`.
- `%USERPROFILE%\.nuget\packages` (o cache global do NuGet).
- `%USERPROFILE%\.dotnet` (a instalação do SDK).

Para CrowdStrike / SentinelOne / um Defender gerenciado pela empresa, você não pode fazer isso sozinho; abra um chamado com o time de TI e cite o `.gitattributes` ou `.editorconfig` do seu time como prova de que as pastas bin/obj são artefatos de compilação, não dados de usuário. A própria [documentação de exclusões do Defender](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus) confirma que o scan em tempo real da saída de build é a principal causa de falhas intermitentes do MSBuild em ambientes corporativos.

### 4. Mova o repositório para fora do OneDrive

Se `pwd` dentro do seu repo imprime `C:\Users\<você>\OneDrive\source\...`, mova-o. Clientes de sincronização de qualquer tipo (OneDrive, Dropbox, Google Drive, iCloud) possuem um handle de escrita sobre arquivos que estão subindo ou hidratando, e liberam esse handle no relógio deles, não no do MSBuild. `C:\src\<repo>` fora de qualquer pasta sincronizada é o layout padrão para trabalho .NET no Windows.

### 5. Aumente o orçamento de retries (último recurso)

Se o bloqueio é inevitável (agente de CI com cache compartilhado, antivírus que você não pode excluir, build paralelo batendo em uma dependência compartilhada), aumente o orçamento. Coloque isso em `Directory.Build.props` na raiz do repo para que se aplique a cada projeto:

```xml
<!-- Directory.Build.props - .NET 11 SDK, MSBuild 17.13 -->
<Project>
  <PropertyGroup>
    <CopyRetryCount>20</CopyRetryCount>
    <CopyRetryDelayMilliseconds>2000</CopyRetryDelayMilliseconds>
  </PropertyGroup>
</Project>
```

Isso dá à task `Copy` quarenta segundos de orçamento de retries. Números mais altos só escondem um problema mais sério (um processo travado, um antivírus mal configurado) e fazem cada compilação falha levar um minuto para aparecer, então não passe de `CopyRetryCount=20`.

Para o caso específico de CI onde projetos paralelos competem pela mesma DLL compartilhada, a correção melhor é definir `BuildInParallel=false` para a solução problemática ou marcar a biblioteca compartilhada como `<PackageReference>` para um feed NuGet em vez de `<ProjectReference>`. As duas fazem a corrida desaparecer.

### 6. Desligue o build server quando os nós do MSBuild travam

Nós do MSBuild travados são raros mas visíveis: `tasklist /fi "imagename eq MSBuild.exe"` mostra nós que não são reusados há muitos minutos. Encerre-os com:

```text
dotnet build-server shutdown
```

Rode isso entre builds em scripts que sofrem com MSB3027 intermitente, ou defina `MSBUILDDISABLENODEREUSE=1` para desativar o reuso de nós por completo. Os tempos de build sobem alguns segundos, mas as falhas de bloqueio de arquivo de cauda longa desaparecem.

## Pegadinhas e variantes

- **MSB3026 é um warning, não um erro.** Significa que o MSBuild fez retry de uma cópia e o retry teve sucesso. Se você só vê MSB3026, a compilação passou e não há nada para corrigir; o ruído só te diz que ocorreu um bloqueio transitório. Trate MSB3026 repetido como sinal para adicionar uma exclusão do Defender antes que escale para MSB3027 na próxima semana.
- **MSB3021 sem MSB3027.** Esse é o comportamento antigo, anterior ao loop de retries. Se você só vê MSB3021, está em uma toolchain bem mais velha (.NET Core 2.x ou `msbuild.exe` do VS 2015), e a resolução é a mesma menos o botão `CopyRetryCount`.
- **Variantes no Linux e macOS.** O número do erro é o mesmo. Os kernels Unix não impõem bloqueio mandatório de arquivo como o Windows, então a maior parte das causas de bloqueio não se aplica. As que sobram são erros de permissão (o diretório de destino é de propriedade do `root` após um build em Docker) e sistemas de arquivos cheios. `df -h` e `ls -ld bin/` descartam ambos em segundos.
- **Containers.** Compilar dentro de um container Linux com um volume montado do host Windows é o pior dos dois mundos: o antivírus do host escaneia arquivos escritos de dentro do container. Ou compile dentro do container com um volume local do container (`docker volume create`), ou compile direto no host.
- **The file is locked by: 'System' or 'unknown'.** Quando o processo bloqueador é reportado como `System (4)` ou sem nome, o culpado quase sempre é um driver de antivírus em modo kernel. Defender, CrowdStrike e SentinelOne aparecem assim. Um `taskkill` em modo usuário não ajuda; a correção é uma exclusão ou desabilitar temporariamente a proteção em tempo real.
- **Native AOT e publish com trim.** `dotnet publish -c Release` para um projeto Native AOT às vezes escreve o `.exe` de saída duas vezes (uma para o passo de publish, outra para a verificação de trim). Em IO lento, isso corre contra si mesmo. Adicione `<PublishAot>true</PublishAot>` e `<PublishSingleFile>false</PublishSingleFile>` juntos para evitar a cópia duplicada.

## Relacionados

- [Fix: The type or namespace name 'X' could not be found after adding a project reference](/pt-br/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) é a outra metade do kit de troubleshooting para projetos SDK-style. Falhas de referência e de cópia compartilham uma causa raiz com mais frequência do que se imagina.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) cobre os cenários de trim e AOT em que MSB3027 também aparece pelo caminho de publish.
- [How to profile a .NET app with dotnet-trace and read the output](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) é útil quando o processo bloqueador é o seu próprio programa e você quer descobrir o que o manteve vivo em primeiro lugar.
- [.NET watch in .NET 11 preview 3: Aspire crash recovery](/pt-br/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/) é a mudança recente no SDK que afeta a variante `dotnet watch` desta falha.
- [Visual Studio 2026 Hot Reload: auto-restart on rude edits](/pt-br/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) é a contraparte na IDE para a causa de hot reload.

## Fontes

- Microsoft Learn, [MSB3027 diagnostic code - MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) (a referência oficial de uma tela)
- Microsoft Learn, [Configure Microsoft Defender Antivirus exclusions by extension, name, or location](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus)
- GitHub, [dotnet/msbuild#9169 File copy is no longer retried, causing builds to randomly fail](https://github.com/dotnet/msbuild/issues/9169)
- GitHub, [dotnet/sdk#40911 dotnet watch fails with MSB3021 (locked file) when project references custom source generator](https://github.com/dotnet/sdk/issues/40911)
- Microsoft Sysinternals, [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle), a ferramenta canônica para nomear o processo bloqueador
