---
title: "Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11"
description: "Um guia completo para estruturar minimal APIs no ASP.NET Core 11 com MapGroup: módulos de endpoints por recurso como métodos de extensão, grupos aninhados, filtros e autenticação compartilhados, prefixos com parâmetros de rota, tags OpenAPI e as regras de ordem de filtros que surpreendem."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Para evitar que uma minimal API transforme o `Program.cs` em uma parede de mil linhas de chamadas `app.MapGet(...)`, agrupe os endpoints relacionados com `app.MapGroup("/prefix")`, que retorna um `RouteGroupBuilder` que compartilha um prefixo de rota e quaisquer convenções (filtros, autenticação, tags OpenAPI) que você anexar a ele. O padrão duradouro é um método de extensão por recurso: `public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)` constrói seu próprio grupo internamente, e o `Program.cs` encolhe para uma lista de chamadas `app.MapTodos();`. O `MapGroup` é estável desde o ASP.NET Core 7 e não mudou no .NET 11. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14, mas a API é idêntica no .NET 8, 9 e 10.

## Por que o Program.cs apodrece

As minimal APIs vêm com uma demo sedutora: o app inteiro em um único arquivo. Isso é ótimo para um exemplo e terrível para um serviço real. Quando você já tem um punhado de recursos, cada um com os cinco verbos CRUD mais um par de sub-rotas, o `Program.cs` são algumas centenas de linhas de route handlers entremeados com o registro de DI, o cabeamento do middleware e o `app.Run()`. Você rola para além da configuração de autenticação para achar o `MapPut` que queria editar. Três handlers começam todos com `/api/v1/orders` e um deles tem um erro de digitação no prefixo que ninguém percebe até um 404 em produção.

A solução não é "voltar aos controllers". Os controllers resolvem a organização por convenção (uma classe por recurso, atributos para roteamento) ao custo do pipeline do MVC baseado em reflexão. As minimal APIs resolvem isso com `MapGroup` mais métodos de extensão simples de C#, e você mantém o modelo de endpoints enxuto e amigável ao AOT. Se você ainda está decidindo entre os dois modelos, os prós e contras estão detalhados em [minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/). Este guia assume que você já escolheu as minimal APIs e quer que elas escalem.

## MapGroup retorna um RouteGroupBuilder

`MapGroup` é um método de extensão sobre `IEndpointRouteBuilder`. Ele recebe um prefixo de rota e retorna um `RouteGroupBuilder`:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

RouteGroupBuilder todos = app.MapGroup("/todos");

todos.MapGet("/", () => "all todos");        // GET  /todos/
todos.MapGet("/{id:int}", (int id) => $"todo {id}"); // GET  /todos/42
todos.MapPost("/", () => "created");          // POST /todos/

app.Run();
```

Cada chamada `Map{Verb}` sobre o grupo herda o prefixo `/todos`, então os padrões que você escreve no grupo são relativos. `RouteGroupBuilder` implementa `IEndpointRouteBuilder`, que é o detalhe que faz todo o resto funcionar: qualquer coisa que você possa chamar sobre `app` (incluindo o próprio `MapGroup`), você pode chamar sobre um grupo. É assim que o aninhamento sai de graça.

O prefixo combina por simples concatenação. `app.MapGroup("/api").MapGroup("/v1").MapGet("/todos", ...)` registra `GET /api/v1/todos`. Não há mágica de normalização além de juntar os segmentos, então não duplique as barras: um prefixo de grupo `/todos/` mais um padrão de handler `/{id}` produz `/todos//{id}`, que não vai corresponder ao que você espera.

## Um método de extensão por recurso

O padrão que escala é dar a cada recurso sua própria classe estática com um método `Map`, e fazer esse método criar seu próprio grupo. O tipo de retorno deve ser `IEndpointRouteBuilder` (ou `RouteGroupBuilder`) para que as chamadas se encadeiem:

```csharp
// .NET 11, C# 14 -- Endpoints/TodoEndpoints.cs
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos")
            .WithTags("Todos");

        group.MapGet("/", GetAll);
        group.MapGet("/{id:int}", GetById).WithName("GetTodoById");
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete);

        return routes;
    }

    private static async Task<Ok<List<Todo>>> GetAll(TodoDb db) =>
        TypedResults.Ok(await db.Todos.ToListAsync());

    private static async Task<Results<Ok<Todo>, NotFound>> GetById(int id, TodoDb db) =>
        await db.Todos.FindAsync(id) is { } todo
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static async Task<Created<Todo>> Create(Todo todo, TodoDb db)
    {
        db.Todos.Add(todo);
        await db.SaveChangesAsync();
        return TypedResults.Created($"/todos/{todo.Id}", todo);
    }

    private static async Task<Results<NoContent, NotFound>> Update(int id, Todo input, TodoDb db)
    {
        var todo = await db.Todos.FindAsync(id);
        if (todo is null) return TypedResults.NotFound();
        todo.Title = input.Title;
        todo.Done = input.Done;
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, NotFound>> Delete(int id, TodoDb db)
    {
        var rows = await db.Todos.Where(t => t.Id == id).ExecuteDeleteAsync();
        return rows > 0 ? TypedResults.NoContent() : TypedResults.NotFound();
    }
}
```

Agora o `Program.cs` é um índice:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TodoDb>(o => o.UseSqlServer(/* ... */));
builder.Services.AddOpenApi();

var app = builder.Build();

app.MapTodos();
app.MapOrders();
app.MapCustomers();

app.MapOpenApi();
app.Run();
```

Duas coisas tornam esse idioma agradável. Primeiro, os handlers são métodos `private static` com nome em vez de lambdas, então cada um tem um nome real nos stack traces e é trivial de testar de forma isolada. Segundo, retornar `IEndpointRouteBuilder` de `MapTodos` permite continuar encadeando se você quiser (`app.MapTodos().MapOrders();`), embora uma chamada por linha se leia melhor.

Uma observação sobre o tipo de retorno: se o único trabalho de um método é construir um grupo e você quer que o *chamador* anexe mais convenções a esse grupo, retorne `RouteGroupBuilder`. Se o método registra endpoints e o chamador não deveria tocar o grupo depois, retorne `IEndpointRouteBuilder`. Misturar os dois é a fonte mais comum da confusão "por que meu `.RequireAuthorization()` não compila".

## Filtros, autenticação e metadados compartilhados em uma única chamada

A recompensa de um grupo é que uma convenção aplicada ao grupo se aplica a todos os endpoints abaixo dele. É aqui que o `MapGroup` se justifica frente a copiar e colar `.RequireAuthorization()` em vinte handlers:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin")
    .RequireAuthorization("AdminPolicy")   // every endpoint requires the policy
    .WithTags("Admin")                     // one OpenAPI tag for the whole group
    .AddEndpointFilter<AuditFilter>();     // runs for every endpoint in the group

admin.MapGet("/users", ListUsers);
admin.MapDelete("/users/{id:int}", DeleteUser);
```

`RequireAuthorization`, `WithTags`, `WithMetadata`, `RequireRateLimiting`, `AddEndpointFilter` e `AddEndpointFilterFactory` são todos métodos de `IEndpointConventionBuilder`, e `RouteGroupBuilder` implementa essa interface, então todos fluem para os membros. Se você precisa de rate limiting por endpoint particionado pela rota dentro de um grupo, o [guia de rate limiting por endpoint](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) cobre como `RequireRateLimiting` se compõe com a política de um grupo.

Há uma sutileza que vale a pena internalizar: `AddEndpointFilter` sobre um grupo **não** é middleware. Ele não roda uma vez por requisição ao prefixo. Ele é aplicado ao pipeline de filtros de cada endpoint individualmente, em tempo de build. A diferença prática é que o filtro só roda quando um endpoint do grupo realmente corresponde. Uma requisição a `/admin/nonexistent` que dá 404 nunca invoca `AuditFilter`, enquanto um middleware sobre o segmento de rota `/admin` invocaria. Se você quer middleware de verdade limitado a um caminho, use `app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/admin"), ...)`.

## Grupos aninhados e parâmetros de rota no prefixo

Como um grupo é ele mesmo um `IEndpointRouteBuilder`, você aninha chamando `MapGroup` sobre um grupo. Os prefixos podem conter parâmetros de rota e restrições, e um handler em qualquer profundidade pode fazer o binding de parâmetros declarados em qualquer prefixo ancestral:

```csharp
// .NET 11, C# 14
var orgs = app.MapGroup("/orgs/{orgId:int}");
var projects = orgs.MapGroup("/projects/{projectId:int}");

projects.MapGet("/issues", (int orgId, int projectId) =>
    $"issues for org {orgId}, project {projectId}");
// matches GET /orgs/7/projects/3/issues
```

O handler faz o binding tanto de `orgId` quanto de `projectId`, mesmo cada um sendo declarado um nível acima. Esta é a forma limpa de modelar recursos hierárquicos: cada nível da URL é um grupo, e os handlers folha permanecem curtos porque os valores de rota compartilhados são capturados pela estrutura em vez de repetidos em cada padrão.

O prefixo também pode ser vazio. `app.MapGroup("")` não adiciona nenhum segmento de caminho, que é o truque para anexar uma convenção ou filtro a uma faixa de endpoints sem mudar suas URLs:

```csharp
// .NET 11, C# 14
var versioned = app.MapGroup("").WithOpenApi();
var v1 = versioned.MapGroup("/v1");
var v2 = versioned.MapGroup("/v2");
```

## A regra de ordem de filtros que pega as pessoas

Quando os filtros vivem em grupos aninhados, a ordem em que rodam é determinada pelo aninhamento de grupos, **o mais externo primeiro**, não pela ordem em que você escreveu as chamadas `AddEndpointFilter`. Este é o comportamento mais contraintuitivo dos grupos de rotas, e é documentado mas fácil de passar batido.

```csharp
// .NET 11, C# 14
var outer = app.MapGroup("/outer");
var inner = outer.MapGroup("/inner");

inner.AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("inner group filter");
    return next(ctx);
});

outer.AddEndpointFilter((ctx, next) =>   // added second, runs first
{
    app.Logger.LogInformation("outer group filter");
    return next(ctx);
});

inner.MapGet("/", () => "Hi!").AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("endpoint filter");
    return next(ctx);
});
```

Uma requisição a `/outer/inner/` registra, em ordem:

```text
outer group filter
inner group filter
endpoint filter
```

O filtro externo roda antes do interno mesmo tendo sido adicionado em segundo lugar, porque os filtros se aplicam do grupo mais externo para dentro, e então os próprios filtros do endpoint por último. A ordem relativa das chamadas `AddEndpointFilter` só importa quando elas estão anexadas ao *mesmo* builder. Entre grupos diferentes, o aninhamento vence. Se você tem um filtro estilo autenticação que precisa rodar antes de um filtro de logging, coloque a autenticação no grupo externo, não só mais acima no arquivo.

## Versionar uma minimal API com grupos

Uma razão comum para recorrer a grupos aninhados é o versionamento da API por segmento de URL. Cada versão é um grupo, e cada módulo de recurso se monta sob o builder de versão que receber:

```csharp
// .NET 11, C# 14
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes, int version)
    {
        var group = routes.MapGroup($"/todos").WithTags($"Todos v{version}");
        group.MapGet("/", GetAll);
        // v2-only endpoint
        if (version >= 2) group.MapGet("/search", Search);
        return routes;
    }
}

// Program.cs
var v1 = app.MapGroup("/api/v1");
var v2 = app.MapGroup("/api/v2");

v1.MapTodos(version: 1);
v2.MapTodos(version: 2);
```

Para qualquer coisa além do versionamento por URL feito à mão (versionamento por media-type ou por cabeçalho, cabeçalhos de depreciação, version sets), o pacote `Asp.Versioning` se integra com `MapGroup` através de `HasApiVersion` sobre o grupo, mas para o caso comum de "prefixos de rota v1 e v2" o aninhamento simples acima é suficiente e não adiciona nenhuma dependência extra.

## Agrupar no documento OpenAPI

`WithTags` sobre um grupo é o que produz as seções recolhíveis no Swagger UI ou no Scalar. Marque o grupo uma vez e cada endpoint cai sob essa tag:

```csharp
// .NET 11, C# 14
var todos = app.MapGroup("/todos").WithTags("Todos");
```

Sem uma tag, o gerador de OpenAPI integrado recorre a usar o primeiro segmento de rota como tag, o que normalmente funciona mas convém definir explicitamente para que uma refatoração do prefixo não renomeie silenciosamente as seções da sua API. Se você também expõe fluxos de autenticação na especificação, o grupo é o lugar certo para anexar o requisito de segurança de modo que ele apareça em cada operação, veja [adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para o cabeamento de `WithOpenApi` e dos esquemas de segurança.

## Detalhes que valem a pena saber antes de refatorar

Algumas arestas afiadas que é fácil topar quando você reestrutura pela primeira vez um arquivo plano em grupos:

- **`MapGroup` precisa ser chamado sobre um builder, não depois de `app.Run()`.** Como todo registro de endpoints, isso tem que acontecer antes de o app começar a atender requisições. Adicionar um grupo de dentro de um request handler não faz nada.
- **Um prefixo de grupo não é uma restrição sobre o caminho inteiro.** `MapGroup("/api")` não impede que outras chamadas `MapGet("/api/...")` de nível superior em outro lugar correspondam. O grupo só governa os endpoints que você registra *através* dele.
- **`RequireAuthorization()` sobre um grupo é aditivo, não sobrescreve.** Se um grupo interno ou um endpoint também chamam `RequireAuthorization` com uma política diferente, ambas as políticas se aplicam (a requisição deve satisfazer todas). Não há uma semântica de "o interno vence".
- **`AddEndpointFilterFactory` roda uma vez em tempo de build, por endpoint, não por requisição.** A fábrica inspeciona `MethodInfo` e retorna o delegate real por requisição. Colocar lógica cara por requisição no corpo da fábrica (em vez de no delegate retornado) significa que ela nunca roda em tempo de requisição. Este é o mesmo padrão de fábrica que a documentação usa para colocar um `DbContext` em modo de consulta privada para um grupo de endpoints.
- **Native AOT funciona bem com tudo isso.** Grupos, módulos por método de extensão e filtros são todos parte da superfície de minimal API amigável ao AOT; nada disso força um fallback para reflexão. Se você publica com trimming ou AOT, veja [usar Native AOT com minimal APIs do ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para os detalhes do gerador de request delegates que fazem os handlers agrupados serem gerados por fonte de forma limpa.

O modelo mental para levar: um `RouteGroupBuilder` é apenas um `IEndpointRouteBuilder` com um prefixo lembrado e um conjunto lembrado de convenções. Todo truque organizacional, módulos, aninhamento, versionamento, autenticação compartilhada, deriva desse único fato. Comece extraindo um método de extensão `MapXxx` por recurso, reduza o `Program.cs` a uma lista de chamadas, e recorra a grupos aninhados só quando a hierarquia de URLs realmente aninhar.

## Relacionado

- [Minimal APIs vs controllers no ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) se você ainda está escolhendo entre os dois modelos de endpoints.
- [Adicionar um filtro global de exceções no ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para capturar exceções em cada endpoint agrupado em um único lugar.
- [Adicionar rate limiting por endpoint no ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/) para compor `RequireRateLimiting` com uma política de grupo.
- [Adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) para anexar esquemas de segurança à tag de um grupo.
- [Usar Native AOT com minimal APIs do ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para publicar endpoints agrupados com trimming e AOT.

## Fontes

- Microsoft Learn, [Route handlers in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0) (grupos de rotas, aninhamento, ordem de filtros).
- Microsoft Learn, [Filters in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0) (`AddEndpointFilter`, `AddEndpointFilterFactory`).
- Microsoft Learn, [Organizing ASP.NET Core Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/organizing-apis?view=aspnetcore-10.0).
- Referência da API, [EndpointRouteBuilderExtensions.MapGroup](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.endpointroutebuilderextensions.mapgroup).
