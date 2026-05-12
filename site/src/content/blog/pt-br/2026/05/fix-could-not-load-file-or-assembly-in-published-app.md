---
title: "Correção: System.IO.FileNotFoundException: Could not load file or assembly em um app publicado"
description: "Funciona com dotnet run, falha após dotnet publish. A DLL geralmente está faltando na pasta de publicação, não no runtime. Verifique deps.json, Private em ProjectReference e trimming."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "publish"
  - "trimming"
lang: "pt-br"
translationOf: "2026/05/fix-could-not-load-file-or-assembly-in-published-app"
translatedBy: "claude"
translationDate: 2026-05-12
---

A correção: um `FileNotFoundException: Could not load file or assembly` após `dotnet publish` quase sempre significa que a DLL não está na pasta de publicação, não que o runtime não consiga encontrá-la. Liste a saída do publish, localize o assembly faltante pelo nome e trate o problema como um bug de empacotamento. As quatro causas que cobrem noventa por cento dos casos reais são um `ProjectReference` marcado com `Private=false`, um `PackageReference` com `PrivateAssets="all"`, o trimming descartando um assembly carregado por reflexão, e um publish self-contained vs framework-dependent escolhendo o RID errado. Defina `COREHOST_TRACE=1`, execute o binário publicado uma vez e o log do host dirá qual caminho de busca foi tentado.

```text
Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.
File name: 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
   at MyApp.Program.Main(String[] args)

--- End of stack trace from previous location ---
   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()
   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)
```

Este guia foi escrito contra .NET 11 preview 4 (runtime `Microsoft.NETCore.App` 11.0.0-preview.4) e o .NET SDK 11.0.100-preview.4 no Windows, Linux e macOS. O tipo da exceção, a identidade de quatro partes do assembly na mensagem e as regras de probing do host estão inalterados desde o .NET Core 3.0; o que mudou em .NET 8 e .NET 11 foi o analisador do trimmer, que agora emite avisos `IL2026` / `IL3050` logo de cara, para que você pare de descobrir isso em tempo de execução. Se a mensagem disser `Could not load file or assembly` seguido de `or one of its dependencies`, a dependência é o arquivo que está faltando, não o que aparece primeiro. Leia a segunda cláusula antes de mexer em qualquer coisa.

## Por que o runtime não acha o assembly

O host do .NET (`dotnet.exe` ou o stub apphost gerado ao lado do seu `.exe` no `dotnet publish`) carrega assemblies a partir de um conjunto fixo de caminhos de probing derivados do seu `<app>.deps.json`. Ele não busca no `PATH`, não busca na GAC, e não recorre à pasta bin do projeto que o compilou. Os caminhos que ele tenta são, na ordem:

1. O diretório do apphost (`AppContext.BaseDirectory`).
2. O diretório do framework compartilhado para aplicações framework-dependent (`{DOTNET_ROOT}/shared/Microsoft.NETCore.App/{version}`).
3. As pastas de fallback do NuGet se a resolução `useNuGet` estiver ativa (apenas em desenvolvimento).
4. Qualquer coisa declarada em `additionalProbingPaths` dentro de `<app>.runtimeconfig.dev.json`, que **não** está presente em um app publicado.

Quando a máquina de desenvolvimento tem o assembly no cache do NuGet e o runtimeconfig aponta para lá, `dotnet run` encontra. O app publicado não tem nem o cache nem o runtimeconfig de desenvolvimento, então a mesma chamada lança a exceção. A exceção é o host informando que a identidade do assembly em `<app>.deps.json` não foi resolvida para nenhum arquivo em disco.

A página oficial do Microsoft Learn [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) é a referência autoritativa para a ordem de probing; as [instruções de host tracing](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) descrevem como despejar o log de probing em um arquivo.

## Uma reprodução mínima

```xml
<!-- .NET 11, SDK 11.0.100-preview.4 -->
<!-- src/MyApp/MyApp.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
      <Private>false</Private>
    </ProjectReference>
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14
using Contoso.Shared;

var greeter = new Greeter();
Console.WriteLine(greeter.Hello("world"));
```

`dotnet run` funciona. `dotnet publish -c Release -r win-x64 -o ./out` termina sem erros. `./out/MyApp.exe` lança `Could not load file or assembly 'Contoso.Shared'`. A flag `<Private>false</Private>` diz ao MSBuild para não copiar `Contoso.Shared.dll` para a saída do consumidor, assumindo que a GAC ou outro veículo de implantação vai fornecê-lo. Para apps .NET (Core) não há GAC, então o arquivo simplesmente não está lá.

Esta é a forma canônica do bug: uma única propriedade em algum lugar do grafo de projetos diz ao MSBuild para não incluir a DLL, e o passo de publish respeita isso. A correção é encontrar a propriedade e removê-la.

## Correção 1: pare de suprimir a cópia

Abra o arquivo de projeto do pai do assembly faltante e procure por qualquer uma destas propriedades na referência:

```xml
<!-- These three lines all suppress the copy. Remove them. -->
<ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
  <Private>false</Private>
</ProjectReference>

<Reference Include="Contoso.Shared">
  <CopyLocal>false</CopyLocal>
</Reference>

<PackageReference Include="Some.Library" Version="1.0.0">
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

`Private=false` e `CopyLocal=false` são equivalentes para referências de projeto e de assembly. `PrivateAssets="all"` em um `PackageReference` significa que o ativo é consumido em tempo de build mas não flui para o projeto consumidor, então a DLL é omitida do `deps.json`. O uso legítimo de `PrivateAssets="all"` é para pacotes de analyzers, geradores de código-fonte e build tasks (onde o runtime nunca precisa da DLL). Se o pacote é `Microsoft.Extensions.Logging.Abstractions` ou qualquer coisa que você chame em runtime, a flag está errada. Remova-a, execute `dotnet publish` e confirme que a DLL agora está ao lado do seu app.

A página do MS Learn [Controlling dependency assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) lista todos os valores que `PrivateAssets` aceita e o que cada um desabilita.

## Correção 2: ative o host tracing e leia o log de probe

Se você não sabe qual DLL está faltando, pergunte ao host. Defina `COREHOST_TRACE=1` e `COREHOST_TRACEFILE=corehost.log` antes de iniciar o binário publicado:

```powershell
# Windows, PowerShell, .NET 11
$env:COREHOST_TRACE = "1"
$env:COREHOST_TRACE_VERBOSITY = "4"
$env:COREHOST_TRACEFILE = "corehost.log"
./out/MyApp.exe
```

```bash
# Linux / macOS, bash, .NET 11
COREHOST_TRACE=1 COREHOST_TRACE_VERBOSITY=4 COREHOST_TRACEFILE=corehost.log ./out/MyApp
```

O log é longo, mas a seção que você quer procurar é `Attempting to load`. Cada tentativa é registrada com o caminho completo que o host tentou. A última tentativa que falhou antes da exceção é a resposta:

```text
Attempting to load: C:\out\Contoso.Shared.dll - false
Attempting to load: C:\out\runtimes\win-x64\lib\net11.0\Contoso.Shared.dll - false
File [C:\out\Contoso.Shared.dll] does not exist
```

Agora você sabe que o host esperava `Contoso.Shared.dll` diretamente sob a pasta do app e não encontrou. A correção é fazer com que a saída de publish inclua o arquivo nesse caminho, não adicionar caminhos de probing ou load contexts.

## Correção 3: quando o trimming descarta o assembly silenciosamente

Aplicar trimming em um app .NET 11 self-contained remove qualquer assembly que o trimmer não consiga provar ser alcançável via análise estática. `Assembly.Load("Plugins.Foo")`, `Type.GetType("Some.Type, Some.Assembly")` e a maioria dos containers de DI baseados em reflexão são invisíveis para o trimmer. O assembly é excluído da saída de publish e aparece em runtime como `FileNotFoundException`.

Para confirmar que o trimming é a causa, publique uma vez com os avisos do trimmer transformados em fatais:

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <TrimmerSingleWarn>false</TrimmerSingleWarn>
  <SuppressTrimAnalysisWarnings>false</SuppressTrimAnalysisWarnings>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Se o publish agora falhar com `IL2026` ou `IL3050` apontando para a sua chamada de reflexão, o trimming é a causa. A correção é enraizar o assembly para que o trimmer o preserve:

```xml
<!-- .NET 11 -->
<ItemGroup>
  <TrimmerRootAssembly Include="Plugins.Foo" />
</ItemGroup>
```

Para um tipo individual, marque o método que dispara a carga com `DynamicDependencyAttribute`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public static class PluginLoader
{
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicConstructors, "Plugins.Foo.Entry", "Plugins.Foo")]
    public static object Load() => Activator.CreateInstance(Type.GetType("Plugins.Foo.Entry, Plugins.Foo")!)!;
}
```

A lista completa de roots do trimmer e atributos de dependência está em [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming). Para um olhar mais profundo no lado do runtime, o post sobre [Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) percorre os mesmos avisos do trimmer em uma forma mais agressiva.

## Correção 4: RID errado, ou framework-dependent publicado como self-contained

Se o assembly listado no erro é `Microsoft.NETCore.App` ou um de seus componentes (`System.Private.CoreLib.dll`, `System.Runtime.dll`), o problema não é o seu código, é que o app publicado é framework-dependent mas a máquina de destino não tem um framework compartilhado compatível instalado:

```text
Could not load file or assembly 'System.Runtime, Version=11.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
```

Essa mensagem significa que o host encontrou `MyApp.dll` e leu `MyApp.runtimeconfig.json`, então pediu `Microsoft.NETCore.App 11.0.0` e não recebeu nada. Ou instale o framework compartilhado na máquina de destino (`dotnet --list-runtimes`), ou republique como self-contained:

```bash
# .NET 11
dotnet publish -c Release -r win-x64 --self-contained true -o ./out
```

O runtime envia cada DLL do framework para `./out`, o app deixa de depender do runtime instalado na máquina, e a FileNotFoundException desaparece. O post correspondente [reduzir o cold start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discute os tradeoffs do publish (tamanho vs portabilidade vs cold start) com mais profundidade.

A outra falha em forma de RID é um pacote NuGet com binários nativos que distribui apenas alguns RIDs. Se você publica para `osx-arm64` mas um pacote só traz nativos `win-x64` e `linux-x64`, o `runtimes/win-x64/native/foo.dll` do pacote é excluído do seu publish e o wrapper gerenciado lança `FileNotFoundException`. A correção é abrir uma issue com o mantenedor do pacote ou fixar uma versão que distribui o RID que você precisa. A pasta `runtimes/` do pacote é a fonte da verdade.

## Pegadinhas e casos parecidos

**`Could not load file or assembly 'X' or one of its dependencies`.** O assembly nomeado está em disco. Uma dependência dele não está. Execute `dotnet-dump analyze` ou `dnSpy` contra `X.dll` para ler sua lista de assemblies referenciados, ou use o trace do host da Correção 2 para encontrar a falha de segundo nível. Tratar o primeiro nome como o arquivo faltante leva você a rodar em círculos.

**`FileLoadException`, não `FileNotFoundException`.** Um `FileLoadException: Could not load file or assembly 'X, Version=2.0.0.0'` significa que o arquivo está presente mas a versão, cultura ou public key token não bate com o que foi solicitado. Esse é um problema de binding redirect de assembly (comum quando uma dependência transitiva é atualizada só no nível superior). A correção é adicionar uma versão correspondente ao seu `PackageReference` de nível superior para que o grafo resolvido colapse em uma única versão. O runtime não lê mais os binding redirects do `app.config` no .NET (Core); apenas o runtime do .NET Framework lia. Se você portou de `app.config`, os redirects agora são ignorados e a versão resolvida em `deps.json` é a que é carregada.

**`TypeLoadException` e `MissingMethodException`.** Não são erros de "assembly não encontrado". Significam que o assembly foi carregado, mas o tipo ou método dentro dele tem uma assinatura diferente da esperada pelo chamador, quase sempre um descompasso de versão. A forma da correção é a mesma do `FileLoadException`: alinhar o grafo de versões.

**`BadImageFormatException`.** O arquivo está em disco e tem o nome certo, mas é da arquitetura errada (uma DLL `x86` carregada em um processo `x64`, ou uma DLL gerenciada carregada como nativa). Verifique o RID e a `Platform` dos dois lados. É uma categoria irmã, não um `FileNotFoundException` disfarçado.

**Publicação em arquivo único.** Com `PublishSingleFile=true`, o apphost extrai os assemblies empacotados para uma pasta temporária no primeiro arranque (`%TEMP%/.net/<appname>/<hash>`). Se você vê `FileNotFoundException` para um assembly que pode ser visto dentro do bundle (`dotnet-bundle list`), a causa mais comum é uma chamada customizada `AssemblyLoadContext.LoadFromAssemblyPath(Assembly.GetExecutingAssembly().Location)`. `Assembly.Location` é vazio para bundles single-file no .NET 6+, então o argumento de caminho está errado. Mude para `AppContext.BaseDirectory`, ou use `Assembly.LoadFromAssemblyName` e deixe o host resolver o arquivo empacotado.

**Deploy de ASP.NET Core para IIS.** Se o publish envia o arquivo mas o IIS ainda lança a exceção, verifique se a `Identity` do application pool tem acesso de leitura à pasta de publish e se o `aspnetcorev2.dll` está na versão atual (`%programfiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll`). Um ANCM antigo pega um `deps.json` velho. É um problema de deploy, não de build.

**Plugins / load contexts dinâmicos.** Se você carrega plugins via `AssemblyLoadContext`, o contexto do plugin não herda os assemblies do contexto padrão. Um plugin que chama `Newtonsoft.Json` precisa do próprio `Newtonsoft.Json.dll` ao lado do plugin, ou de um `AssemblyDependencyResolver` construído a partir do caminho do plugin. Mesma forma da Correção 1, mas a superfície é a pasta do plugin, não a do app. O tutorial do MS Learn em [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) mostra o padrão do resolver de ponta a ponta.

**O build copiou, o publish não.** O publish executa um conjunto diferente de targets do MSBuild em relação ao build (`ComputeFilesToPublish` em vez de `BuiltProjectOutputGroup`). Um `<Content Include="Foo.dll" CopyToOutputDirectory="PreserveNewest" />` coloca o arquivo em `bin/`, mas apenas `<None Include="Foo.dll"><Pack>true</Pack><CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory></None>` (ou `<Content>` com a flag de publish) coloca na pasta publish. Se a DLL aparece em `bin/Release/net11.0/` mas não em `bin/Release/net11.0/publish/`, essa é a causa.

## Relacionados

- [Correção: O tipo ou nome de namespace não pode ser encontrado após uma referência de projeto](/pt-br/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) é o primo em tempo de compilação desta exceção: os mesmos desencontros de `Private` e `TargetFramework` aparecem como `CS0246` no build, ou como `FileNotFoundException` em runtime.
- [Correção: MSBuild MSB3027 could not copy exceeded retry count](/pt-br/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) cobre a falha de cópia irmã em tempo de publish que deixa você com metade da pasta publicada.
- [Correção: PlatformNotSupportedException em Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) é o caso parecido de trim-and-publish em que o assembly está presente mas um caminho de código não está.
- [Como reduzir o cold start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discute os tradeoffs self-contained vs framework-dependent para o mesmo passo de publish.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) é a visão mais profunda dos avisos do trimmer que capturam essa classe de bug em tempo de compilação.

## Fontes

- [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) (MS Learn)
- [Host tracing in the .NET runtime host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) (`dotnet/runtime`)
- [Controlling dependency assets with PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) (MS Learn)
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) (MS Learn)
- [`DynamicDependencyAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicdependencyattribute) (MS Learn)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) (MS Learn)
- [`AppContext.BaseDirectory` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.appcontext.basedirectory) (MS Learn)
