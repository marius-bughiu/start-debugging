---
title: "Como retornar uma união tipada Results<T1, T2> de um endpoint de minimal API no ASP.NET Core 11"
description: "Declare o tipo de retorno do handler como Results<Ok<T>, NotFound> e retorne TypedResults.Ok / TypedResults.NotFound: a união oferece verificação em tempo de compilação de que o handler só retorna o que declara, e ela se autodescreve ao OpenAPI para que você nunca escreva .Produces na mão. Cobre handlers assíncronos, o limite de seis tipos e testes no ASP.NET Core 11."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "openapi"
lang: "pt-br"
translationOf: "2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-14
---

Quando um endpoint de minimal API pode responder com mais de uma forma, digamos um `200 OK` com a entidade ou um `404 Not Found` quando ela não existe, a tentação é declarar o handler retornando `IResult` e chamar `Results.Ok(...)` ou `Results.NotFound()`. Isso compila, mas descarta as duas coisas que `IResult` não consegue carregar: o compilador não verifica mais que você retorna apenas os resultados que pretendia, e o OpenAPI não faz ideia de que um `404` sequer é possível, a menos que você escreva `.Produces(404)` na mão no endpoint. A solução é o tipo de união `Results<TResult1, TResult2, ...>` de `Microsoft.AspNetCore.Http.HttpResults`. Declare o handler como `Results<Ok<Todo>, NotFound>`, retorne os valores concretos `TypedResults.Ok(todo)` e `TypedResults.NotFound()`, e a união se autodescreve ao OpenAPI enquanto o compilador rejeita qualquer ramo que retorne algo que você não listou. Tudo o que segue mira o .NET 11 com `Microsoft.NET.Sdk.Web` e C# 14; a união se comporta de forma idêntica desde o .NET 7, então o mesmo código roda sem alterações no .NET 10 GA.

## Por que IResult perde seus metadados do OpenAPI

Comece pela versão que a maioria escreve primeiro. O handler retorna `IResult` porque é o único tipo que serve para os dois ramos:

```csharp
// .NET 11, C# 14 -- Program.cs
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? Results.NotFound()
        : Results.Ok(todo);
});
```

Isso funciona em tempo de execução, e é a razão de `Results` existir: cada helper da classe estática `Results` retorna `IResult`, então o compilador infere sem problemas `IResult` como o tipo de retorno do delegate mesmo quando os ramos produzem um `200` e um `404`. O custo aparece no seu documento OpenAPI. O framework inspeciona o tipo de retorno declarado para construir a seção de respostas da especificação, e tudo o que ele vê é `IResult`, uma interface que não diz nada sobre códigos de status ou payloads. O Swagger UI mostra um único `200` sem documentação e nenhum `404`. Para obter uma especificação precisa você tem que anotar o endpoint na mão:

```csharp
// .NET 11, C# 14 -- the manual annotation IResult forces on you
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
})
.Produces<Todo>(StatusCodes.Status200OK)
.Produces(StatusCodes.Status404NotFound);
```

Essas chamadas `.Produces` são pura duplicação. Elas repetem o que o corpo do handler já decide, e nada as mantém sincronizadas. Adicione um ramo `400` seis meses depois e a especificação ainda vai afirmar que o endpoint só retorna `200` ou `404`, porque os metadados vivem em um lugar diferente do código que os produz. Essa divergência é exatamente o que a união tipada elimina.

## Declare a união e retorne TypedResults

A classe estática `TypedResults` é a gêmea tipada de `Results`. Onde `Results.Ok(x)` retorna `IResult`, `TypedResults.Ok(x)` retorna o concreto `Ok<T>` do namespace `Microsoft.AspNetCore.Http.HttpResults`, e `TypedResults.NotFound()` retorna um `NotFound`. Cada um desses tipos concretos implementa `IEndpointMetadataProvider`, então cada um sabe como se descrever ao OpenAPI. O tipo `Results<TResult1, TResult2>` os une em um único tipo de retorno declarado. Converter o endpoint acima são três passos:

1. **Declare o tipo de retorno do handler como a união.** Liste cada resultado que o handler pode produzir, em qualquer ordem: `Results<Ok<Todo>, NotFound>`. Para um handler assíncrono, envolva-o em `Task<>`: `async Task<Results<Ok<Todo>, NotFound>>`.
2. **Retorne helpers de `TypedResults`, não de `Results`.** Troque `Results.Ok` por `TypedResults.Ok` e `Results.NotFound` por `TypedResults.NotFound`. Cada um retorna seu tipo de implementação concreto.
3. **Remova as chamadas `.Produces`.** A união carrega os metadados agora, então as anotações manuais são redundantes e devem sair, ou vão apodrecer.

Aqui está o endpoint depois da conversão:

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

Sem `.Produces`, e o documento OpenAPI agora lista um `200` com um esquema `Todo` e um `404` sem corpo, gerados direto do tipo de retorno. A documentação oficial coloca o trade-off com clareza: usar `TypedResults` com a união é mais verboso do que retornar `IResult`, "but that's the trade-off for having the type information be statically available and thus capable of self-describing to OpenAPI". Se você roda o gerador de documentos OpenAPI integrado abordado em [como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/), esses metadados fluem para o JSON gerado sem configuração extra.

## Como a união realmente compila

A parte que torna isso ergonômico em vez de doloroso é a conversão implícita. `Results<Ok<Todo>, NotFound>` define um operador de conversão implícita de cada um de seus argumentos genéricos para a própria união. Quando seu handler retorna `TypedResults.Ok(todo)`, que é um `Ok<Todo>`, o compilador o converte implicitamente para a união. Você nunca constrói um `Results<...>` você mesmo, e nunca escreve um cast; você retorna o resultado concreto e a conversão é invisível. É por isso que o ternário do exemplo funciona: ambos os ramos produzem um tipo que a união consegue absorver, então a expressão inteira é tipada como a união.

É daqui também que vem a segurança em tempo de compilação. Como a união só define conversões dos tipos que você listou, retornar qualquer outra coisa é um erro de compilação, não uma surpresa em tempo de execução. Adicione um ramo que retorne `TypedResults.BadRequest()` sem adicionar `BadRequest` à união e o build falha:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();   // error: BadRequest is not in the union
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

O compilador te diz que os resultados declarados e os resultados retornados discordam, então o contrato do endpoint e sua implementação nunca podem divergir em silêncio. Corrija adicionando o tipo que você de fato retorna:

```csharp
// .NET 11, C# 14 -- compiles, and OpenAPI now shows 200, 404, and 400
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound, BadRequest> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Note que o handler síncrono aqui não precisa do wrapper `Task<>`, mas ainda deve declarar o tipo de retorno da união completo explicitamente. O compilador não vai inferir um "melhor tipo comum" entre `Ok<Order>`, `NotFound` e `BadRequest` por conta própria, que é precisamente por que o endpoint que retornava `IResult` compilava sem reclamar e este exige que você soletre a união.

## Por que a versão síncrona precisa do tipo declarado

Vale entender a falha que você vai enfrentar se tentar deixar a inferência de tipos fazer o trabalho. Isto não compila:

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

`TypedResults.Ok` e `TypedResults.NotFound` retornam tipos concretos diferentes, e o compilador se recusa a inferir um tipo compartilhado para a expressão condicional, então o lambda não tem tipo de retorno inferível. A versão com `Results` do mesmo código compilava só porque cada helper de `Results` já é tipado como `IResult`, dando ao ternário um tipo comum óbvio. Com `TypedResults` você paga pela informação de tipos mais rica declarando você mesmo o tipo de retorno, seja `Results<Ok<Todo>, NotFound>` para um handler síncrono ou `Task<Results<Ok<Todo>, NotFound>>` para um assíncrono. Essa declaração não é boilerplate que você possa pular; é o que o framework lê para construir sua especificação OpenAPI.

## O ganho nos testes

Como o handler agora retorna um tipo concreto em vez de `IResult`, testes de unidade podem fazer asserções sobre o resultado exato sem subir um servidor HTTP nem fazer cast. Extraia o handler para um método estático nomeado para que um teste possa chamá-lo diretamente:

```csharp
// .NET 11, C# 14 -- TodoEndpoints.cs
public static async Task<Results<Ok<Todo>, NotFound>> GetTodo(int id, TodoDb db)
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
}
```

Um teste então verifica o tipo concreto e alcança direto o seu `Value` tipado, sem reflexão sobre `IResult` nem ida e volta HTTP:

```csharp
// .NET 11, C# 14 -- xUnit
[Fact]
public async Task GetTodo_ReturnsOk_WhenFound()
{
    await using var db = new MockDb().CreateDbContext();
    db.Todos.Add(new Todo { Id = 1, Title = "Write the union post" });
    await db.SaveChangesAsync();

    var result = await TodoEndpoints.GetTodo(1, db);

    var ok = Assert.IsType<Ok<Todo>>(result.Result);
    Assert.Equal(1, ok.Value!.Id);
}
```

A união expõe o resultado real através de sua propriedade `Result`, e `Ok<Todo>` expõe o payload através de um `Value` fortemente tipado. Essa é a vantagem de "improve unit testing" que a documentação lista para `TypedResults`: com `Results` você primeiro teria que converter o `IResult` de volta para um tipo concreto antes de conseguir fazer qualquer asserção sobre ele. Aqui o tipo já é concreto, então a asserção é de uma linha só. Se o seu handler é pequeno o suficiente para ficar inline no `MapGet`, extraí-lo para um método estático apenas para torná-lo testável é uma refatoração razoável; a comparação [minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) percorre quando essa estrutura compensa.

## O teto de seis tipos e como ficar abaixo dele

`Results<>` é definido com dois até seis parâmetros genéricos, então um único endpoint pode declarar no máximo seis tipos de resultado distintos. Na prática isso é de sobra: um endpoint que retorna `Ok`, `Created`, `NotFound`, `BadRequest`, `Conflict` e `ValidationProblem` já está no limite e provavelmente faz coisas demais. Estender o teto foi solicitado (rastreado como [dotnet/aspnetcore#61706](https://github.com/dotnet/aspnetcore/issues/61706)), mas por enquanto seis é a parede.

Se você realmente bater nele, tem duas saídas razoáveis. A primeira é colapsar falhas relacionadas em um único tipo de problema: em vez de listar `BadRequest`, `Conflict` e `UnprocessableEntity` separadamente, retorne `ProblemHttpResult` via `TypedResults.Problem(...)` e codifique a distinção no payload RFC 9457, que é a mesma forma que a validação integrada abordada em [como personalizar as respostas de erro de validação de minimal API](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) já emite. A segunda é recorrer a `IResult` para aquele único endpoint e adicionar as anotações `.Produces` na mão, aceitando os metadados manuais como o preço de mais de seis ramos. Não recorra a nenhuma das duas até ter realmente ultrapassado seis; a maioria dos endpoints vive confortavelmente em dois ou três.

## Armadilhas que derrubam as pessoas

- **`Ok` e `Ok<T>` são tipos diferentes.** `TypedResults.Ok()` sem argumento retorna `Ok` (um `200` sem corpo); `TypedResults.Ok(value)` retorna `Ok<T>`. Se sua união lista `Ok<Todo>` mas um ramo chama o `TypedResults.Ok()` sem parâmetros, não vai compilar, porque `Ok` não é `Ok<Todo>`. Liste a variante exata que cada ramo produz.
- **O tipo de retorno da união deve ser soletrado por completo.** Não há abreviação nem inferência. `async Task<Results<Ok<Todo>, NotFound>>` é verboso, e isso é intencional: o framework lê essa declaração exata para construir a especificação, então abreviá-la não é uma opção.
- **Um `Problem` retornado pelo handler ainda ignora `CustomizeProblemDetails`.** Colocar `ProblemHttpResult` na união documenta a resposta, mas um `ProblemDetails` que você constrói e retorna do handler é serializado diretamente e não passa pelo `IProblemDetailsService`. Se você depende de um callback global `CustomizeProblemDetails` para carimbar um `traceId`, ele não vai disparar para esses; esse mecanismo é detalhado no [post sobre personalização de IProblemDetailsService](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).
- **A ordem na lista genérica não importa, mas é a sua documentação.** `Results<Ok<Todo>, NotFound>` e `Results<NotFound, Ok<Todo>>` se comportam de forma idêntica. Escolha uma ordem consistente (sucesso primeiro é a convenção comum) para que um leitor consiga escanear o contrato de um endpoint de relance.
- **Você ainda adiciona metadados que não são de status explicitamente.** A união cobre os tipos de resposta e os códigos de status. Coisas como `.WithName`, `.WithTags`, `.RequireAuthorization` ou um `Produces` personalizado para um tipo de conteúdo não padrão são preocupações separadas e continuam indo no endpoint builder, exatamente como iriam com qualquer outro endpoint, incluindo a configuração de JWT em [como configurar a autenticação JWT bearer em uma minimal API](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

O modelo mental para guardar: `IResult` é a saída de emergência que retorna qualquer coisa e não documenta nada, enquanto `Results<T1, TN>` é um contrato declarado que o compilador impõe e o OpenAPI lê. Recorra à união sempre que um endpoint tiver mais de uma resposta possível, retorne o helper `TypedResults` correspondente de cada ramo, e deixe o sistema de tipos manter seu handler, seus testes e sua especificação de acordo. Quando um endpoint de fato tem uma única forma de resposta, pule a união e declare esse único tipo concreto diretamente, por exemplo `Task<Ok<Todo[]>>`; a união ganha sua verbosidade só quando há mais de um ramo a documentar.

## Related

- [Como personalizar as respostas de erro de validação de minimal API com IProblemDetailsService no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para dar forma ao `ProblemHttpResult` que você coloca na união.
- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) para o gerador integrado que lê esses metadados.
- [Como validar corpos de requisição em minimal APIs sem controllers no ASP.NET Core 11](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para o resultado `ValidationProblem` que frequentemente se junta à união.
- [Como organizar endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para agrupar endpoints tipados e aplicar metadados compartilhados.
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para como as convenções de tipo de retorno diferem entre os dois modelos.

## Sources

- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, a união `Results<TResult1, TResultN>`, os operadores de conversão implícita, a verificação em tempo de compilação, o requisito do `Task<>` assíncrono e o exemplo de teste de unidade).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, `Results<TResult1, TResult2>` até a sobrecarga de seis parâmetros).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (o design original da união `Results<>`).
- dotnet/aspnetcore, [Extend Results in TypedResults to support more than 6 types (issue #61706)](https://github.com/dotnet/aspnetcore/issues/61706) (o teto de seis tipos e o pedido para elevá-lo).
