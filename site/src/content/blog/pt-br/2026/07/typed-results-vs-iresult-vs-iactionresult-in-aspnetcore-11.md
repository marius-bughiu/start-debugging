---
title: "Typed results (Results<>) vs IResult vs IActionResult no ASP.NET Core 11"
description: "No ASP.NET Core 11, retorne Results<T1, TN> com TypedResults para minimal APIs e ActionResult<T> para controllers. Trate IResult puro e IActionResult puro como saídas de emergência: eles compilam para qualquer resposta, mas não descrevem nada ao OpenAPI, então você paga por isso em atributos ProducesResponseType escritos à mão."
pubDate: 2026-07-23
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

Se o seu endpoint tem uma única resposta possível, declare esse único tipo concreto e siga em frente. Se ele tem várias, a resposta precisa no ASP.NET Core 11 é: retorne `Results<TResult1, TResultN>` com `TypedResults` a partir de uma minimal API, e `ActionResult<T>` a partir de um controller. Ambos te dão verificação em tempo de compilação de que o handler só retorna aquilo que declara, e ambos entregam ao gerador do OpenAPI os metadados da resposta de graça. Os dois tipos de interface, `IResult` puro e `IActionResult` puro, são saídas de emergência: eles compilam não importa o que você retorne, o que é exatamente a razão pela qual não descrevem nada ao framework e te forçam a escrever à mão `[ProducesResponseType]` ou `.Produces` para obter uma especificação precisa. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.NET.Sdk.Web` e o C# 14; os tipos `HttpResults` se comportam da mesma forma desde o .NET 7, então o mesmo código roda no .NET 10 GA sem alterações.

Os três concorrentes no título do artigo mapeiam para dois mundos diferentes. `IActionResult` é o mundo dos controllers MVC. `IResult` e sua união tipada `Results<>` são o mundo das minimal APIs construído sobre o namespace `Microsoft.AspNetCore.Http.HttpResults`. A sutileza que torna essa comparação digna de ser escrita é que, a partir do .NET 7, os tipos `HttpResults` também funcionam em controllers, então numa action de controller você agora tem uma escolha genuína entre os tipos de resultado do MVC e os das minimal APIs. Escolher bem significa entender o que cada tipo carrega e o que não carrega.

## A matriz de recursos

| Recurso | `IActionResult` | `ActionResult<T>` | `IResult` (puro) | `Results<T1, TN>` |
| --- | --- | --- | --- | --- |
| Casa principal | Controllers | Controllers | Minimal APIs + controllers | Minimal APIs + controllers |
| Se autodescreve ao OpenAPI | Não | Parcial (infere `T`) | Não | Sim |
| Precisa de `[ProducesResponseType]` / `.Produces` | Sim, à vontade | Para status codes que não sejam `T` | Sim | Não |
| Verificação de retorno em tempo de compilação | Não | Não | Não | Sim |
| Content negotiation / formatters | Sim | Sim | Não | Não |
| Cast implícito a partir do tipo do payload | Não (interface) | Sim (`T` para `ActionResult<T>`) | Não | Sim (cada arg da união) |
| Resultado testável diretamente em testes unitários | Cast necessário | Cast necessário | Cast necessário | `.Result` concreto |

Leia a matriz de cima para baixo e o padrão fica claro. As duas linhas de interface são "Não" em cada coluna de metadados e segurança. As duas linhas tipadas justificam sua verbosidade transformando "Não" em "Sim". A única coluna em que as interfaces e o `ActionResult<T>` batem os tipos `HttpResults` é a content negotiation, e essa única linha é a pegadinha que ocasionalmente escolhe por você. Mais sobre isso abaixo.

## Quando escolher Results<> (e TypedResults)

Recorra à união sempre que um endpoint de **minimal API** puder responder com mais de uma forma.

- **Um endpoint de minimal API com um `200` e um `404`, no .NET 11.** Declare `Results<Ok<Todo>, NotFound>`, retorne `TypedResults.Ok(todo)` e `TypedResults.NotFound()`, e delete cada chamada `.Produces`. A união carrega os metadados agora.
- **Qualquer endpoint onde a especificação deve permanecer honesta.** Como o tipo de retorno *é* o contrato, adicionar uma ramificação `400` sem adicionar `BadRequest` à união é um erro de compilação, não uma página do Swagger silenciosamente desatualizada.
- **Controllers onde você quer o mesmo comportamento autodescritivo.** Os tipos `HttpResults` são válidos numa action de controller. `public Results<NotFound, Ok<Product>> GetById(int id)` compila e derruba todos os seus atributos `[ProducesResponseType]`, exatamente como faria numa minimal API.

Aqui está a forma canônica de minimal API:

```csharp
// .NET 11, C# 14 -- Program.cs
using Microsoft.AspNetCore.Http.HttpResults;

app.MapGet("/todos/{id}", async Task<Results<Ok<Todo>, NotFound>> (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
});
```

Sem `.Produces`, e o documento OpenAPI gerado lista um `200` com um schema `Todo` e um `404` sem corpo, ambos derivados do tipo de retorno. A conversão passo a passo, o teto de seis tipos e o retorno em testabilidade são cobertos em profundidade em [como retornar uma união Results tipada a partir de um endpoint de minimal API](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/); este artigo é sobre quando escolhê-la em vez das alternativas, não sobre como conectá-la.

## Quando escolher ActionResult<T>

Recorra ao `ActionResult<T>` quando você estiver escrevendo uma action de **controller** com um payload de sucesso principal e uma ou mais ramificações de erro.

- **Um `GET` de controller que retorna um `Product` ou um `404`.** `ActionResult<Product>` te permite fazer `return product;` diretamente (um cast implícito o envolve num `ObjectResult`) e `return NotFound();` quando não encontra.
- **Você quer o tipo de sucesso inferido na especificação sem repeti-lo.** Com `ActionResult<T>`, `[ProducesResponseType(200)]` não precisa mais de `Type = typeof(Product)`; o framework lê o `T`. A documentação diz claramente: "O tipo de retorno esperado da action é inferido a partir do `T` em `ActionResult<T>`."
- **Você precisa de content negotiation.** Os tipos de resultado do MVC passam pelos formatters configurados, então um cliente enviando `Accept: application/xml` recebe XML se você tiver o formatter registrado. Os tipos `HttpResults` não fazem isso de forma alguma.

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public ActionResult<Product> GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? NotFound() : product;   // implicit cast T -> ActionResult<T>
}
```

A razão pela qual `ActionResult<T>` existe e `IActionResult` não pode substituí-lo é uma regra do C#, não uma decisão do framework: o C# não permite operadores de cast implícito em interfaces. `ActionResult<T>` é um tipo genérico concreto, então ele pode definir a conversão implícita a partir de `T` que te permite escrever `return product;`. `IActionResult` é uma interface, então nunca poderá. Essa é toda a diferença ergonômica entre os dois.

## Quando o IActionResult ou o IResult puro é de fato o correto

Nenhuma das interfaces está errada, elas são apenas restritas. Use-as deliberadamente, não por padrão.

- **`IActionResult` quando a action genuinamente retorna tipos de resultado não relacionados** e você aceita escrever `[ProducesResponseType]` para cada um. Continua sendo a escolha honesta para uma action que pode retornar um arquivo, um redirecionamento e um corpo JSON a partir de três ramificações, onde não há um único `T`.
- **`IResult` quando você tem uma ramificação de minimal API de forma única** e não quer soletrar uma união de um só braço. Retornar um `IResult` puro de um handler que só produz um status é aceitável; você só adiciona `.Produces` se se importa com o documento.
- **Compartilhar um handler entre uma minimal API e um controller.** Os tipos `HttpResults` são a única família de resultado que compila em ambos os modelos de hospedagem, então um método estático compartilhado que retorna `IResult` ou uma união `Results<>` é a maneira de escrevê-lo uma única vez. Essa portabilidade é a razão documentada pela qual os tipos existem fora das minimal APIs.

A versão com `IResult` puro num controller fica assim, e note que os atributos estão de volta:

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType<Product>(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public IResult GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? Results.NotFound() : Results.Ok(product);
}
```

Todo helper `Results.*` retorna `IResult`, então o compilador infere `IResult` para ambas as ramificações e nunca reclama, e o ApiExplorer vê uma interface que não diz nada sobre status codes. É por isso que as duas linhas `[ProducesResponseType]` são obrigatórias aqui e ausentes da versão com `Results<>`: os metadados não têm de onde mais vir.

## A pegadinha que escolhe por você: content negotiation

Se a sua API precisa honrar cabeçalhos `Accept` e retornar XML, CSV ou qualquer formato além daquele que o resultado fixa no código, a família `HttpResults` está fora, e essa decisão sobrepõe tudo acima. A documentação é explícita ao dizer que os tipos `HttpResults` "***não*** aproveitam os Formatters configurados", e detalha a consequência: "Alguns recursos como `Content negotiation` não estão disponíveis" e "O `Content-Type` produzido é decidido pela implementação de `HttpResults`." `TypedResults.Ok(product)` vai serializar JSON independentemente do que o cliente pediu. Então uma API interna só de JSON é livre para usar `Results<>` num controller e desfrutar dos metadados autodescritivos, mas uma API pública com um formatter de XML registrado tem que continuar no `ActionResult<T>` / `IActionResult` para os endpoints que negociam. Isso é uma barreira de capacidade, não uma preferência, e é por isso que pertence ao topo da sua decisão e não ao fim.

A segunda função forçante é o seu modelo de hospedagem. Se o endpoint vive numa minimal API, `IActionResult` e `ActionResult<T>` nem sequer estão disponíveis para você; eles são tipos do MVC que dependem do pipeline de controllers. A escolha ali é sempre apenas entre `IResult` e `Results<>`, e `Results<>` vence para qualquer endpoint de múltiplas respostas. O trade-off completo entre os dois modelos de hospedagem está exposto em [minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

## Por que as versões tipadas não compilam por acidente

Há um ponto de fricção que as pessoas encontram com `Results<>` e vale a pena nomeá-lo para que não seja lido como um bug. A inferência de tipos não vai construir a união para você. Isto não compila:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()   // NotFound
        : TypedResults.Ok(todo);    // Ok<Todo>
});
```

`TypedResults.NotFound()` e `TypedResults.Ok(todo)` são tipos concretos diferentes, então o compilador não consegue encontrar um tipo comum para o ternário e o lambda não tem um tipo de retorno inferível. A versão com `IResult` puro compilou apenas porque todo helper `Results.*` já é `IResult`, dando às ramificações um tipo compartilhado óbvio. Com `TypedResults` você paga pelos metadados mais ricos declarando o tipo de retorno você mesmo: `Results<Ok<Todo>, NotFound>` para um handler síncrono ou `Task<Results<Ok<Todo>, NotFound>>` para um assíncrono. Essa declaração não é boilerplate que você possa encurtar. É a string exata que o framework lê para construir a especificação, o que é a ideia inteira.

A mesma lógica explica por que `ActionResult<IEnumerable<Product>>` funciona, mas `ActionResult<T>` não pode envolver uma interface que você retorna diretamente: o cast implícito é definido a partir de `T`, e o C# proíbe casts implícitos em interfaces, então retornar uma instância de `IEnumerable` precisa de um wrapper `Ok(...)` explícito. Regra pequena, ocasionalmente surpreendente.

## A recomendação, reafirmada com o quadro completo

- **Nova minimal API, múltiplas respostas: `Results<T1, TN>` com `TypedResults`.** Verificação em tempo de compilação mais uma especificação OpenAPI autodescritiva, sem `.Produces`. Este é o padrão e deve ser o seu reflexo.
- **Nova minimal API, resposta única: o único tipo concreto**, por exemplo `Task<Ok<Todo[]>>`. Pule a união quando não há nada a desambiguar.
- **Controller, só JSON, quer os metadados de graça: `Results<T1, TN>` no controller** funciona e derruba seus atributos. Caso contrário, **`ActionResult<T>`** para a ergonomia clássica de controller.
- **Qualquer endpoint que precise negociar conteúdo (XML, CSV, media types customizados): `ActionResult<T>` ou `IActionResult`.** Os tipos `HttpResults` não conseguem fazer content negotiation, ponto final.
- **`IResult` puro / `IActionResult` puro: apenas saídas de emergência.** Recorra a eles para respostas genuinamente heterogêneas, ramificações de forma única que você não quer digitar por extenso, ou código compartilhado entre modelos de hospedagem, e aceite os metadados escritos à mão que vêm com eles.

O modelo mental a manter: um tipo de retorno de interface aceita qualquer coisa e não documenta nada, então o framework te faz reafirmar o contrato em atributos. Um tipo de retorno tipado, `Results<>` ou `ActionResult<T>`, *é* o contrato, então o compilador o impõe e o gerador do OpenAPI o lê. Escolha o tipado a menos que uma capacidade concreta, quase sempre content negotiation, force a interface. Para as ramificações que retornam uma falha de validação, alimentar a união com um `ProblemHttpResult` mantém a forma consistente com o pipeline embutido descrito em [como customizar respostas de erro de validação de minimal API com IProblemDetailsService](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Relacionados

- [Como retornar uma união Results tipada a partir de um endpoint de minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) para a conversão passo a passo, o teto de seis tipos e testes.
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para a escolha do modelo de hospedagem que restringe quais tipos de retorno você sequer tem.
- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) para o gerador embutido que lê esses metadados.
- [Como customizar respostas de erro de validação de minimal API com IProblemDetailsService no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para o `ProblemHttpResult` que frequentemente se junta à união.
- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para onde `ValidationProblem` se encaixa no conjunto de respostas.

## Fontes

- Microsoft Learn, [Controller action return types in ASP.NET Core web API](https://learn.microsoft.com/en-us/aspnet/core/web-api/action-return-types?view=aspnetcore-11.0) (`IActionResult`, `ActionResult<T>` e seus benefícios de cast implícito, a limitação de cast implícito em interfaces, e os tipos `HttpResults` em controllers incluindo a ressalva de content negotiation).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, a união `Results<TResult1, TResultN>`, operadores de cast implícito, verificação em tempo de compilação e metadados autodescritivos).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, e as sobrecargas de `Results<>`).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (o design original da união `Results<>`).
