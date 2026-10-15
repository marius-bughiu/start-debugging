---
title: "Migre um app Blazor com componentes roteáveis em outro assembly do .NET 8 para o .NET 10"
description: "Atualizando um Blazor Web App cujas páginas ficam em uma Razor class library ou em um projeto .Client do .NET 8 para o .NET 10: o que continua igual (os dois registros de AdditionalAssemblies) e as quatro coisas que quebram, de um 404 em blazor.web.js em hosts enxutos a páginas NotFoundPage que renderizam em branco. Medido no ASP.NET Core 8.0.32 e 10.0.10."
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet-10"
  - "dotnet-8"
  - "aspnet-core"
  - "razor-class-library"
lang: "pt-br"
translationOf: "2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-15
---

Se o seu Blazor Web App do .NET 8 renderiza páginas que ficam em outro assembly (uma Razor class library, um projeto `.Client`, um módulo de funcionalidade), o contrato de roteamento não muda no .NET 10: o lado do endpoint ainda precisa de `MapRazorComponents<App>().AddAdditionalAssemblies(...)` e o `Router` interativo ainda precisa do parâmetro `AdditionalAssemblies`. Executei a mesma matriz de sete casos de registro no ASP.NET Core 8.0.32 e no 10.0.10, e todos os casos deram o mesmo resultado. O que quebra está ao redor: um host sem arquivos `.razor` próprios deixa de servir `blazor.web.js`, uma `NotFoundPage` que fica na biblioteca renderiza um 404 vazio a menos que a biblioteca esteja registrada no lado do endpoint, o antigo fragmento `<NotFound>` está obsoleto, e o erro "Assembly already defined" sai da sua linha do `Program.cs` e vai para a inicialização do app. Para uma solução típica com uma ou duas bibliotecas de páginas, a atualização leva menos de uma hora. Tudo abaixo foi compilado com o SDK 10.0.302 e `Microsoft.AspNetCore.Components.Web` 10.0.13.

## Por que sair do .NET 8 agora

- **O suporte ao .NET 8 termina em 10 de novembro de 2026.** O .NET 10 é o LTS atual e tem suporte até novembro de 2028. Depois dessa data, apps .NET 8 deixam de receber patches de segurança.
- **`NotFoundPage` funciona entre assemblies.** O .NET 10 pode renderizar uma página roteável de "não encontrado" a partir da sua biblioteca compartilhada para URLs desconhecidas, chamadas a `NavigationManager.NotFound()` e reexecução de código de status, em vez de um fragmento inline duplicado em cada host.
- **Os ativos estáticos são fingerprinted e comprimidos.** `MapStaticAssets` (adicionado no .NET 9) serve os arquivos `_content/...` da biblioteca e o script do Blazor com compressão em tempo de build e ETags, o que ajuda bibliotecas de páginas que distribuem seu próprio CSS e JS.

## O que muda entre o .NET 8 e o .NET 10

| Área | Mudança | Gravidade |
| --- | --- | --- |
| Host sem arquivos `.razor` | `blazor.web.js` é um ativo web estático no .NET 10 e só é emitido quando o projeto contém um componente. Hosts enxutos recebem um 404. | alta |
| `NotFoundPage` em uma biblioteca | A página precisa ter `@page`, e o assembly dela precisa ser passado para `AddAdditionalAssemblies`, senão a resposta 404 fica vazia | média |
| Fragmento `<NotFound>` | `[Obsolete]`, e lança exceção se combinado com `NotFoundPage` | média |
| Referência de pacote da RCL | `Microsoft.AspNetCore.Components.Web` 8.0.x precisa subir para 10.0.x | baixa |
| Registro duplicado de assembly | "Assembly already defined" é lançado durante a inicialização, não na chamada a `AddAdditionalAssemblies` | baixa |
| Nomes de membros em componentes da biblioteca | `ComponentBase` ganhou `RendererInfo` e `AssignedRenderMode` no .NET 9; um membro de componente com o mesmo nome agora o oculta (CS0108) | baixa |
| `UseStaticFiles` | Ainda funciona após o publish, mas o guia de migração o substitui por `MapStaticAssets` | baixa |

## Os dois registros e o que cada um controla

Esta é a parte que a maioria das migrações erra, geralmente porque o app Blazor Server do .NET 7 só precisava de um deles. Um Blazor Web App tem dois roteadores. O roteamento de endpoints do ASP.NET Core trata a primeira requisição HTTP (e toda requisição de navegação aprimorada) e precisa saber quais assemblies contêm componentes `@page`. O componente `Router` do Blazor trata a navegação quando já está rodando de forma interativa, e monta sua própria tabela de rotas a partir de `AppAssembly` mais `AdditionalAssemblies`.

Este é o cenário de teste: um host criado a partir do template `blazor` do .NET 8 com Interactive Server, e uma Razor class library `Shared.Pages` com uma página.

```razor
@* Shared.Pages/Pages/Reports.razor, .NET 8 and .NET 10 *@
@page "/reports"
@rendermode InteractiveServer

<h1>Reports (from Shared.Pages)</h1>
<p>Rendered from @GetType().Assembly.GetName().Name</p>
<button @onclick="() => count++">Clicked @count</button>

@code {
    int count;
}
```

Alternei cada registro e o modo de renderização de `<Routes />` com variáveis de ambiente, e depois requisitei `/reports` diretamente. Os resultados foram idênticos no 8.0.32 e no 10.0.10:

| `Router.AdditionalAssemblies` | `AddAdditionalAssemblies` | Modo de renderização de `<Routes>` | `GET /reports` |
| --- | --- | --- | --- |
| não definido | não definido | estático | 404 |
| definido | não definido | estático | 404 |
| não definido | definido | estático | 200 |
| definido | definido | estático | 200 |
| definido | não definido | `InteractiveServer` | 404 |
| não definido | definido | `InteractiveServer` | 200, depois "not found" quando o circuito inicia |
| definido | definido | `InteractiveServer` | 200 |

A sexta linha é a que confunde. O servidor faz o prerender da página corretamente, o navegador a exibe por um instante, e então o `Router` interativo assume, não encontra `/reports` na sua própria tabela de rotas e substitui a página pelo conteúdo de "não encontrado". Confirmei isso em um navegador nas duas versões. A quinta linha é o erro oposto: o roteador interativo conhece a página, mas a primeiríssima requisição nunca chega a ela, porque não existe endpoint.

Então a regra para as duas versões é simples: **registre todo assembly que contém componentes roteáveis nos dois lugares.** Se o componente `Routes` fica no projeto do servidor, o `AdditionalAssemblies` dele também precisa incluir o assembly `.Client`.

## Checklist prévio

1. SDK do .NET 10 instalado (`dotnet --list-sdks` mostra `10.0.1xx` ou posterior; usei o 10.0.302). Se um `global.json` fixa o 8.0, atualize-o.
2. Uma lista de todo assembly que contém componentes `@page`. `grep -rln "@page" --include=*.razor .` e agrupe os resultados por projeto.
3. Todos os lugares que os registram. `grep -rn "AdditionalAssemblies" --include=*.razor --include=*.cs .` deve mostrar um `Router` e uma cadeia `MapRazorComponents` por host. Se mostrar só um, você já tem o bug da matriz acima.
4. Uma lista das URLs que precisam continuar funcionando, incluindo uma URL de cada biblioteca e uma que deve dar 404. Você vai usar curl nelas após cada passo.

## Passos da migração

1. **Altere o framework de destino de todos os projetos e atualize o pacote da biblioteca.** Troque `<TargetFramework>net8.0</TargetFramework>` por `net10.0` no host, no projeto `.Client` e em cada Razor class library. O template de RCL referencia `Microsoft.AspNetCore.Components.Web` como pacote, então ele também precisa de uma nova versão:

   ```xml
   <!-- Shared.Pages.csproj, .NET 10 -->
   <Project Sdk="Microsoft.NET.Sdk.Razor">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <SupportedPlatform Include="browser" />
     </ItemGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.Components.Web" Version="10.0.13" />
     </ItemGroup>
   </Project>
   ```

   Se outros apps ainda consomem a biblioteca no .NET 8, faça multi-targeting com `<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` e condicione a versão do pacote a `$(TargetFramework)`. Verifique com `dotnet build` e leia os avisos: um CS0108 em um componente da biblioteca significa que ele declara um membro que agora oculta um membro de `ComponentBase` (veja as armadilhas).

2. **Coloque a lista de assemblies em um único lugar e use-a nos dois registros.** A maioria dos bugs do tipo "a página funciona ao atualizar, mas não ao clicar" vem de duas listas que divergem. Uma pequena classe estática elimina a divergência:

   ```csharp
   // Host/RoutableAssemblies.cs, .NET 10
   using System.Reflection;

   namespace Host;

   public static class RoutableAssemblies
   {
       // Do NOT include typeof(Program).Assembly: it is already the app assembly.
       public static readonly Assembly[] Additional =
       [
           typeof(Shared.Pages._Imports).Assembly,
           // typeof(Host.Client._Imports).Assembly,
       ];
   }
   ```

   ```csharp
   // Host/Program.cs, .NET 10
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   ```razor
   @* Host/Components/Routes.razor, .NET 10 *@
   <Router AppAssembly="typeof(Program).Assembly"
           AdditionalAssemblies="RoutableAssemblies.Additional"
           NotFoundPage="typeof(Shared.Pages.Pages.NotFound)">
       <Found Context="routeData">
           <RouteView RouteData="routeData" DefaultLayout="typeof(Layout.MainLayout)" />
           <FocusOnNavigate RouteData="routeData" Selector="h1" />
       </Found>
   </Router>
   ```

   Verifique com `curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/reports` retornando `200` para uma URL por biblioteca, depois abra a mesma URL em um navegador e espere o circuito (ou o runtime WebAssembly) iniciar. A página ainda precisa estar lá depois disso.

3. **Substitua `<NotFound>` por uma `NotFoundPage` roteável.** No .NET 10 o render fragment `NotFound` é marcado com `[Obsolete("NotFound is deprecated. Use NotFoundPage instead.")]`. As notas de versão vão além e dizem que ele "isn't supported in .NET 10 or later", mas no meu teste o fragmento ainda renderizava no 10.0.10 quando nenhuma `NotFoundPage` estava definida, então isso é uma descontinuação que você pode agendar, não uma interrupção. Definir os dois lança `InvalidOperationException: Setting NotFound and NotFoundPage properties simultaneously is not supported`. A página precisa de uma rota, porque o roteador valida que ela tem um atributo `[Route]`:

   ```razor
   @* Shared.Pages/Pages/NotFound.razor, .NET 10 *@
   @page "/not-found"

   <h1>Not found (from Shared.Pages)</h1>
   ```

   Depois adicione o middleware de reexecução de código de status que o template do .NET 10 usa, para que URLs desconhecidas da primeira requisição HTTP também caiam nessa página:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
   app.UseAntiforgery();
   ```

   Verifique que `GET /missing` retorna `404` com o `<h1>` da sua página no corpo, e que `GET /not-found` retorna `200`. Se o corpo do 404 estiver vazio, leia o próximo passo.

4. **Registre o assembly da página de não encontrado no lado do endpoint.** A reexecução é uma segunda requisição pelo roteamento de endpoints até `/not-found`. Se a página fica em uma biblioteca que só o `Router` conhece, não existe endpoint para ela. Medido no 10.0.10 com a página em `Shared.Pages`:

   | `AddAdditionalAssemblies(Shared.Pages)` | `GET /missing` | `GET /not-found` |
   | --- | --- | --- |
   | ausente | 404, corpo vazio | 404, corpo vazio |
   | presente | 404, "Not found (from Shared.Pages)" | 200 |

   O passo 2 já resolve isso se a biblioteca estiver na lista compartilhada. Verifique com as mesmas duas requisições.

5. **Troque `UseStaticFiles` por `MapStaticAssets`.** O guia de migração do .NET 9 substitui `app.UseStaticFiles()` por `app.MapStaticAssets()`, e o template do .NET 10 o utiliza. Ele serve os ativos da biblioteca em `_content/Shared.Pages/...` com variantes `.br` e `.gz` pré-comprimidas. Verifiquei que manter `UseStaticFiles` no .NET 10 ainda serve `blazor.web.js` a partir de uma pasta de publish, então isso não é obrigatório, mas é o que o restante do template (`@Assets["..."]`, `<ResourcePreloader />`, `<ImportMap />`) espera:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseAntiforgery();
   app.MapStaticAssets();
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   Verifique que `GET /_framework/blazor.web.js` retorna `200` e que uma folha de estilo da biblioteca, como `/_content/Shared.Pages/Shared.Pages.bundle.scp.css`, ainda carrega.

6. **Se o host não tem arquivos `.razor`, force a volta do script do Blazor.** Esta é a quebra que atinge apenas as arquiteturas mais limpas. Quando `App.razor`, o layout e todas as páginas ficam em bibliotecas e o host é só o `Program.cs`, o .NET 8 ainda servia `blazor.web.js`, porque ele era um recurso embutido no shared framework. No .NET 10 o script é um ativo web estático que o SDK adiciona apenas se o projeto contiver pelo menos um componente. Meu host enxuto, medido a partir de uma pasta de publish:

   | Host | `GET /reports` | `GET /_framework/blazor.web.js` |
   | --- | --- | --- |
   | .NET 8.0.32, `UseStaticFiles` | 200 | 200 |
   | .NET 10.0.10, `MapStaticAssets` | 200 | 404 |
   | .NET 10.0.10, `MapStaticAssets` + `RequiresAspNetWebAssets` | 200 | 200 |

   A página ainda faz prerender, e é por isso que é fácil deixar passar: nada é interativo, e o único sinal é um 404 na aba de rede do navegador. A correção é uma propriedade do MSBuild:

   ```xml
   <!-- Host.csproj, .NET 10, host project without any .razor file -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
   </PropertyGroup>
   ```

   Verifique que `publish/wwwroot/_framework/blazor.web.js` existe após `dotnet publish`, e depois clique em algo interativo no navegador.

7. **Para páginas WebAssembly e Auto em uma biblioteca, confira também o lado `.Client`.** Nada aqui mudou entre o 8 e o 10, mas a migração é um bom momento para corrigir isso. Uma página de biblioteca com `@rendermode InteractiveWebAssembly` precisa poder ser baixada pelo navegador, então o projeto `.Client` precisa referenciar a biblioteca, e o servidor ainda precisa listá-la em `AddAdditionalAssemblies` para a primeira requisição. Se o próprio `Routes` roda em WebAssembly (interatividade global), ele fica em `.Client`, e o `Router` dele precisa da biblioteca em `AdditionalAssemblies`. Verifique carregando uma página WebAssembly diretamente e depois navegando até ela a partir de outra página.

## Verificação

Execute isto contra o app publicado (`dotnet publish -c Release -o out`, depois `dotnet out/Host.dll`), não contra `bin/`:

```bash
#!/usr/bin/env bash
# .NET 10 smoke test for routable components from other assemblies
BASE=http://localhost:5000
for u in /reports /not-found /missing /_framework/blazor.web.js; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")"
done
```

Esperado: `200`, `200`, `404`, `200`. Depois, em um navegador:

- Abra uma página da biblioteca diretamente e espere dois segundos. Ela não pode virar a página de não encontrado.
- Navegue de uma página do host para uma página da biblioteca clicando em um link, e volte.
- Dispare `NavigationManager.NotFound()` a partir de uma página da biblioteca, se você o usa, e confirme que a `NotFoundPage` é renderizada.
- Verifique na aba de rede se há algum 404 em `_framework/` ou `_content/`.

## Como reverter

A mudança é reversível desde que você mantenha a biblioteca compatível. Se a biblioteca faz multi-targeting em `net8.0;net10.0`, você pode reverter o host para `net8.0` desfazendo o `.csproj` dele. Lembre-se do que não existe no 8: `MapStaticAssets` (use `UseStaticFiles`), `NotFoundPage` (use o fragmento `<NotFound>`), o parâmetro `createScopeForStatusCodePages` de `UseStatusCodePagesWithReExecute` e `RequiresAspNetWebAssets` (inofensivo, mas sem uso). Mantenha essas mudanças em um commit separado do retarget, para que o rollback seja um revert limpo.

## Armadilhas encontradas nos testes

**"Assembly already defined" mudou de lugar.** Adicionar o assembly do próprio app a `AddAdditionalAssemblies` sempre foi um erro. No 8.0.32 o stack trace aponta direto para o seu código:

```text
Unhandled exception. System.InvalidOperationException: Assembly already defined.
   at Microsoft.AspNetCore.Components.Discovery.ComponentApplicationBuilder.AddLibrary(...)
   at Microsoft.AspNetCore.Builder.RazorComponentsEndpointConventionBuilderExtensions.AddAdditionalAssemblies(...)
   at Program.<Main>$(String[] args) in .../Host/Program.cs:line 29
```

No 10.0.10 o registro é adiado até os endpoints serem construídos pela primeira vez, então o mesmo erro é registrado como `Application startup exception` por `RazorComponentEndpointDataSource.UpdateEndpoints()`, e nenhum frame menciona `Program.cs`. Se você vir essa mensagem após a atualização, procure `typeof(Program).Assembly` na sua lista de assemblies adicionais, ou a mesma biblioteca adicionada duas vezes por dois métodos auxiliares.

**Rotas duplicadas entre assemblies falham em tempo de requisição, não na inicialização.** Quando o host e uma biblioteca declararam ambos `@page "/reports"`, o app iniciou normalmente no 10.0.10 e a requisição retornou `500` com `AmbiguousMatchException: The request matched multiple endpoints`. Só a URL em conflito quebra, então um smoke test que a pule vai passar. A saída de `grep -rn '@page "' --include=*.razor` do checklist prévio, ordenada por rota, encontra esses casos antes de irem para produção.

**Um membro da biblioteca chamado `RendererInfo` agora oculta um membro do framework.** Minha primeira versão da página de teste tinha uma propriedade `string RendererInfo`. Ela compilava sem problemas no .NET 8 e produziu `warning CS0108: 'Reports.RendererInfo' hides inherited member 'ComponentBase.RendererInfo'` no .NET 10, porque `ComponentBase` ganhou `RendererInfo` e `AssignedRenderMode` no .NET 9. O aviso é inofensivo até que um colega leia `RendererInfo.IsInteractive` nesse componente e receba a sua string. Renomeie o membro.

**Manter `UseStaticFiles` e testar a partir de `bin/` dá um 404 falso.** Com o pipeline do .NET 8 mantido (`UseStaticFiles`, sem `MapStaticAssets`), executar `dotnet bin/Release/net10.0/Host.dll` no ambiente Production retornou 404 para `blazor.web.js` mesmo em um host normal com componentes, enquanto o mesmo teste no .NET 8 retornou 200. `UseStaticFiles` só enxerga os arquivos fisicamente presentes em `wwwroot`, e fora do Development nada adiciona os ativos web estáticos dos projetos referenciados e do SDK. No .NET 8 o script do Blazor vinha de um recurso embutido, então isso não importava; no .NET 10 ele é um ativo web estático. A mesma execução a partir de `bin/` com `MapStaticAssets` retornou 200, porque ele lê o manifesto de endpoints gerado, e a pasta de publish retornou 200 com qualquer um dos middlewares. Teste a partir de uma pasta de `dotnet publish` ou com `dotnet run`, ou você vai perseguir o problema errado.

**O prerender esconde um registro ausente no `Router`.** Como a matriz mostra, uma página registrada apenas no lado do endpoint renderiza perfeitamente no `curl` e em testes automatizados de snapshot de HTML. A falha só aparece depois que o roteador interativo inicia. Qualquer teste de ponta a ponta para páginas de biblioteca precisa esperar a interatividade, por exemplo clicando em um botão e verificando o resultado.

## Relacionados

- Se você ainda está no modelo de hospedagem do .NET 7, comece por [migrar um app Blazor Server para o Blazor United](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) e depois volte para a parte de múltiplos assemblies.
- Para saber em qual modo de renderização uma página de biblioteca realmente roda depois de roteada, veja [o que é um modo de renderização do Blazor e qual deles executa o meu componente](/pt-br/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).
- Uma falha de ativo estático relacionada, com causa diferente: [404 Not Found para blazor.server.js após instalar um novo SDK do .NET](/pt-br/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).
- Se uma página de biblioteca declara um modo de renderização que o pai dela não consegue hospedar, você vai encontrar [o erro "render mode is not supported by the parent component's render mode"](/pt-br/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/).
- O layout de projeto por trás de `.Client` e `AddAdditionalAssemblies` é comparado em [Blazor Server vs WebAssembly vs United](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Fontes

- [Route to components from multiple assemblies](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) (Microsoft Learn, ASP.NET Core Blazor routing)
- [Migrate from ASP.NET Core in .NET 8 to ASP.NET Core in .NET 9](https://learn.microsoft.com/en-us/aspnet/core/migration/80-to-90), incluindo "Replace UseStaticFiles with MapStaticAssets" (Microsoft Learn)
- [Migrate from ASP.NET Core in .NET 9 to ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/migration/90-to-100) (Microsoft Learn)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): "Blazor router has a NotFoundPage parameter" e "Blazor script as static web asset"
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files) (Microsoft Learn)
- [ASP.NET Core Razor class libraries](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/class-libraries) (Microsoft Learn)
- [`Router.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Components/src/Routing/Router.cs), a fonte da validação de `NotFoundPage` e do parâmetro `NotFound` obsoleto (dotnet/aspnetcore)
- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) para as datas de fim de suporte do .NET 8 e do .NET 10
