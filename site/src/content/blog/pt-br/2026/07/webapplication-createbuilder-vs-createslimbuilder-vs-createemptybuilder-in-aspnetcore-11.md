---
title: "WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder no ASP.NET Core 11"
description: "Use CreateBuilder para uma aplicação normal, CreateSlimBuilder quando você publica com trimming ou Native AOT atrás de um proxy TLS, e CreateEmptyBuilder apenas quando você quer registrar cada serviço por conta própria. Aqui está a matriz de recursos e as pegadinhas que forçam a decisão."
pubDate: 2026-07-23
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "native-aot"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

Para uma aplicação web ASP.NET Core 11 normal, use `WebApplication.CreateBuilder(args)`. É o padrão por um motivo: ele conecta cada recurso de hosting que você espera. Mude para `WebApplication.CreateSlimBuilder(args)` apenas quando você publica com trimming ou Native AOT e roda atrás de um proxy que termina o TLS, porque ele descarta HTTPS, HTTP/3, integração com IIS, static web assets e dois provedores de logging para reduzir o binário. Recorra a `WebApplication.CreateEmptyBuilder(...)` apenas no caso raro em que você quer uma linha de base próxima de zero e vai registrar o servidor, o roteamento e a configuração por conta própria. Este post tem como alvo o .NET 11 (Preview 6 no momento da escrita, GA em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14, mas os três métodos de fábrica existem desde o .NET 8, então a orientação vale sem alterações do .NET 8 ao 11.

## O que "padrões" realmente significa aqui

Os três métodos diferem em exatamente uma coisa: quanto eles registram no `WebApplicationBuilder` antes do seu código rodar. Todo o resto, a coleção `builder.Services`, o `builder.Build()`, o `app.MapGet(...)`, é idêntico. Então toda a decisão se resume a quais padrões você quer que sejam entregues a você versus quais você está disposto a adicionar de volta manualmente.

`CreateBuilder` te dá o host padrão completo. `CreateSlimBuilder` te dá um subconjunto selecionado, escolhido para ser seguro para trimming e pequeno. `CreateEmptyBuilder` te dá quase nada e espera que você opte por cada peça. Internamente eles até compartilham a maquinaria: `CreateSlimBuilder` é construído sobre o mesmo builder de aplicação de host vazio que `CreateEmptyBuilder` expõe, e então readiciona o conjunto enxuto de serviços por cima. É por isso que a ordenação abaixo é uma cadeia de superconjunto estrita, `CreateBuilder` inclui tudo que `CreateSlimBuilder` faz, que inclui tudo que `CreateEmptyBuilder` faz.

## Matriz de recursos

Cada linha é verificada contra a documentação do ASP.NET Core 11 e o código-fonte de `WebApplication.cs`. "Manual" significa que o recurso não é registrado para você, mas você pode adicioná-lo com a chamada mostrada.

| Recurso                                    | CreateBuilder | CreateSlimBuilder             | CreateEmptyBuilder            |
| ------------------------------------------ | ------------- | ----------------------------- | ----------------------------- |
| appsettings.json + appsettings.{env}.json  | sim           | sim                           | manual                        |
| User secrets (Development)                 | sim           | sim                           | manual                        |
| Config por variável de ambiente + linha de comando | sim   | sim                           | manual                        |
| Console logging                            | sim           | sim                           | manual (`AddConsole`)         |
| Logging Debug / EventSource / EventLog     | sim           | não                           | não                           |
| Servidor Kestrel                           | completo      | core (`UseKestrelCore`)       | manual (`UseKestrelCore`)     |
| Endpoints HTTPS no Kestrel                 | sim           | não (`UseKestrelHttpsConfiguration`) | manual                  |
| HTTP/3 (QUIC)                              | sim           | não (`UseQuic`)               | manual                        |
| Integração com IIS                         | sim           | não                           | não                           |
| Static web assets                          | sim           | não                           | não                           |
| Assemblies de hosting startup / `UseStartup` | sim         | não                           | não                           |
| Restrições de rota regex e alpha           | sim           | não                           | não                           |
| Roteamento / `MapGet` etc.                 | sim           | sim                           | manual                        |

A conclusão mais importante dessa tabela: `CreateSlimBuilder` ainda mantém suas fontes de configuração e o console logging. Ele não está tirando as coisas que você usa todos os dias. Ele remove recursos de protocolo e plataforma que uma implantação cloud-native, fronteada por proxy, normalmente não precisa, além de três provedores de logging que você raramente lê em produção.

## Quando escolher CreateBuilder

Este é o padrão, e para a maioria das aplicações ele deveria continuar sendo o padrão.

- **Você implanta no IIS ou IIS Express, ou roda no Windows e lê o EventLog do Windows.** Ambos só são conectados pelo `CreateBuilder`. `CreateSlimBuilder` não tem integração com IIS, então uma implantação IIS in-process simplesmente não vai hospedar corretamente.
- **Você serve static web assets a partir de Razor Class Libraries ou usa `UseStaticWebAssets`.** Aplicações de UI Blazor e MVC dependem disso. O slim builder não o registra, e o modo de falha é CSS/JS faltando sem nenhum erro óbvio.
- **Você usa restrições de rota `{id:regex(...)}` ou `{name:alpha}`.** Elas são omitidas do slim builder para economizar aproximadamente um megabyte de binário. `{id:int}` e outras restrições primitivas estão ok; regex e alpha são as duas que desaparecem.
- **Você não está publicando com trimming ou AOT de forma alguma.** Se você entrega uma build JIT normal, dependente de framework ou self-contained, o slim builder quase não te compra nada em tempo de execução. Os ganhos de tamanho de binário e de startup vêm do trimming e do AOT, não da escolha do builder por si só. Escolher slim aqui só significa readicionar HTTPS e companhia sem nenhum retorno.

## Quando escolher CreateSlimBuilder

`CreateSlimBuilder` foi introduzido no .NET 8 especificamente para ser o padrão do template de Web API Native AOT (`dotnet new webapiaot`). Escolha-o quando os itens a seguir descreverem sua implantação.

- **Você publica com `<PublishAot>true</PublishAot>` ou trimming agressivo (`<PublishTrimmed>true</PublishTrimmed>`).** O slim builder evita puxar caminhos de código pouco amigáveis ao trimming para dentro do grafo, o que mantém os avisos baixos e a saída pequena. Veja [como usar Native AOT com minimal APIs do ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para a configuração AOT completa para a qual este builder foi projetado.
- **Você roda atrás de um proxy ou ingress que termina o TLS (Nginx, Caddy, YARP, Azure Application Gateway).** O proxy cuida do HTTPS, então o seu processo escutando em HTTP puro é exatamente o correto. Essa é a suposição que o slim builder embute ao descartar a configuração de HTTPS do Kestrel.
- **Você quer a menor imagem de container razoável para um microsserviço de minimal API.** Combinado com trimming e AOT, o slim builder produz um único executável nativo pequeno com uma superfície de ataque minúscula.

Se você escolher slim e mais tarde descobrir que de fato precisa de HTTPS ou HTTP/3, você não precisa trocar de builder. Adicione-os de volta explicitamente:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateSlimBuilder(args);

// Re-enable HTTPS endpoints that CreateSlimBuilder omits by default.
builder.WebHost.UseKestrelHttpsConfiguration();

// Re-enable HTTP/3 (QUIC) if a client actually needs it.
builder.WebHost.UseQuic();

var app = builder.Build();
app.MapGet("/", () => "Hello from a slim host");
app.Run();
```

## Quando escolher CreateEmptyBuilder

`CreateEmptyBuilder(WebApplicationOptions)` cria um builder sem nenhum comportamento embutido. A aplicação que ele constrói contém apenas os serviços e o middleware que você configura explicitamente. Esta é uma ferramenta de especialista, não um padrão geral. Recorra a ela quando você está construindo o menor serviço possível e quer controlar cada registro, ou quando você está experimentando exatamente o quão pouco o ASP.NET Core precisa para servir uma requisição.

Aqui está o exemplo mínimo canônico das notas de lançamento do .NET 8, que ainda compila sem alterações no .NET 11:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());

// Nothing is registered by default, so add the server yourself.
builder.WebHost.UseKestrelCore();

var app = builder.Build();

app.Use(async (context, next) =>
{
    await context.Response.WriteAsync("Hello, World!");
    await next(context);
});

Console.WriteLine("Running...");
app.Run();
```

Note o que está faltando e teria que ser adicionado manualmente se você precisasse: não há carregamento de `appsettings.json`, não há console logging, não há roteamento (então não há `MapGet`; você escreve middleware bruto no lugar), e não há binding de configuração. Você adiciona cada um com uma chamada explícita: `builder.Configuration.AddJsonFile("appsettings.json")`, `builder.Logging.AddConsole()`, `builder.Services.AddRouting()`, e assim por diante. Esse é todo o propósito do empty builder: você paga por exatamente o que usa.

## A história do tamanho, e por que ela é uma história de trimming

A razão pela qual os três existem é tamanho de binário e startup para Native AOT, não throughput bruto de requisições. Para uma aplicação compilada com JIT, os três builders registram grafos de serviços diferentes, mas uma vez que a aplicação está aquecida, a diferença em requisições por segundo não é onde está o valor. O valor aparece quando você faz trimming e compila com AOT.

O próprio benchmark da Microsoft para o template de Web API Native AOT compara uma publicação Native AOT contra uma build de runtime com trimming e uma build de runtime sem trimming, e relata que a aplicação AOT tem o menor tamanho de aplicação, uso de memória e tempo de startup das três. As notas de lançamento do .NET 8 dão uma âncora concreta para o extremo vazio do espectro: o exemplo "Hello, World" com `CreateEmptyBuilder` acima, publicado com Native AOT em uma máquina linux-x64, produziu um executável nativo self-contained de cerca de 8,5 MB. Esse número é como se parece uma linha de base próxima de zero depois que o AOT e o trimming fazem seu trabalho.

A ordenação prática, do maior para o menor footprint publicado, é `CreateBuilder`, depois `CreateSlimBuilder`, depois `CreateEmptyBuilder`. Mas a diferença entre eles só se abre sob `PublishAot` ou `PublishTrimmed`. Entregue uma build simples e você pagou a cerimônia do slim ou empty builder sem coletar a recompensa. Esse é o erro mais comum: escolher o slim builder para uma implantação normal porque "slim soa mais rápido". Ele não é mais rápido em tempo de execução; ele é menor quando com trimming. Se você não está fazendo trimming, [o que o Native AOT realmente te custa](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) vale a leitura antes de você se comprometer com o caminho slim, e [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) cobre onde cada modo de publicação vence.

## A pegadinha que decide por você

A preferência raramente decide isso. Uma destas geralmente decide.

- **Hosting in-process do IIS força `CreateBuilder`.** Sem integração com IIS não há módulo in-process. Se o seu host é o IIS, a decisão está feita.
- **Static web assets forçam `CreateBuilder`.** Uma aplicação de UI Blazor ou Razor que perde `UseStaticWebAssets` entrega estilização quebrada sem nenhuma exceção no startup. Essa morde silenciosamente, então trate qualquer aplicação de UI como uma aplicação `CreateBuilder` a menos que você tenha um motivo específico para não fazer.
- **Restrições de rota regex ou alpha forçam `CreateBuilder`.** Se a sua tabela de roteamento tem `{code:regex(^[A-Z]{3}$)}` ou `{slug:alpha}`, o slim builder não vai resolver essas restrições. Restrições primitivas como `:int`, `:guid` e `:datetime` não são afetadas.
- **AOT mais um proxy TLS força `CreateSlimBuilder`.** Se você está publicando AOT para um microsserviço fronteado por proxy, slim é o padrão pretendido, e lutar contra ele começando por `CreateBuilder` puxa código pouco amigável ao trimming de volta para o grafo.
- **Controllers MVC descartam o AOT por completo, o que muda toda a questão.** MVC não é compatível com Native AOT, então se você precisa de controllers você não está indo para AOT completo de qualquer forma, e a principal vantagem do slim builder evapora. Veja [minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) se você ainda está pesando essa escolha.

## A decisão, reafirmada

Vá por padrão de `CreateBuilder`. É a escolha certa para a esmagadora maioria das aplicações ASP.NET Core 11, incluindo toda aplicação que usa IIS, static web assets, MVC, Blazor ou restrições de rota regex. Migre para `CreateSlimBuilder` quando, e apenas quando, você publica com trimming ou Native AOT e fica atrás de um proxy que termina o TLS, que é exatamente o cenário que o template `webapiaot` tem como alvo; readicione HTTPS ou HTTP/3 com uma única chamada `UseKestrelHttpsConfiguration()` ou `UseQuic()` se você precisar deles. Mantenha `CreateEmptyBuilder` no bolso de trás para o serviço genuinamente mínimo em que você quer registrar cada última peça por conta própria e medir o piso. A única coisa a não fazer é escolher o slim ou empty builder para uma implantação JIT normal com a teoria de que ele é mais rápido. Ele é menor quando com trimming, não mais rápido quando rodando, e em uma build normal você fica com o atrito sem o retorno. Se você está migrando um host mais antigo para este modelo em primeiro lugar, a [migração de IWebHostBuilder para WebApplication.CreateBuilder](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/) é o portão a atravessar antes de você otimizar qual método de fábrica você chama.

## Relacionados

- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Migrate from IWebHostBuilder to WebApplication.CreateBuilder in .NET 11](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fontes

- [WebApplication.CreateSlimBuilder Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.webapplication.createslimbuilder)
- [ASP.NET Core support for Native AOT: Compare CreateSlimBuilder and CreateBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot)
- [What's new in ASP.NET Core in .NET 8: New CreateEmptyBuilder method (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-8.0#new-createemptybuilder-method)
- [Andrew Lock: Comparing WebApplication.CreateBuilder to the new CreateSlimBuilder method](https://andrewlock.net/exploring-the-dotnet-8-preview-comparing-createbuilder-to-the-new-createslimbuilder-method/)
