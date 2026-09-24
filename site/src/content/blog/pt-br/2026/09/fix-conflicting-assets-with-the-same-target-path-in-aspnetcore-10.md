---
title: "Correção: Conflicting assets with the same target path após atualizar para o SDK do .NET 10"
description: "No SDK do .NET 10, todo projeto Microsoft.NET.Sdk.Web recebe StaticWebAssetBasePath=/, então um web app que referencia outro web app entra em conflito. Defina o base path no projeto referenciado. Desabilitar a compressão não ajuda."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "aspnet-core"
  - "blazor"
  - "dotnet-10"
  - "msbuild"
  - "static-web-assets"
lang: "pt-br"
translationOf: "2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10"
translatedBy: "claude"
translationDate: 2026-09-24
---

Adicione `<StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>` ao projeto **referenciado**, aquele cujo `wwwroot` aparecia antes em `/_content/...`. Desde o SDK do .NET 10, todo projeto `Microsoft.NET.Sdk.Web` recebe o base path `/`, então quando um web app referencia outro, os dois publicam `css/site.css` na mesma URL e o pipeline de static web assets se recusa a compilar. Desligar a compressão não muda nada, porque a verificação roda antes da compressão. Tudo abaixo foi medido no SDK 10.0.302 e no SDK 9.0.318 no macOS.

## O erro em contexto

A mensagem completa é longa, porque despeja os dois registros de asset. Reduzida às partes que você precisa ler:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'css/site#[.{fingerprint}]?.css'. For assets
'Identity: .../Common/wwwroot/css/site.css, SourceType: Project, SourceId: Common, ContentRoot: .../Common/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' and
'Identity: .../Main/wwwroot/css/site.css, SourceType: Discovered, SourceId: Main, ContentRoot: .../Main/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' from different projects.
```

Três campos dizem em qual caso você está:

- **`SourceId`** nomeia os dois projetos que produzem o asset. Dois ids diferentes significam uma colisão entre projetos.
- **`SourceType`** é `Discovered` para o projeto sendo compilado, `Project` para uma referência de projeto e `Package` para um pacote NuGet.
- **`BasePath`** é o prefixo da URL. Se o projeto referenciado mostra `BasePath: /` em vez de `_content/<Name>`, você está diante da mudança do .NET 10 descrita abaixo.

O target path às vezes termina em `.gz` ou `.br`, e é por isso que esse erro costuma ser atribuído à compressão em tempo de build que chegou com o .NET 9. No SDK atual, essa raramente é a causa real.

## Por que isso acontece no SDK do .NET 10

Os static web assets decidem em tempo de build qual arquivo responde a qual URL, e o manifesto só consegue mapear um arquivo para uma rota. Antes do .NET 10, um projeto web *referenciado* por outro projeto web se comportava como uma biblioteca de classes: o SDK definia por padrão o `StaticWebAssetBasePath` dele como `_content/$(PackageId)`, então o `wwwroot/css/site.css` dele virava `/_content/Common/css/site.css` dentro do host, e nada colidia.

O SDK do .NET 10 alterou o `Sdk.Server.props`, o arquivo de props que todo projeto `Microsoft.NET.Sdk.Web` importa, para definir isto incondicionalmente:

```xml
<!-- SDK 10.0.302: Sdks/Microsoft.NET.Sdk.Web/Targets/Sdk.Server.props -->
<PropertyGroup>
  <DebugSymbols Condition="'$(DebugSymbols)' == ''">true</DebugSymbols>
  <StaticWebAssetProjectMode>Root</StaticWebAssetProjectMode>
  <StaticWebAssetBasePath>/</StaticWebAssetBasePath>
</PropertyGroup>
```

O mesmo arquivo no SDK 9.0.318 não define nenhuma das duas propriedades. O padrão `_content/$(PackageId)` em `Microsoft.NET.Sdk.StaticWebAssets.targets` só se aplica quando `StaticWebAssetBasePath` está vazio, e no SDK 10 ele nunca está vazio em um projeto web. Os dois web apps agora reivindicam `/`, e todo arquivo que existe no mesmo caminho relativo nas duas pastas `wwwroot` é um conflito.

A posição da equipe do ASP.NET Core, em [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138), é que um web app referenciando outro web app nunca foi um formato suportado: "Only class libraries or Blazor apps can be referenced by webapps in a supported capacity." A issue foi fechada sem mudança de código e, até hoje, a alteração não aparece nem na [página de breaking changes do .NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10) nem na [página de breaking changes do ASP.NET Core 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/overview). É por isso que tantas atualizações esbarram nisso sem aviso.

Quem decide isso é o **SDK**, não o seu target framework. Um projeto `net8.0` ou `net9.0` falha da mesma forma no momento em que é compilado no SDK 10.x, que foi exatamente o que [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726) relatou para um app `netcoreapp8.0`.

## Reprodução mínima

Dois web apps vazios, cada um com seu próprio `wwwroot/css/site.css`, um referenciando o outro:

```bash
# SDK 10.0.302
dotnet new web -o Main -n Main
dotnet new web -o Common -n Common
mkdir -p Main/wwwroot/css Common/wwwroot/css
echo "body{color:red}/*Main*/"   > Main/wwwroot/css/site.css
echo "body{color:red}/*Common*/" > Common/wwwroot/css/site.css
dotnet add Main/Main.csproj reference Common/Common.csproj
dotnet build Main
```

Resultados medidos para exatamente este par de projetos:

| SDK | TargetFramework | Resultado |
| --- | --- | --- |
| 9.0.318 | net9.0 | Build bem-sucedido. Rotas: `css/site.css`, `_content/Common/css/site.css` |
| 10.0.302 | net9.0 | `Conflicting assets with the same target path 'css/site#[.{fingerprint}]?.css'` |
| 10.0.302 | net10.0 | Mesmo erro |
| 10.0.302 | net10.0, `-p:DisableBuildCompression=true` | Mesmo erro |
| 10.0.302 | net10.0, `-p:CompressionEnabled=false` | Mesmo erro |
| 10.0.302 | net10.0, após `rm -rf */bin */obj` | Mesmo erro |

As três últimas linhas são as que vale lembrar. O conselho que aparece primeiro nos resultados de busca para esse erro é desabilitar a compressão ou apagar `bin` e `obj`. Nenhum dos dois muda nada para essa causa. O conflito é gerado por `GenerateStaticWebAssetsManifest` na linha 640 do arquivo de targets, que roda com a compressão habilitada ou não.

## Correção: devolva ao projeto referenciado o base path antigo

Coloque a propriedade no csproj do projeto que está sendo referenciado (`Common` aqui), não no host:

```xml
<!-- Common.csproj, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>
  </PropertyGroup>

</Project>
```

Definir a propriedade no arquivo de projeto funciona porque o SDK define `/` em um arquivo de props, que é avaliado antes do corpo do seu projeto, então o seu valor prevalece. Depois da mudança, `dotnet build Main` é bem-sucedido e `Main.staticwebassets.endpoints.json` contém os dois conjuntos de rotas:

```text
_content/Common/css/site.css
_content/Common/css/site.css.gz
css/site.css
css/site.css.gz
(plus the fingerprinted variants of each)
```

Executei o host com `app.MapStaticAssets()` e requisitei as duas URLs. `/css/site.css` retornou o arquivo de `Main` e `/_content/Common/css/site.css` retornou o arquivo de `Common`, cada um com `Content-Encoding: gzip` quando a requisição permitia. Ou seja, as variantes comprimidas são geradas por projeto exatamente como antes.

O base path só se aplica aos consumidores. Executei `Common` sozinho depois da mudança e `/css/site.css` continuou retornando 200, enquanto `/_content/Common/css/site.css` retornou 404. Um projeto que é ao mesmo tempo um app independente e uma referência continua funcionando nos dois papéis.

### Não use `$(PackageId)` aqui

A forma óbvia de recriar o padrão antigo é `_content/$(PackageId)`, já que é isso que o SDK calculava. Isso não funciona a partir do csproj. `PackageId` é atribuído depois, nos targets do NuGet, então no momento em que o seu `PropertyGroup` é avaliado ele ainda está vazio. Eu testei: o build foi bem-sucedido, mas as rotas viraram `_content/css/site.css`. Isso quebra silenciosamente todo `<link href="_content/Common/...">` nas suas views enquanto parece uma correção. Use `$(MSBuildProjectName)`, ou escreva o nome literalmente se o seu `AssemblyName` for diferente do nome do arquivo de projeto e o seu markup usar o nome do assembly.

### Melhor: pare de referenciar um web app

Se `Common` existe só para compartilhar views Razor, componentes e arquivos de `wwwroot`, transforme-o em uma Razor class library (`Microsoft.NET.Sdk.Razor`). Esse é o formato suportado, ele recebe `_content/{PackageId}` por padrão e é assim que a [documentação de arquivos estáticos do Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) descreve o compartilhamento de assets. Mantenha a propriedade de base path para os casos em que o projeto referenciado realmente também precisa rodar como app, como um host de testes de integração baseado em `Microsoft.NET.Sdk.Web` que referencia o app real.

## O mesmo arquivo em dois projetos de um Blazor Web App

O segundo gatilho comum não tem nada a ver com referências entre web apps. Em um Blazor Web App com WebAssembly interativo, o projeto do servidor e o projeto `.Client` contribuem ambos para `/`. Isso é intencional: os assets do cliente são servidos a partir da raiz do host.

Então um arquivo que existe nas duas pastas `wwwroot` colide. Reproduzi isso com o template `dotnet new blazor -int WebAssembly` no SDK 10.0.302 copiando `favicon.png` para `W.Client/wwwroot`:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'favicon#[.{fingerprint}]?.png'. For assets 'Identity: .../W.Client/wwwroot/favicon.png, SourceType: Project, ...
```

Aqui a correção não é um base path. Você não quer os arquivos do cliente movidos para `_content/`. Mantenha cada arquivo em exatamente um dos dois projetos. Uma regra útil: assets necessários apenas para o markup renderizado no servidor ficam no projeto do servidor; assets que o código WebAssembly carrega em tempo de execução ficam em `.Client`. Se você migrou do antigo template hospedado do Blazor WebAssembly, em que o projeto do cliente era dono de `index.html`, `favicon` e do CSS, esta é a sobra habitual. A [comparação dos modelos de hospedagem do Blazor](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) explica por que os dois projetos compartilham uma raiz.

## Quando a compressão realmente é a causa

A compressão em tempo de build chegou no .NET 9 e, durante as previews do .NET 9, ela de fato causava esse erro. Pacotes como `Z.Blazor.Diagrams` 3.0.2 e algumas configurações de bundler distribuíam seus próprios arquivos `.gz` em `wwwroot`. O SDK então tentava gerar `app.js.gz` para o mesmo asset e colidia com o que já estava lá ([dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512), [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413)).

Isso foi corrigido por [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518), fechada em novembro de 2024. O SDK atual executa uma task `DiscoverPrecompressedAssets` que reconhece um irmão `.gz` ou `.br` existente e o trata como a variante comprimida em vez de produzir a sua própria. Verifiquei os dois casos no SDK 10.0.302:

- Um web app com `wwwroot/js/app.js`, `app.js.gz` e `app.js.br` versionados: build e publish são bem-sucedidos com zero avisos. O manifesto de endpoints mapeia `js/app.js` para `js/app.js.gz` com um seletor `gzip`, e o `app.js.gz` publicado é idêntico byte a byte ao arquivo que eu criei. O seu arquivo é servido, não um regenerado.
- Um web app referenciando `Z.Blazor.Diagrams` 3.0.2, o pacote da #57512: compila sem problemas.

Então, se você está em uma preview do SDK 9.0.1xx, atualize o SDK. Se ainda precisar excluir arquivos específicos da compressão, por exemplo porque um bundler já grava o próprio `.br` com configurações melhores, use a lista de exclusão em vez de desligar o recurso. Verifiquei isto no SDK 10.0.302: após o publish, `app.bundle.js` não tinha irmão `.gz` nem `.br`, enquanto `other.js` na mesma pasta tinha os dois.

```xml
<!-- Host .csproj, SDK 9.0.100 and later -->
<PropertyGroup>
  <CompressionExcludePatterns>$(CompressionExcludePatterns);**/*.bundle.js</CompressionExcludePatterns>
</PropertyGroup>
```

`DisableBuildCompression=true` pula a compressão apenas no `dotnet build` (o publish continua comprimindo), e `CompressionEnabled=false` remove os targets de compressão por completo. Os dois são razoáveis para velocidade de build. Nenhum deles corrige uma colisão de base path, como a tabela acima mostra. A compressão de respostas em tempo de execução é ainda outro recurso; veja [como adicionar compressão de respostas a uma API ASP.NET Core](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) para esse lado.

## Armadilhas e erros parecidos

**"Two assets found targeting the same path with incompatible asset kinds" é um erro diferente.** Você o recebe dentro de um *único* projeto, por exemplo quando um item `<Content Include="shared/app.js" Link="wwwroot/js/app.js" />` aponta para a mesma rota que um `wwwroot/js/app.js` real. Reproduzi isso no SDK 10.0.302 a partir da linha 706 do mesmo arquivo de targets. Remova um dos dois itens.

**`The "DiscoverPrecompressedAssets" task failed unexpectedly` com `An item with the same key has already been added`** é um bug relacionado do .NET 10, também disparado por um projeto web referenciando outro, muitas vezes com a chave apontando para `blazor.web.js` em `microsoft.aspnetcore.app.internal.assets`. Ele continua aberto como [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089). A correção de base path acima é a primeira coisa a tentar, porque remove o registro duplicado na origem. Se você também está atrás de um script do Blazor ausente depois da atualização, esse pacote é explicado no [post sobre o 404 do blazor.server.js](/pt-br/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).

**Se o erro vai e volta entre builds**, suspeite de uma etapa de build que grava em `wwwroot` (TypeScript, LibMan, um bundler JS) enquanto os targets de static web assets estão lendo a pasta. [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014) documenta uma condição de corrida que aparece como este erro, `No file exists for the asset` ou `The asset ... can not be found`. Ela também se reproduz com um único target framework. A correção confiável é executar o gerador como uma etapa própria antes do MSBuild (`npm run build && dotnet build` no CI e no seu launch profile) em vez de a partir de um target `BeforeTargets="Build"`, para que os arquivos já estejam em disco quando o SDK avaliar o glob de `wwwroot`. Um binlog (`dotnet build -bl`) mostra a ordem; o [servidor MCP de binlog](/pt-br/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) é uma forma rápida de consultá-lo.

**Fixar o SDK 9 com `global.json` funciona, mas só como paliativo.** A reprodução compila normalmente no 9.0.318 mesmo com o SDK do .NET 10 instalado lado a lado. Isso também significa que você não consegue compilar projetos `net10.0`, e deixa a colisão real para depois. O [dotnetup](/pt-br/2026/06/dotnetup-official-dotnet-sdk-version-manager/) torna barato trocar de SDK se você precisar descobrir qual SDK introduziu uma falha no seu repositório.

**O antigo target "remova todo StaticWebAsset `.gz`" está obsoleto.** O workaround da #57512 que apaga itens `StaticWebAsset` com extensão `.gz` antes de `ResolveStaticWebAssetsConfiguration` era para as previews do .NET 9. No SDK 10 ele descarta arquivos pré-comprimidos que o SDK agora trata corretamente, e não faz nada para o caso do base path.

## Relacionados

- [Correção: 404 Not Found para blazor.server.js após instalar um novo SDK do .NET](/pt-br/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/), outra mudança de static web assets que chega com o SDK e não com o target framework.
- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/), para entender por que o projeto do servidor e o `.Client` compartilham `/`.
- [Como adicionar compressão de respostas a uma API ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), a contraparte em tempo de execução da compressão de assets em tempo de build.
- [Um servidor MCP para binlogs do .NET](/pt-br/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/), para rastrear qual target produziu um asset conflitante.
- [dotnetup, o gerenciador oficial de versões do SDK do .NET](/pt-br/2026/06/dotnetup-official-dotnet-sdk-version-manager/), para testar um repositório com vários SDKs.

## Fontes

- [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138): regressão no SDK 10 preview 5, o workaround com `StaticWebAssetBasePath` e a resolução "não suportado".
- [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726): o mesmo erro em um app `netcoreapp8.0` após instalar o novo SDK.
- [dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512) e [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518): assets de pacote pré-comprimidos no .NET 9 e a correção.
- [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413): configurações de compressão (`DisableBuildCompression`, `BuildCompressionFormats`, `CompressionExcludePatterns`).
- [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) e [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014): bugs abertos de static web assets no .NET 10 com sintomas sobrepostos.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) no Microsoft Learn.
- Fontes do SDK inspecionadas localmente: `Sdk.Server.props`, `Microsoft.NET.Sdk.StaticWebAssets.targets` e `Microsoft.NET.Sdk.StaticWebAssets.Compression.targets` dos SDKs 10.0.302 e 9.0.318.
