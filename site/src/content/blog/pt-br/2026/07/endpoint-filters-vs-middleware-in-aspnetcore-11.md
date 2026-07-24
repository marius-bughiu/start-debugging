---
title: "Filtros de endpoint vs. middleware no ASP.NET Core 11: qual você deve usar?"
description: "Um guia de decisão para o ASP.NET Core 11: o middleware roda em cada requisição antes de o seu handler fazer o binding, os filtros de endpoint rodam apenas para o endpoint correspondente, depois do binding, e podem ver os argumentos tipados. Inclui uma tabela comparativa, cenários de quando escolher cada um, as regras de ordem e os detalhes que forçam a escolha."
pubDate: 2026-07-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
lang: "pt-br"
translationOf: "2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Use middleware quando a lógica precisar rodar em cada requisição, antes de ou independentemente de qual endpoint corresponde: tratamento de exceções, CORS, autenticação, compressão de respostas, arquivos estáticos, cabeçalhos encaminhados. Use um filtro de endpoint quando a lógica precisar dos argumentos vinculados do handler, ou deva se aplicar apenas a alguns endpoints: validação de entrada, normalização de argumentos, auditoria por endpoint. O teste mais preciso: se o seu código precisa do modelo tipado que o handler está prestes a receber, ele quer um filtro, porque um filtro roda depois do binding do modelo e pode ler `context.GetArgument<T>(index)`. Se ele precisa rodar havendo ou não uma rota correspondente, ele quer middleware, porque o middleware roda antes de o roteamento resolver um endpoint. Tudo o que segue é o detalhe por trás dessa decisão. Este artigo tem como alvo o .NET 11 (Preview 6 no momento em que escrevo, GA em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14, mas os dois recursos são estáveis desde o ASP.NET Core 7, então cada exemplo aqui roda sem alterações no .NET 8, 9 e 10.

## A tabela comparativa

Esta é a tabela que você veio buscar. Leia-a de cima para baixo e a decisão geralmente se toma sozinha.

| Recurso                                | Filtro de endpoint                       | Middleware                               |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Roda para                              | apenas o endpoint correspondente         | cada requisição naquele ramo do pipeline |
| Posição em relação ao roteamento       | depois do roteamento e do binding        | antes, durante ou depois (por posição)   |
| Vê os argumentos do handler            | sim, tipados via `GetArgument<T>(index)` | não, apenas o `HttpContext` cru          |
| Pode mutar os argumentos vinculados    | sim, `context.Arguments` é mutável       | não, o binding ainda não aconteceu       |
| Mecanismo de curto-circuito            | retornar um `IResult` em vez de `next`   | não chamar `next(context)`               |
| Controle de escopo                     | por endpoint ou por `MapGroup`           | por app, ou por ramo via `Map`/`UseWhen` |
| Registro                               | `.AddEndpointFilter(...)`                | `app.Use(...)` / `app.UseMiddleware<T>()` |
| Tipo de retorno                        | `ValueTask<object?>`                     | `Task`                                   |
| Roda quando nenhum endpoint corresponde | nunca                                   | sim, se colocado antes da execução do endpoint |
| Reutilizável em controllers MVC        | sim, também em endpoints de controller   | sim, em todo o pipeline                  |

As linhas que realmente decidem a escolha são as três primeiras. O middleware fica no pipeline de requisições e cada requisição que flui por aquele segmento o executa, mesmo uma requisição que dará 404 porque nenhum endpoint correspondeu. Um filtro de endpoint está ligado a um handler de rota específico e só roda quando esse handler é selecionado, o que acontece depois de o `UseRouting` ter feito a correspondência da requisição e depois de o framework ter vinculado os valores de rota, a query string e o corpo da requisição aos parâmetros do handler. Essa diferença de momento é toda a história.

## O que o middleware vê, e quando

O middleware é uma cadeia de componentes, cada um dos quais recebe o `HttpContext` e um delegate `next`. Você os registra no `Program.cs` em ordem, e a ordem é o comportamento: as requisições fluem de cima para baixo, as respostas fluem de volta de baixo para cima.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.Use(async (context, next) =>
{
    // Runs for EVERY request, including ones that will 404.
    var sw = System.Diagnostics.Stopwatch.StartNew();
    await next(context);
    sw.Stop();
    app.Logger.LogInformation(
        "{Method} {Path} -> {Status} in {Elapsed}ms",
        context.Request.Method, context.Request.Path,
        context.Response.StatusCode, sw.ElapsedMilliseconds);
});

app.MapGet("/hello/{name}", (string name) => $"Hi {name}");

app.Run();
```

Esse middleware de temporização mede a requisição inteira, incluindo o roteamento e qualquer 404. Ele só tem acesso ao `context.Request.Path` como uma string. Ele não pode ver que `name` foi vinculado a `"world"`, porque no ponto em que o middleware externo roda, o binding ainda não aconteceu. O middleware opera um nível abaixo do sistema de tipos do seu handler.

A posição em relação ao `UseRouting` importa mais do que as pessoas esperam. No modelo de hosting minimal moderno, o `WebApplication` insere o roteamento automaticamente, mas você pode chamar `app.UseRouting()` explicitamente para controlar onde a divisão acontece. O middleware registrado antes do roteamento roda antes de um endpoint ser sequer selecionado. O middleware registrado depois do `UseRouting` pode ler os metadados do endpoint selecionado através de `context.GetEndpoint()`, que é como o `UseAuthorization` sabe qual política aplicar. É por isso que a ordem canônica é `UseRouting`, depois `UseAuthentication`, depois `UseAuthorization` e depois a execução do endpoint: a autorização precisa dos metadados de endpoint que o roteamento produziu.

## O que um filtro de endpoint vê, e quando

Um filtro de endpoint envolve a invocação de um único handler de rota. Ele roda depois do roteamento e depois do binding, então tem a única coisa que o middleware não consegue obter: os argumentos reais e tipados que o seu handler está prestes a receber.

```csharp
// .NET 11, C# 14
app.MapPost("/orders", (Order order) => Results.Created($"/orders/{order.Id}", order))
    .AddEndpointFilter(async (context, next) =>
    {
        // The Order is already bound. Middleware could never see this.
        var order = context.GetArgument<Order>(0);
        if (order.Quantity < 1)
        {
            return Results.Problem("Quantity must be at least 1.");
        }
        return await next(context);
    });
```

O tipo de retorno do filtro é `ValueTask<object?>`. Retornar qualquer `IResult` (como `Results.Problem`) faz curto-circuito e escreve esse resultado na resposta sem nunca chamar o handler. Retornar `await next(context)` roda o handler e passa o resultado dele de volta pela cadeia, então um filtro também pode transformar a resposta na saída. Como o filtro vê o `Order` vinculado, a validação vive naturalmente aqui. Um componente de middleware tentando fazer o mesmo trabalho teria que reler e re-desserializar o corpo da requisição por conta própria, duplicando o trabalho que o framework já fez. Os mecanismos completos de `AddEndpointFilter`, a forma com classe baseada em `IEndpointFilter` e a ordem dos filtros são abordados em [como adicionar um filtro de endpoint a uma minimal API](/pt-br/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/); este artigo é sobre quando escolhê-lo em vez do middleware, para começar.

## Quando escolher middleware

- **A preocupação é global e independente da rota.** O tratamento de exceções (`UseExceptionHandler`), o redirecionamento HTTPS, HSTS, CORS, a compressão de respostas, os arquivos estáticos e o processamento de cabeçalhos encaminhados precisam rodar em cada requisição, independentemente de qual endpoint (se houver algum) corresponde. Um filtro não consegue expressar "rodar para tudo", porque um filtro está ligado aos endpoints, e um 404 não tem endpoint. A compressão de respostas em particular pertence ao pipeline, como abordado em [adicionar compressão de respostas a uma API do ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).
- **Você precisa rodar antes do roteamento.** Reescrever o caminho, remover um prefixo ou rejeitar uma requisição antes de o roteador sequer olhá-la é inerentemente um trabalho de middleware. Os filtros de endpoint rodam depois de a rota corresponder, então chegam tarde demais para influenciar o roteamento.
- **Você está capturando exceções em toda a app.** O `UseExceptionHandler` e as páginas de exceção para desenvolvedores envolvem todo o pipeline posterior. Um filtro só envolve o seu único endpoint, então uma exceção lançada durante o roteamento ou em outro middleware nunca o alcança. O tratamento global de erros é uma preocupação do pipeline, que é também por que uma [configuração de filtro global de exceções](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) é registrada no nível da app em vez de por endpoint.
- **A lógica deve ver requisições que darão 404.** Métricas, log de requisições e limitação de taxa frequentemente precisam contar ou limitar requisições que nunca correspondem a um endpoint. O middleware vê essas; os filtros não.

## Quando escolher um filtro de endpoint

- **Você precisa dos argumentos vinculados.** Validar um `Product`, verificar que um parâmetro de query `page` está dentro do intervalo ou normalizar uma string exigem todos o valor tipado. `context.GetArgument<T>(index)` e a lista mutável `context.Arguments` dão exatamente isso, e não há equivalente no middleware.
- **A preocupação se aplica a alguns endpoints, não a todos.** Um filtro se anexa a um único endpoint ou, via `MapGroup`, a um grupo deles. Se a sua validação só faz sentido para `POST /products` e `PUT /products/{id}`, um filtro de grupo a limita com precisão sem poluir o pipeline global. Isso compõe com os módulos por recurso descritos em [organizar endpoints de minimal API com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Você quer inspecionar ou reescrever o resultado do handler.** Como o valor de retorno do filtro flui de volta pela cadeia, ele pode envolver um resultado bem-sucedido em um envelope, adicionar dicas de cache ou traduzir um resultado de domínio em um `IResult`. O middleware só pode manipular o fluxo de resposta cru, o que é bem mais desajeitado depois que o handler começou a escrever.
- **Você quer a mesma lógica em minimal APIs e controllers.** O `AddEndpointFilter` também funciona no construtor de convenções de endpoint de um controller, então um único delegate de filtro pode proteger tanto um endpoint minimal quanto uma action MVC que compartilham uma rota.

## O único lugar onde o desempenho realmente entra na decisão

É tentador recorrer a um filtro "porque o middleware roda para tudo e isso é desperdício". Resista a enquadrar isso como uma competição de desempenho. Os dois recursos são leves: um filtro é um delegate que retorna `ValueTask<object?>`, e um componente de middleware é um delegate que retorna `Task`, e o overhead por invocação de qualquer um deles é insignificante ao lado de qualquer handler real que toque um banco de dados ou serialize JSON. A diferença significativa não é o custo por chamada, é quantas chamadas acontecem. Um componente de middleware colocado cedo no pipeline executa em cada requisição, então trabalho custoso ali (uma consulta ao banco de dados, uma alocação grande) é pago por cada 404 e cada ping de health-check. O mesmo trabalho em um filtro de endpoint roda apenas quando esse endpoint é selecionado. Então a regra de desempenho não é "filtros são mais rápidos", é "limite o trabalho a onde ele é necessário". Se uma preocupação transversal genuinamente se aplica a cada rota, o middleware é o lar correto e não mais lento para ela. Se ela se aplica a um punhado de endpoints, um filtro evita rodá-la nas milhares de requisições que nunca tocarão esses endpoints. Essa é uma decisão de escopo disfarçada de uma de desempenho, e é a versão honesta da afirmação.

## Os detalhes que escolhem por você

Algumas restrições rígidas anulam a preferência por completo.

**Um filtro não pode rodar antes do roteamento, nunca.** Se o seu requisito é "rejeitar a requisição antes de o roteador vê-la" ou "reescrever a URL", um filtro é fisicamente incapaz disso, porque vive dentro da execução do endpoint, que é posterior ao roteamento. Isso força o middleware.

**O middleware não pode ver o modelo vinculado sem refazer o trabalho.** Se o seu requisito é "validar o corpo desserializado da requisição", o middleware teria que fazer buffer e desserializar o corpo por conta própria, e então o framework o desserializa de novo para o handler. Esse binding duplo é um sinal forte de que você queria um filtro. Isso força um filtro.

**As exceções escapam do escopo de um filtro.** Um filtro só envolve o seu endpoint, então não pode ser a sua rede de segurança para toda a app. Se você põe o seu único tratamento de exceções em um filtro, uma exceção lançada em outro middleware, ou durante o roteamento, passa direto e atinge o manipulador 500 padrão. O tratamento global de erros força o middleware.

**Os modelos de ordem diferem, e misturá-los confunde as pessoas.** O middleware se aninha pela ordem de registro no `Program.cs`. Os filtros se aninham pela ordem em que você encadeia as chamadas `.AddEndpointFilter`: o primeiro registrado executa o seu código anterior ao `next` primeiro e o seu código posterior ao `next` por último. Quando você empilha os dois, toda a cadeia de filtros de um endpoint roda dentro do ponto mais interno do pipeline de middleware, depois de `UseRouting`, `UseAuthentication` e `UseAuthorization` terem executado. Então a autorização sempre roda antes de qualquer filtro de endpoint, o que geralmente é o que você quer, mas significa que um filtro é o lugar errado para implementar um esquema de autenticação. A autenticação força o middleware.

**O comportamento terminal é oposto.** Um componente de middleware que não chama `next` faz curto-circuito simplesmente ao não continuar. Um filtro faz curto-circuito retornando um `IResult`. Se você escreve um filtro e esquece de retornar algo no caminho de curto-circuito, você recebe um erro de compilação ou um resultado nulo em vez de uma requisição silenciosamente engolida, o que é uma pequena mas real vantagem ergonômica para os filtros.

## A recomendação, reafirmada

Por padrão, isto: preocupações transversais que precisam rodar em cada requisição, ou antes do roteamento, são middleware. Preocupações que precisam dos argumentos tipados do handler, ou que se aplicam a um subconjunto de endpoints, são filtros de endpoint. Autenticação, CORS, tratamento de exceções, compressão e arquivos estáticos são middleware e sempre serão. Validação, normalização de argumentos, auditoria por endpoint e moldagem de resultados são filtros de endpoint. O caso de zona cinzenta é a lógica de autorização por endpoint: se ela só precisa de claims de `HttpContext.User`, qualquer um funciona, mas prefira um filtro para que a política viva junto do endpoint que ela protege; se ela precisa dos argumentos vinculados para tomar a decisão (verificações de acesso em nível de linha sobre um id de entidade vinculado), ela deve ser um filtro. Quando você genuinamente não conseguir decidir, faça a única pergunta que resolve quase todos os casos: este código precisa ver os argumentos que o meu handler receberá? Sim significa filtro. Não, e ele deve rodar independentemente da rota, significa middleware.

## Relacionados

- [Como adicionar um filtro de endpoint a uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/)
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Como adicionar um filtro global de exceções no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)
- [Como adicionar compressão de respostas a uma API do ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Minimal APIs vs. controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fontes

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [ASP.NET Core Middleware (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/)
- [ASP.NET Core Middleware order (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/#middleware-order)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
