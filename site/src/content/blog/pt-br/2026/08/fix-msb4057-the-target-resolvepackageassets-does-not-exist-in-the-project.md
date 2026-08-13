---
title: "Correção: MSB4057 The target \"ResolvePackageAssets\" does not exist in the project no .NET MAUI"
description: "MSB4057 significa que um target rodou contra o build externo de cross-targeting de um projeto multi-target do MAUI. Passe um TFM ou condicione o target com TargetFramework."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "dotnet-maui"
  - "msbuild"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/08/fix-msb4057-the-target-resolvepackageassets-does-not-exist-in-the-project"
translatedBy: "claude"
translationDate: 2026-08-13
---

`ResolvePackageAssets` não está faltando e seus pacotes não estão quebrados. O target rodou contra o **build externo (cross-targeting)** de um projeto multi-target, e o SDK do .NET não importa `ResolvePackageAssets` ali. Ou você fixa um único framework (`dotnet build -f net10.0-android -t:ResolvePackageAssets`), ou, se o arquivo `.targets` de um pacote NuGet está chamando ele, condiciona esse target com `Condition="'$(TargetFramework)' != ''"` para que rode apenas nos builds internos. Apagar `bin` e `obj` não vai ajudar.

Tudo abaixo foi verificado no .NET SDK 10.0.201 (MSBuild 18.3.0) com os workloads `maui-android` / `maui-ios` / `maui-maccatalyst` 10.0.20. O mecanismo de cross-targeting não muda no .NET 11.

## O erro em contexto

```text
C:\src\MauiApp1\MauiApp1.csproj : error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

Build FAILED.
    0 Warning(s)
    1 Error(s)
```

Quando o gatilho é um pacote NuGet, o erro traz um arquivo e uma coluna em vez do caminho do projeto, e essa é a pista de que quem pediu foi um arquivo `.targets`, não você:

```text
C:\Users\me\.nuget\packages\ikvm.maven.sdk\1.9.2\buildTransitive\IKVM.Maven.Sdk.targets(37,64):
  error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

## Por que o MSB4057 aparece em um projeto multi-target

Um aplicativo MAUI tem `TargetFrameworks` (no plural):

```xml
<!-- .NET 10, MAUI 10 app csproj, from dotnet new maui -->
<TargetFrameworks>net10.0-android</TargetFrameworks>
<TargetFrameworks Condition="!$([MSBuild]::IsOSPlatform('linux'))">$(TargetFrameworks);net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
<TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
```

O MSBuild compila esse projeto **duas vezes sobre si mesmo**: uma passagem externa que não faz nada além de distribuir o trabalho, e uma passagem interna para cada framework. O SDK decide em qual você está com uma única propriedade, definida em `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets`:

```xml
<!-- .NET SDK 10.0.201, Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets -->
<PropertyGroup Condition="'$(TargetFrameworks)' != '' and '$(TargetFramework)' == ''">
  <IsCrossTargetingBuild>true</IsCrossTargetingBuild>
</PropertyGroup>

<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.CrossTargeting.targets"
        Condition="'$(IsCrossTargetingBuild)' == 'true'"/>
<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.targets"
        Condition="'$(IsCrossTargetingBuild)' != 'true'"/>
```

Esse último par explica tudo. `ResolvePackageAssets` está definido em `Microsoft.PackageDependencyResolution.targets`, que é importado por `Microsoft.NET.Sdk.targets`, que é importado **apenas quando `IsCrossTargetingBuild` não é true**. No build externo você recebe `Microsoft.NET.Sdk.CrossTargeting.targets` no lugar, e o conjunto completo de targets disponíveis encolhe para isto:

- De `Microsoft.Common.CrossTargeting.targets`: `Build`, `Clean`, `Rebuild`, `DispatchToInnerBuilds`, `GetTargetFrameworks`, `GetTargetFrameworksWithPlatformFromInnerBuilds`, `InitializeSourceControlInformation`
- De `Microsoft.NET.Sdk.CrossTargeting.targets`: `Publish`, `GetAllRuntimeIdentifiers`, `GetPackagingOutputs`
- De `Microsoft.NET.Sdk.Workloads.CrossTargeting.targets`: `_GetRequiredWorkloads`

Peça qualquer coisa fora dessa lista contra o build externo e o MSBuild levanta MSB4057. `ResolvePackageAssets`, `GetTargetPath`, `GetCopyToOutputDirectoryItems` e `ComputeFilesToPublish` estão todos fora dela. É por isso também que o mesmo texto de erro aparece como `The target "GetTargetPath" does not exist in the project` quando o AppHost do .NET Aspire tenta orquestrar um projeto MAUI: mesmo mecanismo, nome de target diferente.

## Reprodução mínima

Você não precisa do MAUI para ver isso. Qualquer projeto com `TargetFrameworks` no plural se comporta de forma idêntica, o que reduz tudo a dois arquivos:

```xml
<!-- MultiLib/MultiLib.csproj, .NET SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
</Project>
```

```bash
# .NET SDK 10.0.201
# outer build: no -f, so TargetFramework is empty
dotnet build -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

# inner build: -f selects one framework
dotnet build -t:ResolvePackageAssets -f net10.0
# Build succeeded.
```

Os mesmos dois comandos contra um aplicativo `dotnet new maui` recém-criado falham e funcionam da mesma forma, com `-f net10.0-android`.

## Como confirmo que estou em um build externo?

Antes de sair editando arquivos de projeto, prove em qual build você está. O switch `-getProperty` avalia o projeto sem compilá-lo, então é instantâneo mesmo em um aplicativo MAUI:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:IsCrossTargetingBuild -getProperty:TargetFramework
```

Em um aplicativo MAUI sem framework selecionado:

```json
{
  "Properties": {
    "IsCrossTargetingBuild": "true",
    "TargetFramework": ""
  }
}
```

`IsCrossTargetingBuild: true` confirma que o MSB4057 é o problema de cross-targeting e não um erro de digitação. Adicione `-p:TargetFramework=net10.0-android` e o mesmo comando retorna um `IsCrossTargetingBuild` vazio, o que significa que o build interno tem o conjunto completo de targets do SDK. Para ver entre quais frameworks você pode escolher, peça por eles diretamente:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:TargetFrameworks
# net10.0-android;net10.0-ios;net10.0-maccatalyst;net10.0-windows10.0.19041.0
```

Se `IsCrossTargetingBuild` voltar vazio e você ainda receber MSB4057, pule para a seção do projeto que não é no estilo SDK: é outra causa raiz com o mesmo código de erro.

## Como impeço que o arquivo .targets de um pacote NuGet quebre o build externo?

Esta é a correção para a esmagadora maioria dos relatos no MAUI, porque é a que você encontra sem ter pedido nenhum target pelo nome. Um pacote NuGet (ou seu próprio `Directory.Build.targets`) se engancha em `AfterTargets="Build"` e declara uma dependência de `ResolvePackageAssets`. Nos builds internos isso funciona. Depois o target `Build` externo roda, `AfterTargets="Build"` dispara de novo, e a dependência não resolve:

```xml
<!-- Directory.Build.targets, broken on a multi-targeted project -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Um `dotnet build` comum contra o `MultiLib` acima produz exatamente isso, e a ordem entrega o jogo:

```text
ran for TF=[net9.0]
ran for TF=[net10.0]
Directory.Build.targets(4,11): error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
Build FAILED.
```

Os dois builds internos funcionaram e *depois* a passagem externa falhou. Se seu log de build mostra o trabalho por framework terminando e *então* MSB4057, este é o seu caso. Adicione a condição:

```xml
<!-- Directory.Build.targets, fixed. .NET SDK 10.0.201 -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets"
          Condition="'$(TargetFramework)' != ''">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Agora o mesmo build reporta `ran for TF=[net9.0]`, `ran for TF=[net10.0]`, `Build succeeded.` A condição é o idioma canônico do SDK para dizer "somente no build interno", e é o que o pacote deveria ter publicado. Se o target problemático mora dentro de um pacote em `~/.nuget/packages/<id>/<ver>/build*/`, não edite ali: o próximo restore sobrescreve sua mudança. Abra o bug no projeto original e, enquanto isso, desabilite a importação localmente.

## Como invoco um único target pela CLI?

Se é você quem digita `-t:`, nomeie um framework:

```bash
# .NET SDK 10.0.201, MAUI 10
dotnet build -t:ResolvePackageAssets -f net10.0-android
```

Isso importa para scripts e etapas de CI que chamam targets individuais para inspecionar um build. `dotnet build` e `dotnet publish` sem `-t:` são seguros por conta própria, porque `Build` e `Publish` existem no conjunto de cross-targeting e sabem distribuir o trabalho.

## Como chamo um target de outro projeto com a tarefa MSBuild?

Quando um projeto executa um target em outro (ferramentas próprias, os targets de orquestração de um SDK, uma etapa de empacotamento), a tarefa `MSBuild` herda a mesma regra. Isto falha:

```xml
<!-- broken: no framework selected on the callee -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj" Targets="GetTargetPath">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

```text
MultiLib.csproj : error MSB4057: The target "GetTargetPath" does not exist in the project.
```

Defina a propriedade na chamada e ela resolve:

```xml
<!-- fixed. .NET SDK 10.0.201 -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj"
           Targets="GetTargetPath"
           Properties="TargetFramework=net10.0">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

Se você não quer deixar um framework fixo no código, chame `GetTargetFrameworks` primeiro (ele existe no build externo, que é exatamente para o que serve) e depois itere sobre o resultado.

## Preciso mudar um ProjectReference para um projeto multi-target?

Um `ProjectReference` comum para um projeto multi-target **não** produz MSB4057. O MSBuild negocia um framework compatível automaticamente, e um aplicativo de console `net10.0` referenciando a biblioteca `net10.0;net9.0` acima compila limpo. Você só precisa intervir quando a negociação não consegue escolher um vencedor, o que é comum quando um projeto de testes ou de ferramentas referencia o head de um aplicativo MAUI. Use `SetTargetFramework`:

```xml
<!-- .NET SDK 10.0.201 -->
<ItemGroup>
  <ProjectReference Include="..\MultiLib\MultiLib.csproj"
                    SetTargetFramework="TargetFramework=net9.0" />
</ItemGroup>
```

Isso força a referência para um único build interno, e `MultiLib.dll` cai no diretório de saída do consumidor como esperado. Se em vez de MSB4057 você vir `NETSDK1005: Assets file doesn't have a target for ...`, isso é a negociação falhando e não um target ausente, e `SetTargetFramework` continua sendo a correção.

## E se o projeto não for no estilo SDK?

Existe um segundo caminho, sem relação com o primeiro, para o mesmo código de erro. Um `.csproj` legado que importa `Microsoft.CSharp.targets` diretamente nunca importa os targets do SDK do .NET, então `ResolvePackageAssets` não existe em **nenhuma** passagem:

```xml
<!-- legacy non-SDK csproj -->
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

```bash
# .NET SDK 10.0.201
dotnet msbuild -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

É isso que pega quem adiciona um pacote NuGet ciente do SDK (IKVM.Maven.SDK é o exemplo recorrente) a uma biblioteca de classes antiga, ou quem mantém um projeto de binding da era Xamarin dentro de uma solução MAUI. Aqui `IsCrossTargetingBuild` está vazio, então o diagnóstico acima distingue os dois casos com um único comando. A correção é converter o projeto para o estilo SDK, ou parar de referenciar pacotes que assumem targets do SDK. Migrar esses resquícios costuma ser a decisão certa de qualquer forma se você já está saindo do Xamarin.Forms 5.0 para o .NET MAUI 11.

## Detalhes e erros parecidos que caem nesta página por engano

**MSB4018: The "ResolvePackageAssets" task failed unexpectedly.** Outro erro, outra causa. O target existe e *rodou*; a tarefa lançou uma exceção. Isso normalmente é um `project.assets.json` corrompido ou um pacote ilegível no cache global, e é o único caso em que apagar `obj/` e rodar `dotnet restore` de novo realmente ajuda.

**"The ResolvePackageAssets task was not given a value for the required parameter TargetFramework."** Também é confusão entre build interno e externo, mas significa que o target foi alcançado com um `TargetFramework` vazio em vez de não ser encontrado. Mesma correção: selecione um framework.

**MSB4057 vindo do `dotnet ef` no .NET 10.** Registrado como uma regressão da ferramenta `dotnet-ef` 10 em [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), corrigida para o marco 10.0.2. Se você esbarrar nisso, fixe a versão da ferramenta em vez de remodelar seu projeto:

```bash
# workaround for the dotnet-ef 10 regression
dotnet tool update --global dotnet-ef --version 9.0.10
```

**MSB4057 nomeando um target que você mesmo escreveu.** Aí o target realmente está faltando ou está escrito errado, que é o caso descrito em [MSB4057 na documentação do MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057). Confira a grafia de `BeforeTargets`, `AfterTargets`, `DependsOnTargets` e `CallTarget`, e verifique se nenhuma `Condition` na definição do target o excluiu.

**Orquestração do Aspire sobre um head do MAUI.** [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043) é o mesmo problema de build externo aparecendo como `The target "GetTargetPath" does not exist`. Não há correção limpa do seu lado: um aplicativo MAUI não é um recurso servível do Aspire, então remova-o do AppHost e referencie no lugar uma biblioteca de classes compartilhada de target único.

## Quais targets pertencem ao build interno?

Tudo que entra num projeto atrás de entradas do compilador, ativos de pacotes ou caminhos de saída pertence ao build interno. Se um target seu toca `ResolvePackageAssets`, `@(ReferencePath)` ou `$(TargetPath)`, ele precisa de `Condition="'$(TargetFramework)' != ''"`. Essa única linha previne a maior parte dos relatos de MSB4057 em repositórios MAUI, e não custa nada em projetos de target único, onde `TargetFramework` está sempre definido.

Para outras falhas de build no mesmo stack, veja os textos sobre [por que o MSB3027 reporta que não conseguiu copiar um arquivo após dez tentativas](/pt-br/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/), [o que checar quando um build do Gradle não produz um .apk no MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/), [como resolver um erro de tipo ou namespace depois de adicionar uma referência de projeto](/pt-br/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/), e [o checklist completo de migração do Xamarin.Forms para o .NET MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Fontes

- [Código de diagnóstico MSB4057](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057), documentação do MSBuild
- `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` e `Microsoft.Common.CrossTargeting.targets`, .NET SDK 10.0.201
- [ikvmnet/ikvm-maven#76](https://github.com/ikvmnet/ikvm-maven/issues/76), MSB4057 vindo do arquivo `.targets` de um pacote em um projeto que não é no estilo SDK
- [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043), a variante `GetTargetPath` em um head do MAUI
- [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), a regressão do `dotnet-ef` 10
