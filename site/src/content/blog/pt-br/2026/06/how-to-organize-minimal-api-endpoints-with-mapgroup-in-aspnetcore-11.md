---
title: "Como organizar endpoints de Minimal APIs com MapGroup"
description: "Organize Minimal APIs com módulos de recursos e MapGroup: rotas aninhadas, metadados, filtros, autenticação e testes."
pubDate: 2026-06-07
updatedDate: 2026-11-02
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

`MapGroup` reúne um prefixo de rota e convenções de endpoints. Está disponível desde ASP.NET Core 7. Uma extensão por recurso retira o registro de `Program.cs` sem exigir controllers.

**Correção — 2 de novembro de 2026:** a versão anterior descrevia a junção de barras como concatenação literal e atribuía toda a API de `WebApplication` aos grupos. O exemplo substituto usa SDK 10.0.302; não representa execução no .NET 11.

## Um módulo completo

```csharp
// Program.cs in a Microsoft.NET.Sdk.Web project targeting net10.0.
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<TodoStore>();
var app = builder.Build();

app.MapGroup("/api").MapTodos();
app.Run();

public static class TodoEndpoints
{
    public static RouteGroupBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos/").WithTags("Todos");
        group.MapGet("/{id:int}", GetTodo).WithName("GetTodo");
        group.MapPut("/{id:int}", PutTodo);
        return group;
    }

    private static Results<Ok<Todo>, NotFound> GetTodo(int id, TodoStore store) =>
        store.Items.TryGetValue(id, out var todo)
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static NoContent PutTodo(int id, Todo todo, TodoStore store)
    {
        store.Items[id] = todo;
        return TypedResults.NoContent();
    }
}

public sealed class TodoStore
{
    public ConcurrentDictionary<int, Todo> Items { get; } = new(
        new[] { new KeyValuePair<int, Todo>(1, new Todo("Write docs", false)) });
}

public record Todo(string Title, bool IsComplete);
```

A aplicação expõe `GET /api/todos/1` e `PUT /api/todos/{id}`. O armazenamento em memória é demonstrativo e não persiste após reinícios. A composição de rotas do SDK 10 une `/todos/` e `/{id:int}` sem produzir `/todos//{id:int}`. Use formatação consistente, mas não deduza o resultado por concatenação simples de strings.

A classe pode ir para outro arquivo do mesmo projeto. A localização do arquivo não determina sozinha a execução do gerador de delegates de requisição. Handlers privados não podem ser chamados diretamente de outro assembly de testes: use HTTP ou extraia regras de negócio para serviços testáveis.

## O que o grupo oferece

`RouteGroupBuilder` implementa `IEndpointRouteBuilder` e `IEndpointConventionBuilder`. Permite rotas aninhadas e convenções como `WithTags`, `RequireAuthorization` e filtros. Não fornece toda a API de `WebApplication`: middleware `Use...` e ciclo de vida do host pertencem à aplicação.

Tags explícitas organizam OpenAPI, mas não geram nem disponibilizam o documento. Configure as ferramentas conforme a versão. Nomes de endpoints devem ser únicos em toda a aplicação.

Prefixos aninhados são combinados, e parâmetros externos podem ser vinculados a handlers internos. Filtros externos envolvem filtros internos e do endpoint. O código anterior a `await next(context)` avança até o handler; o posterior retorna na ordem inversa. A ordem de registro dentro de um grupo continua relevante.

## Configure as políticas

`RequireAuthorization("policy")` adiciona metadados; não cria a política, o handler de autenticação nem credenciais. Configure serviços e middleware adequados. Um prefixo `/v1` também não implementa sozinho uma estratégia completa de versionamento.

Para validar entradas, veja [validação integrada versus FluentValidation](/pt-br/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/). Native AOT depende de handlers, serializadores e dependências, além das rotas; consulte [o guia de AOT](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## Fontes

- [ASP.NET Core route handlers and route groups](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0#route-groups)
- [Endpoint filters](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)
- [RoutePatternFactory.Combine source, .NET 10](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Routing/src/Patterns/RoutePatternFactory.cs)
- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
