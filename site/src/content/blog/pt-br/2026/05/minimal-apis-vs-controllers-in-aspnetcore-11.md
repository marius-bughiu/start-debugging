---
title: "Minimal APIs vs controllers no ASP.NET Core 11: qual escolher em 2026?"
description: "Use minimal APIs por padrão no ASP.NET Core 11. Use controllers apenas quando precisar de recursos de MVC que minimal APIs ainda não cobrem: roteamento baseado em convenções para muitas ações, filtros estilo MVC ou views Razor."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "minimal-apis"
  - "controllers"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/minimal-apis-vs-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Se você está começando um novo serviço HTTP em cima do ASP.NET Core 11 e tentando decidir entre minimal APIs e controllers, escolha minimal APIs. Os motivos de 2022 para continuar usando controllers (sem filtros, sem validação, OpenAPI fraco, sem grupos de rotas, sem Native AOT) acabaram. A partir do .NET 11, as minimal APIs têm filtros de endpoint, grupos de rotas, um documento OpenAPI integrado via `Microsoft.AspNetCore.OpenApi`, validação de parâmetros com `[Validate]` em `Microsoft.AspNetCore.Http.Validation`, `TypedResults` e suporte completo a Native AOT. Os controllers continuam sendo a ferramenta certa para dois casos específicos: você precisa de views Razor (MVC ou Razor Pages) no mesmo projeto, ou está mantendo uma base de código grande com centenas de ações decoradas com `[Route]` que funcionam hoje.

Cada exemplo de código deste post tem como alvo `<TargetFramework>net11.0</TargetFramework>` com `<LangVersion>14.0</LangVersion>` e usa os pacotes do ASP.NET Core 11 entregues no SDK GA do .NET 11.

## Matriz de recursos

| Recurso                                     | Minimal APIs (ASP.NET Core 11)                       | Controllers (ASP.NET Core 11)                       |
| ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Roteamento                                  | Endpoint routing, `MapGet`/`MapPost`, grupos de rotas | Endpoint routing, por atributo ou convenção         |
| Filtros por endpoint                        | `IEndpointFilter`, `AddEndpointFilter<T>`            | `IActionFilter`, `IAsyncActionFilter`               |
| Inferência da origem do binding             | Regras de binding por parâmetro, `[FromBody]` opcional | `[FromBody]`, `[FromQuery]`, `[FromForm]`, etc.   |
| Validação                                   | `[Validate]` em `Microsoft.AspNetCore.Http.Validation` (ASP.NET Core 11) | `ModelState` com DataAnnotations, `ApiController` |
| Helpers de resultado                        | `TypedResults`, `Results`                            | `IActionResult`, `ActionResult<T>`, `Problem()`     |
| OpenAPI / Swagger                           | `Microsoft.AspNetCore.OpenApi` 11, sem encanamento extra | `Microsoft.AspNetCore.OpenApi` 11 + convenções    |
| Native AOT                                  | Totalmente suportado (`PublishAot=true` funciona)    | Limitado; `AddControllers` ainda emite avisos de trim |
| Views Razor / Razor Pages                   | Não suportado (sem pipeline de renderização de views) | Suportado (`AddControllersWithViews`, Razor Pages) |
| Antiforgery (`POST` de formulário com cookies) | `app.UseAntiforgery()` + `[FromForm]`             | Embutido no MVC por padrão com `[ValidateAntiForgeryToken]` |
| Boilerplate padrão por endpoint             | 1 lambda + 1 linha `MapX`                            | 1 classe + 1 método + atributos                     |
| Descoberta em uma base de 200 endpoints     | Arquivos por grupo / métodos de extensão             | Uma classe de controller por recurso                |
| Tamanho do binário publicado com AOT        | O menor do framework                                 | Maior; pipeline completo do MVC                     |
| Throughput (endpoint JSON pequeno, estilo TechEmpower) | ~3-5% maior que controllers                | Referência base                                     |

Os números da última linha vêm dos próprios benchmarks do time do .NET para o ASP.NET Core 11. Trate a diferença como "perto do ruído" para a maioria das aplicações. O motivo para preferir minimal APIs não é o delta de throughput. É a superfície menor e a história do AOT.

## Quando minimal APIs é a escolha certa

Use minimal APIs por padrão para qualquer novo serviço HTTP em ASP.NET Core 11. Os casos específicos onde elas brilham:

- **Serviços JSON sobre HTTP e BFFs.** Um arquivo de serviço típico é um `Program.cs` mais algumas extensões `MapXxxEndpoints(this RouteGroupBuilder group)`. Sem `[ApiController]`, sem `[HttpGet("...")]`, sem injeção por construtor. As dependências por handler entram como parâmetros, que o runtime resolve via DI por padrão no ASP.NET Core 11.
- **Microsserviços e funções serverless no .NET 11.** A publicação com Native AOT produz um binário autocontido na faixa de 8-15 MB com um cold start abaixo de 100 ms. Os controllers ainda são parcialmente suportados em AOT, mas `AddControllers` emite avisos de trim que o time não conseguiu suprimir completamente.
- **Servidores MCP e endpoints para agentes de IA.** Quando você expõe um punhado de operações a um LLM via HTTP, o formato de uma linha por endpoint das minimal APIs combina com o formato conceitual de uma lista de ferramentas. O template `dotnet new mcpserver` incluído que chegou no [.NET 11 Preview 4](/pt-br/2026/05/dotnet-11-preview-4-mcpserver-template-bundled/) usa um registro com formato de minimal APIs pelo mesmo motivo.
- **Endpoints JSON adjacentes a gRPC.** Quando você já tem serviços gRPC em `Grpc.AspNetCore` e quer uma pequena superfície JSON para navegadores ou webhooks, as minimal APIs mantêm a camada HTTP enxuta.

Um endpoint pequeno mas realista:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddOpenApi();
builder.Services.AddScoped<IInvoiceStore, SqlInvoiceStore>();

var app = builder.Build();
app.MapOpenApi();

var invoices = app.MapGroup("/invoices")
    .WithTags("Invoices")
    .RequireAuthorization();

invoices.MapGet("/{id:int}", async (
    int id,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var invoice = await store.FindAsync(id, ct);
    return invoice is null
        ? Results.NotFound()
        : TypedResults.Ok(invoice);
});

invoices.MapPost("/", async Task<Results<Created<Invoice>, ValidationProblem>> (
    [Validate] CreateInvoice request,
    IInvoiceStore store,
    CancellationToken ct) =>
{
    var created = await store.CreateAsync(request, ct);
    return TypedResults.Created($"/invoices/{created.Id}", created);
});

app.Run();
```

`CreateSlimBuilder` carrega o conjunto mínimo de serviços, que é o que torna o Native AOT viável. `MapGroup` mais `RequireAuthorization` é a história de grupos de rotas / políticas compartilhadas que não existia antes do .NET 7. `[Validate]` é o atributo do ASP.NET Core 11 que ativa o `Microsoft.AspNetCore.Http.Validation`, o validador apoiado por gerador de código-fonte que substitui o pipeline de DataAnnotations restrito a controllers. O tipo de retorno `Results<TOk, TErr>` é o que torna o documento OpenAPI preciso sem nenhuma decoração `Produces` adicional.

## Quando os controllers são a escolha certa

Recorra a controllers quando uma destas afirmações for verdadeira:

- **Você precisa de views Razor ou Razor Pages na mesma aplicação.** HTML renderizado no servidor ainda é território de controller. `AddControllersWithViews` e `AddRazorPages` se conectam ao pipeline de views do MVC. As minimal APIs não, e não vão no .NET 11. Se metade dos seus endpoints são views MVC e metade é JSON, você pode perfeitamente rodar os dois na mesma `WebApplication`, mas a metade JSON pode continuar sendo minimal APIs enquanto as views ficam em controllers.
- **Você está mantendo uma base de código MVC grande.** Uma aplicação com 300 controllers, `[Authorize]`, `[ApiVersion]`, `[ProducesResponseType]` transversais e implementações customizadas de `IAsyncActionFilter` não é candidata a migração. O ROI de uma reescrita é negativo. Mantenha em controllers, atualize o projeto para `net11.0` e adicione novos endpoints como minimal APIs lado a lado se o time preferir.
- **Você depende de convenções ou filtros do MVC que não consegue replicar.** Algumas peças do MVC não têm equivalente em minimal APIs: `IModelBinder` para binding customizado, `IActionConstraint` para ramos de roteamento, convenções `ApplicationModel` em `IApplicationModelConvention`. Se você construiu infraestrutura sobre isso, o caminho de migração é trabalho real.
- **Você quer o contrato do `[ApiController]`.** O 400 automático em `ModelState` inválido, a inferência de `[FromBody]` e `ProblemDetails` em toda parte são bons valores padrão. As minimal APIs no ASP.NET Core 11 te dão os mesmos defaults se você conectar `[Validate]` e `app.UseStatusCodePages()`, mas `[ApiController]` faz isso com um atributo só.

Um controller comparável para os endpoints de faturas:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("invoices")]
[Authorize]
public class InvoicesController(IInvoiceStore store) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<Invoice>> Get(int id, CancellationToken ct)
    {
        var invoice = await store.FindAsync(id, ct);
        return invoice is null ? NotFound() : Ok(invoice);
    }

    [HttpPost]
    [ProducesResponseType(typeof(Invoice), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Invoice>> Create(
        CreateInvoice request,
        CancellationToken ct)
    {
        var created = await store.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

Dois endpoints, o dobro de boilerplate, sem ganho funcional. Esse é o padrão que faz das minimal APIs a opção padrão em 2026: em código novo, você escreve menos para expressar a mesma coisa.

## O benchmark

A diferença de performance entre os dois estilos no ASP.NET Core 11 é pequena mas consistente em endpoints JSON pequenos. Os benchmarks oficiais do time do .NET (https://github.com/aspnet/Benchmarks, resultados de GA do ASP.NET Core 11 publicados em novembro de 2025) reportam:

| Cenário                                 | Minimal APIs (RPS) | Controllers (RPS) | Delta  |
| --------------------------------------- | ------------------ | ----------------- | ------ |
| `GET /json` (objeto único, 200 bytes)   | 1.160.000          | 1.120.000         | +3,6%  |
| `POST /json` (echo, corpo de 1 KB)      | 590.000            | 565.000           | +4,4%  |
| `GET /plaintext` (TechEmpower)          | 7.250.000          | 7.250.000         | 0%     |
| Cold start (AOT, `dotnet publish -aot`) | 70 ms              | 280 ms            | -75%   |

Metodologia, resumida das execuções publicadas: ASP.NET Core 11 GA, Linux x64, máquinas Citrine, `wrk` dirigindo o Kestrel com 256 conexões concorrentes, execuções de 30 segundos calculadas pela média de cinco amostras. A linha de cold start é publicada pelo mesmo laboratório usando `time` no binário AOT na primeira execução. `plaintext` é idêntico porque o custo do pipeline de requisição é dominado pelo parsing do Kestrel, não pelo formato do endpoint.

A leitura honesta destes números: se você está limitado por CPU em um endpoint JSON quente, pode recuperar 3-5% trocando controllers por minimal APIs. Aplicações reais gastam tempo no EF Core ou em saídas HTTP, não no dispatcher de endpoints. A linha de cold start, porém, é real: se você está fazendo deploy em AWS Lambda ou Azure Functions, o delta do AOT é a diferença entre um serviço que aquece em menos de um segundo e um que não. O conteúdo complementar sobre [reduzir o cold start de uma Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) percorre o fluxo de publicação AOT que produz esses números.

## A pegadinha que decide por você

Três restrições decidem isso sem precisar de opinião:

- **Views Razor no projeto.** Se a aplicação serve Razor ou Razor Pages, você fica com controllers (para essas partes). As minimal APIs não conseguem retornar uma view renderizada. Você ainda pode dividir: endpoints JSON em minimal APIs, HTML em MVC, ambos registrados na mesma `WebApplication`.
- **`PublishAot=true`.** Se você precisa publicar com AOT (Lambda, Functions isolated, contêineres pequenos, IoT), minimal APIs são o caminho de menor resistência. O pipeline de controllers ainda emite avisos sob AOT no .NET 11, e o guia oficial do time recomenda minimal APIs para cenários AOT.
- **Uma base de controllers existente maior que algumas poucas classes.** O custo de migração está nos filtros transversais e nas convenções, não nas assinaturas dos endpoints. Se você tem infraestrutura significativa de `IActionFilter`, `IApplicationModelConvention` ou `IModelBinder` customizado, a migração é uma reescrita, não um refactor. Mantenha o que funciona.

## O que minimal APIs ainda não fazem

Algumas coisas que controllers fazem e que minimal APIs no ASP.NET Core 11 ainda não cobrem:

- **`IModelBinder` para binding complexo de múltiplas origens.** O binding de minimal APIs é majoritariamente inferido por origem (rota, query, corpo) e por parâmetro. Se você precisa mesclar headers, claims e corpo em um tipo composto com lógica customizada, você está escrevendo um método estático `BindAsync` no tipo, o que é aceitável mas não é tão descobrível quanto um model binder.
- **`IActionConstraint` para ramos de roteamento.** Útil para roteamento baseado em negociação de conteúdo onde uma rota mapeia para múltiplas ações dependendo dos headers `Accept`. Filtros de endpoint conseguem se aproximar, mas a camada de roteamento é menos expressiva.
- **O `[Consumes]` do MVC para negociação de conteúdo entre múltiplas ações na mesma rota.** Você pode fazer com minimal APIs roteando para um único endpoint e despachando internamente, mas a forma declarativa do MVC é mais compacta.

Se algum desses três é crítico no seu design, o custo-benefício pende de volta para controllers. Para 95% dos novos serviços ASP.NET Core 11, não é.

## A escolha, reafirmada

Por padrão, use minimal APIs no ASP.NET Core 11. São o jeito com menos boilerplate, pronto para AOT e limpo para OpenAPI de construir um serviço HTTP JSON em .NET 11. Os motivos históricos para preferir controllers (filtros, validação, grupos de rotas, OpenAPI, convenções) foram fechados um a um ao longo do .NET 7, 8, 10 e 11. O que sobra é um pequeno conjunto de recursos do MVC (views Razor, model binders, action constraints) que os controllers ainda dominam. Se o seu projeto precisa disso, use controllers nas partes que precisam e minimal APIs no resto. Os dois estilos convivem em uma só `WebApplication` sem problema.

## Relacionados

- [Como usar Native AOT com minimal APIs no ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para o fluxo de publicação AOT do qual os números do benchmark acima dependem.
- [Como adicionar rate limiting por endpoint no ASP.NET Core 11](/pt-br/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) para uma das preocupações transversais que os filtros de endpoint agora resolvem bem.
- [Como adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para o equivalente em minimal APIs de um filtro de exceções do MVC.
- [Como adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para documentar o fluxo de `RequireAuthorization()` mostrado acima.
- [Tracing nativo de OpenTelemetry no ASP.NET Core 11](/pt-br/2026/04/aspnetcore-11-native-opentelemetry-tracing/) para a peça de observabilidade que se conecta com qualquer um dos estilos.

## Fontes

- Documentação do ASP.NET Core 11, "Minimal APIs overview": https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/overview
- `Microsoft.AspNetCore.Http.Validation` (o pacote `[Validate]` incluso no ASP.NET Core 11): https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/validation
- Documentação de OpenAPI no ASP.NET Core 11: https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview
- Native AOT para ASP.NET Core: https://learn.microsoft.com/aspnet/core/fundamentals/native-aot
- Repositório aspnet/Benchmarks (fonte da tabela de throughput): https://github.com/aspnet/Benchmarks
- Referência de MVC controllers: https://learn.microsoft.com/aspnet/core/mvc/controllers/actions
