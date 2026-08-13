---
title: "Correção: 404 Not Found para blazor.server.js depois de instalar um novo SDK do .NET"
description: "blazor.server.js retorna 404 no .NET 10 porque o script deixou de ser um recurso embutido. Adicione RequiresAspNetWebAssets ao projeto host, ou garanta que ele tenha um arquivo .razor."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "dotnet-11"
  - "static-web-assets"
lang: "pt-br"
translationOf: "2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk"
translatedBy: "claude"
translationDate: 2026-08-13
---

Adicione `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>` ao projeto host e execute o restore. No .NET 10 o script do Blazor deixou de ser um recurso embutido em `Microsoft.AspNetCore.Components.Server` e passou a ser um arquivo do pacote NuGet `Microsoft.AspNetCore.App.Internal.Assets`, que o SDK só traz quando o projeto contém pelo menos um arquivo `.razor`. Sem arquivo `.razor` no host, não há script: 404. Tudo abaixo foi medido com o SDK 10.0.201 e ASP.NET Core 10.0.5 no Windows 11.

## O erro em contexto

O console do navegador, a partir de um `_Host.cshtml` que funcionava sem alterações desde o .NET 6:

```
GET https://localhost:5001/_framework/blazor.server.js net::ERR_ABORTED 404 (Not Found)
Uncaught ReferenceError: Blazor is not defined
```

A página renderiza seu HTML pré-renderizado e depois não faz nada. Nenhum circuito abre, nenhum botão funciona e o log do servidor fica em silêncio porque um 404 do middleware de arquivos estáticos não é uma exceção. A mesma coisa acontece com `_framework/blazor.web.js` em um Blazor Web App.

A parte confusa é o gatilho. O arquivo de projeto não mudou. Muitas vezes o target framework também não mudou. Alguém instalou o SDK do .NET 10, e uma aplicação que compilava e rodava ontem agora devolve 404 para um único arquivo.

## Por que o script sumiu

Até o .NET 9, `blazor.server.js` era um recurso embutido dentro do assembly do framework compartilhado, e `MapBlazorHub()` registrava um endpoint dedicado que o lia daquele assembly. Esse endpoint não tinha como falhar em achar o arquivo, porque o arquivo estava dentro da DLL que registrava o endpoint.

O .NET 10 removeu isso. Javier Calvarro Nelson, do time do ASP.NET Core, [explicou sem rodeios](https://github.com/dotnet/aspnetcore/issues/64381#issuecomment-3546832403) quando isso foi relatado pela primeira vez:

"In 10.0, we stopped embedding the `server.js` and the `.web.js` files inside their respective assemblies so that we can compress and fingerprint them like any other files."

É um ganho real. Agora o script recebe compressão Gzip em tempo de build, Brotli na publicação, um hash de conteúdo na URL e um `Cache-Control` imutável de um ano. Mas isso muda de onde o arquivo vem. Ele agora é um recurso web estático, entregue por um pacote NuGet que o SDK adiciona ao seu grafo de restore por trás dos panos. Na minha máquina:

```
C:\Users\mariu\.nuget\packages\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
  blazor.server.js
  blazor.server.js.map
  blazor.web.js
  blazor.web.js.map
  blazor.webassembly.js
  blazor.webassembly.js.map
```

A versão é fixada pelo SDK, não pelo seu projeto. Quem decide é o `Microsoft.NETCoreSdk.BundledVersions.props` da instalação do SDK:

```xml
<!-- C:\Program Files\dotnet\sdk\10.0.201\Microsoft.NETCoreSdk.BundledVersions.props -->
<KnownAspNetCorePack Include="Microsoft.AspNetCore.App.Internal.Assets"
                     TargetFramework="net10.0"
                     AspNetCorePackVersion="10.0.5" />
```

E aqui está a parte que realmente causa o 404. O SDK não adiciona esse pacote a todo projeto web, porque a maioria dos projetos web não é uma aplicação Blazor e ninguém quer um script do Blazor baixado em uma minimal API. Ele adivinha, com uma única heurística:

```xml
<!-- Sdks\Microsoft.NET.Sdk.Web.ProjectSystem\targets\Microsoft.NET.Sdk.Web.ProjectSystem.targets -->
<Target Name="ResolveRequiredWebAssets" BeforeTargets="ProcessFrameworkReferences">
  <PropertyGroup>
    <RequiresAspNetWebAssets
      Condition="'$(RequiresAspNetWebAssets)' == '' and @(Content->AnyHaveMetadataValue(Extension, .razor))">true</RequiresAspNetWebAssets>
  </PropertyGroup>
</Target>
```

Se o projeto host tiver um arquivo `.razor` nos seus itens `Content`, o pacote entra. Caso contrário, `RequiresAspNetWebAssets` volta ao padrão `false`, o pacote nunca é restaurado, e `_framework/blazor.server.js` simplesmente não está no manifesto de recursos web estáticos da aplicação. Não há nenhum aviso em tempo de build. O build tem sucesso.

Muitas aplicações Blazor Server reais não têm nenhum arquivo `.razor` no projeto host. Se seus componentes moram em uma Razor Class Library e o host é só `Program.cs`, `_Host.cshtml` e uma referência de projeto, a heurística diz "não é uma aplicação Blazor" e você recebe 404.

## Reprodução mínima

Um host ASP.NET Core que serve componentes Blazor Server a partir de uma RCL. Nada exótico:

```xml
<!-- BzSrv.csproj, .NET 10, SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\BzLib\BzLib.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs, .NET 10, ASP.NET Core 10.0.5
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

var app = builder.Build();
app.UseStaticFiles();
app.MapBlazorHub();
app.MapFallbackToPage("/_Host");
app.Run();
```

```html
<!-- Pages/_Host.cshtml -->
<component type="typeof(App)" render-mode="ServerPrerendered" />
<script src="_framework/blazor.server.js"></script>
```

Compile e veja o que o restore decidiu:

```bash
dotnet build
grep -o "Microsoft.AspNetCore.App.Internal.Assets/[0-9.]*" obj/project.assets.json
# (no output)
grep -c "blazor.server.js" bin/Debug/net10.0/BzSrv.staticwebassets.runtime.json
# 0
```

O pacote está ausente do grafo de restore e o script está ausente do manifesto. Requisitá-lo retorna HTTP 404 com corpo de zero bytes. Mova um único arquivo `.razor` para o projeto host, ou defina a propriedade abaixo, e as duas contagens deixam de ser zero.

## A correção

**Defina a propriedade no projeto host.** Essa é a saída suportada e a que o time do ASP.NET Core indica. Ela vai no projeto que usa `Microsoft.NET.Sdk.Web`, o que de fato atende às requisições, não na RCL:

```xml
<!-- BzSrv.csproj, .NET 10 / .NET 11 -->
<PropertyGroup>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

Depois execute o restore, porque o pacote entra no grafo durante o restore, não durante o build:

```bash
dotnet restore
```

`dotnet build` executa um restore implícito, então uma recompilação simples geralmente resolve. Um passo de CI rodando `dotnet build --no-restore` contra um restore feito antes de a propriedade ser adicionada, não. Depois da mudança, as duas verificações voltam positivas e o arquivo é servido com 164.838 bytes.

**Ou adicione um arquivo `.razor` ao host.** Mover `App.razor` (ou qualquer componente) de volta para o projeto host satisfaz a heurística sem nenhuma propriedade do MSBuild. Tudo bem se você fosse ter um de qualquer forma, mas é uma razão estranha para mover código, e a propriedade expressa melhor a intenção.

**Não recorra a `MapStaticAssets()`.** Esse é o conselho ruim mais comum sobre esse erro, e vale ser específico porque ele custa horas. Migrar um pipeline que funciona para `MapStaticAssets()` não conserta um pacote ausente, e `UseStaticFiles()` nunca foi o problema. O time [fechou um PR da comunidade](https://github.com/dotnet/aspnetcore/pull/66060#issuecomment-5068880296) que se baseava nesse diagnóstico:

"`blazor.web.js` and `blazor.server.js` are shipped as static web assets, and `app.UseStaticFiles()` already serves them without `MapStaticAssets()` (this is what our own server-side Blazor E2E tests exercise, using `UseStaticFiles()` and `MapBlazorHub()` with no `MapStaticAssets()` call)."

Isso bate com o que eu medi. Com o pacote presente, `UseStaticFiles()` e `MapBlazorHub()` servem o script em Development e a partir da saída publicada, sem `MapStaticAssets()` em lugar nenhum.

## O que cada configuração realmente retorna

Nove execuções contra a mesma reprodução, cada uma uma requisição HTTP para `/_framework/blazor.server.js` em um processo Kestrel real:

| Projeto host | Pipeline | Ambiente | Executando a partir de | Resultado |
| --- | --- | --- | --- | --- |
| com `.razor` | `UseStaticFiles()` | Development | `dotnet run` | 200, 164838 bytes |
| com `.razor` | `UseStaticFiles()` | Development | saída de build | 200 |
| com `.razor` | `UseStaticFiles()` | Production | saída de build | **404** |
| com `.razor` | `UseStaticFiles()` | Production | saída publicada | 200 |
| com `.razor` | `MapStaticAssets()` | Development | saída de build | 200 |
| com `.razor` | `MapStaticAssets()` | Production | saída de build | **500** |
| sem `.razor` | `UseStaticFiles()` | Development | saída de build | **404** |
| sem `.razor`, propriedade definida | `UseStaticFiles()` | Development | saída de build | 200 |
| `EnableDefaultContentItems=false` | qualquer | qualquer | qualquer | pacote nunca restaurado |

Duas linhas merecem explicação própria.

**Production contra a saída de build retorna 404 mesmo com o projeto configurado corretamente.** `WebApplication.CreateBuilder` só chama `UseStaticWebAssets()` no ambiente Development. Em Development, o manifesto de recursos web estáticos mapeia `_framework/` direto para a pasta de cache do NuGet mostrada antes. Em qualquer outro ambiente esse mapeamento não é aplicado, e a saída de build não tem um `wwwroot/_framework/` próprio, então não há nada para servir. A saída publicada funciona porque `dotnet publish` copia os arquivos reais (mais as variantes `.gz` e `.br`) para `wwwroot/_framework/`. Isso pega testes de fumaça em CI e imagens de contêiner que executam a saída de `dotnet build` com `ASPNETCORE_ENVIRONMENT=Staging`. Não é novidade do .NET 10, mas antes do .NET 10 o endpoint de recurso embutido escondia isso para esse arquivo específico.

**A mesma configuração sob `MapStaticAssets()` retorna 500, não 404**, o que é um diagnóstico útil. O endpoint é registrado a partir de `BzSrv.staticwebassets.endpoints.json`, que é copiado para o diretório de saída e lido independentemente do ambiente, então o roteamento casa. O provedor de arquivos então não consegue produzir os bytes:

```
System.IO.FileNotFoundException: Could not find file '...\BzSrv\wwwroot\_framework\blazor.server.js'.
   at System.IO.FileInfo.get_Length()
   at Microsoft.AspNetCore.Builder.StaticAssetDevelopmentRuntimeHandler...
```

Um 500 com esse stack trace significa que o manifesto conhece o script e o provedor de arquivos não consegue alcançá-lo, então o pacote está certo e seu ambiente ou diretório de saída está errado. Um 404 seco significa que o manifesto nunca o teve, então o pacote está faltando e `RequiresAspNetWebAssets` é a sua correção.

## Pegadinhas e casos parecidos

**`EnableDefaultContentItems=false` desliga a heurística silenciosamente.** A condição do MSBuild testa itens `Content`, não arquivos em disco. Um projeto host com `App.razor` bem ao lado de `Program.cs` ainda deixa de restaurar o pacote se os globs de conteúdo padrão estiverem desligados. Verificado: mesmo projeto, mesmo arquivo, pacote ausente. Defina a propriedade explicitamente em qualquer projeto que customize itens de conteúdo.

**Um projeto `Microsoft.NET.Sdk.Razor` nunca detecta sozinho.** O target `ResolveRequiredWebAssets` é distribuído apenas em `Microsoft.NET.Sdk.Web.ProjectSystem.targets`. Se seu host usa o SDK do Razor, ou define `<OutputType>Library</OutputType>`, nada define `RequiresAspNetWebAssets` por você, não importa quantos componentes ele contenha. É o formato relatado em [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545). Defina a propriedade na mão.

**`packages.lock.json` transforma a correção em falha de build.** Adicionar a propriedade muda o grafo de restore, então um restore travado a recusa com uma mensagem exata que vale reconhecer:

```
error NU1004: The package references have changed for net10.0. Lock file's package references: None,
project's package references: Microsoft.AspNetCore.App.Internal.Assets >= 10.0.5. The packages lock
file is inconsistent with the project dependencies so restore can't be run in locked mode.
```

Regenere o arquivo de lock uma vez e faça o commit:

```bash
dotnet restore --force-evaluate
```

**O restore precisa conseguir alcançar o pacote.** É um pacote real do nuget.org, não algo empacotado na instalação do SDK. Builds sem rede e feeds privados sem espelho do upstream não vão achá-lo, e a versão do SDK, não o seu target framework, decide qual versão é solicitada. Instale um novo patch do SDK e seu feed offline vai precisar de uma nova versão correspondente de `Microsoft.AspNetCore.App.Internal.Assets`.

**Se a pasta do pacote sumir, a aplicação não dá 404: ela não inicia.** Limpar o cache do NuGet enquanto sobra saída de build obsoleta produz isto na inicialização, antes de o Kestrel fazer o bind:

```
Unhandled exception. System.IO.DirectoryNotFoundException: ...\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
   at Microsoft.AspNetCore.Hosting.StaticWebAssets.StaticWebAssetsLoader.UseStaticWebAssetsCore(...)
   at Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(String[] args)
```

O manifesto em `bin` guarda um caminho absoluto para o cache de pacotes. Apague `bin` e `obj`, e recompile.

**Uma aplicação .NET 9 pode cair nisso sem ter sido atualizada.** [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353) é uma aplicação Blazor `net9.0` que começou a dar 404 assim que o SDK do .NET 10 foi instalado. A causa foi `DOTNET_ROLL_FORWARD=LatestMajor` no ambiente: a aplicação estava fazendo roll forward para o runtime 10.0, onde o script não é mais embutido, enquanto ainda compilava como projeto .NET 9 que nunca restaura o pacote. Verifique `dotnet --info` procurando essa variável antes de mexer no arquivo de projeto. Rode no runtime 9.0 e o recurso embutido continua lá e tudo funciona, com SDK do .NET 10 ou sem.

**A documentação subestima o alcance.** O [artigo sobre a estrutura de projeto do Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) diz que o arquivo `.razor` é necessário "in order to automatically include the Blazor script when the app is published". Isso afeta o `dotnet build` também: a reprodução acima dá 404 sob `dotnet run` em Development, muito antes de alguém publicar qualquer coisa.

**Isso não mudou no .NET 11.** O modelo de entrega de recursos estáticos e a propriedade `RequiresAspNetWebAssets` seguem valendo, e a página de documentação acima se aplica igualmente aos monikers `aspnetcore-10.0` e `aspnetcore-11.0`. Atualizar para além do 10 não remove a exigência.

## Relacionado

Se você está no meio de uma atualização e isso é uma de várias coisas que quebraram de uma vez, os itens de Blazor estão reunidos no [checklist do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), e o lado de render modes da mesma mudança está em [migrar uma aplicação Blazor Server para o Blazor United](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/). Depois que o script carrega e um circuito realmente abre, as duas falhas seguintes que as pessoas encontram são [o banner de reconexão depois que um circuito desconecta](/pt-br/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/) e [chamadas de interoperabilidade com JavaScript que não podem ser emitidas durante a pré-renderização](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). Se você está decidindo se o host deve continuar hospedando componentes, [Blazor Server vs WebAssembly vs United](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cobre o trade-off.

## Fontes

- [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0), pela propriedade `RequiresAspNetWebAssets` e pela regra do pelo-menos-um-arquivo-`.razor`.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0), por `MapStaticAssets` versus `UseStaticFiles` e o que cada um consegue e não consegue servir.
- [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381), o relato original, com a explicação do time sobre por que os scripts deixaram de ser recursos embutidos.
- [dotnet/aspnetcore#66175](https://github.com/dotnet/aspnetcore/issues/66175), o mesmo 404 no SDK 10.0.201 depois de atualizar uma aplicação Blazor Server, fechado ao adicionar a propriedade.
- [dotnet/aspnetcore#66059](https://github.com/dotnet/aspnetcore/issues/66059) e [o PR que ele propôs](https://github.com/dotnet/aspnetcore/pull/66060), por que readicionar os antigos endpoints de recurso embutido foi recusado e a confirmação de que `UseStaticFiles()` serve esses arquivos hoje.
- [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353), pela variante de roll forward que quebra aplicações `net9.0` depois de instalar o SDK.
- [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545), pela variante de `OutputType` / SDK não-Web.
