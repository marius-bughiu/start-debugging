---
title: "Cómo devolver una unión tipada Results<T1, T2> desde un endpoint de minimal API en ASP.NET Core 11"
description: "Declara el tipo de retorno del handler como Results<Ok<T>, NotFound> y devuelve TypedResults.Ok / TypedResults.NotFound: la unión ofrece verificación en tiempo de compilación de que el handler solo devuelve lo que declara, y se autodescribe a OpenAPI para que nunca escribas .Produces a mano. Cubre handlers asíncronos, el límite de seis tipos y las pruebas en ASP.NET Core 11."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "openapi"
lang: "es"
translationOf: "2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-14
---

Cuando un endpoint de minimal API puede responder con más de una forma, por ejemplo un `200 OK` con la entidad o un `404 Not Found` cuando falta, la tentación es declarar el handler devolviendo `IResult` y llamar a `Results.Ok(...)` o `Results.NotFound()`. Eso compila, pero descarta las dos cosas que `IResult` no puede llevar: el compilador ya no verifica que devuelvas solo los resultados que pretendías, y OpenAPI no tiene idea de que un `404` siquiera es posible a menos que escribas a mano `.Produces(404)` en el endpoint. La solución es el tipo de unión `Results<TResult1, TResult2, ...>` de `Microsoft.AspNetCore.Http.HttpResults`. Declara el handler como `Results<Ok<Todo>, NotFound>`, devuelve los valores concretos `TypedResults.Ok(todo)` y `TypedResults.NotFound()`, y la unión se autodescribe a OpenAPI mientras el compilador rechaza cualquier rama que devuelva algo que no listaste. Todo lo que sigue apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14; la unión se ha comportado de forma idéntica desde .NET 7, así que el mismo código se ejecuta sin cambios en .NET 10 GA.

## Por qué IResult pierde tus metadatos de OpenAPI

Empieza por la versión que la mayoría escribe primero. El handler devuelve `IResult` porque es el único tipo que encaja en ambas ramas:

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

Esto funciona en tiempo de ejecución, y es la razón por la que existe `Results`: cada helper de la clase estática `Results` devuelve `IResult`, así que el compilador infiere sin problema `IResult` como el tipo de retorno del delegate incluso cuando las ramas producen un `200` y un `404`. El costo aparece en tu documento OpenAPI. El framework inspecciona el tipo de retorno declarado para construir la sección de respuestas de la especificación, y todo lo que ve es `IResult`, una interfaz que no dice nada sobre códigos de estado ni payloads. Swagger UI muestra un único `200` sin documentar y ningún `404`. Para obtener una especificación precisa tienes que anotar el endpoint a mano:

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

Esas llamadas a `.Produces` son pura duplicación. Repiten lo que el cuerpo del handler ya decide, y nada las mantiene sincronizadas. Añade una rama `400` seis meses después y la especificación seguirá afirmando que el endpoint solo devuelve `200` o `404`, porque los metadatos viven en un lugar distinto del código que los produce. Esa deriva es exactamente lo que elimina la unión tipada.

## Declara la unión y devuelve TypedResults

La clase estática `TypedResults` es la gemela tipada de `Results`. Donde `Results.Ok(x)` devuelve `IResult`, `TypedResults.Ok(x)` devuelve el concreto `Ok<T>` del espacio de nombres `Microsoft.AspNetCore.Http.HttpResults`, y `TypedResults.NotFound()` devuelve un `NotFound`. Cada uno de esos tipos concretos implementa `IEndpointMetadataProvider`, así que cada uno sabe cómo describirse a OpenAPI. El tipo `Results<TResult1, TResult2>` los une en un único tipo de retorno declarado. Convertir el endpoint de arriba son tres pasos:

1. **Declara el tipo de retorno del handler como la unión.** Lista cada resultado que el handler puede producir, en cualquier orden: `Results<Ok<Todo>, NotFound>`. Para un handler asíncrono, envuélvelo en `Task<>`: `async Task<Results<Ok<Todo>, NotFound>>`.
2. **Devuelve helpers de `TypedResults`, no de `Results`.** Cambia `Results.Ok` por `TypedResults.Ok` y `Results.NotFound` por `TypedResults.NotFound`. Cada uno devuelve su tipo de implementación concreto.
3. **Elimina las llamadas a `.Produces`.** La unión lleva los metadatos ahora, así que las anotaciones manuales son redundantes y deberían irse, o se pudrirán.

Aquí está el endpoint tras la conversión:

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

Sin `.Produces`, y el documento OpenAPI ahora lista un `200` con un esquema `Todo` y un `404` sin cuerpo, generados directamente desde el tipo de retorno. La documentación oficial expone el compromiso con claridad: usar `TypedResults` con la unión es más verboso que devolver `IResult`, "but that's the trade-off for having the type information be statically available and thus capable of self-describing to OpenAPI". Si ejecutas el generador de documentos OpenAPI integrado que se cubre en [cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/), estos metadatos fluyen al JSON generado sin configuración extra.

## Cómo compila realmente la unión

La parte que hace esto ergonómico en lugar de doloroso es la conversión implícita. `Results<Ok<Todo>, NotFound>` define un operador de conversión implícita desde cada uno de sus argumentos genéricos a la propia unión. Cuando tu handler devuelve `TypedResults.Ok(todo)`, que es un `Ok<Todo>`, el compilador lo convierte implícitamente a la unión. Nunca construyes un `Results<...>` tú mismo, y nunca escribes un cast; devuelves el resultado concreto y la conversión es invisible. Por eso funciona el ternario del ejemplo: ambas ramas producen un tipo que la unión puede absorber, así que la expresión completa se tipa como la unión.

Aquí también está de dónde viene la seguridad en tiempo de compilación. Como la unión solo define conversiones desde los tipos que listaste, devolver cualquier otra cosa es un error de compilación, no una sorpresa en tiempo de ejecución. Añade una rama que devuelva `TypedResults.BadRequest()` sin añadir `BadRequest` a la unión y la compilación falla:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();   // error: BadRequest is not in the union
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

El compilador te dice que los resultados declarados y los resultados devueltos no coinciden, así que el contrato del endpoint y su implementación nunca pueden derivar en silencio. Corrígelo añadiendo el tipo que realmente devuelves:

```csharp
// .NET 11, C# 14 -- compiles, and OpenAPI now shows 200, 404, and 400
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound, BadRequest> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Fíjate en que el handler síncrono aquí no necesita el envoltorio `Task<>`, pero aun así debe declarar el tipo de retorno de la unión completo explícitamente. El compilador no inferirá un "mejor tipo común" entre `Ok<Order>`, `NotFound` y `BadRequest` por su cuenta, que es precisamente por qué el endpoint que devolvía `IResult` compilaba sin queja y este exige que deletrees la unión.

## Por qué la versión síncrona necesita el tipo declarado

Vale la pena entender el fallo que encontrarás si intentas dejar que la inferencia de tipos haga el trabajo. Esto no compila:

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

`TypedResults.Ok` y `TypedResults.NotFound` devuelven tipos concretos distintos, y el compilador se niega a inferir un tipo compartido para la expresión condicional, así que el lambda no tiene tipo de retorno inferible. La versión con `Results` del mismo código compilaba solo porque cada helper de `Results` ya está tipado como `IResult`, dándole al ternario un tipo común obvio. Con `TypedResults` pagas la información de tipos más rica declarando tú mismo el tipo de retorno, ya sea `Results<Ok<Todo>, NotFound>` para un handler síncrono o `Task<Results<Ok<Todo>, NotFound>>` para uno asíncrono. Esa declaración no es código repetitivo que puedas saltarte; es lo que el framework lee para construir tu especificación OpenAPI.

## El beneficio en las pruebas

Como el handler ahora devuelve un tipo concreto en lugar de `IResult`, las pruebas unitarias pueden hacer aserciones sobre el resultado exacto sin levantar un servidor HTTP ni hacer un cast. Extrae el handler a un método estático con nombre para que una prueba pueda llamarlo directamente:

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

Una prueba entonces verifica el tipo concreto y llega directamente a su `Value` tipado, sin reflexión sobre `IResult` ni ida y vuelta HTTP:

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

La unión expone el resultado real a través de su propiedad `Result`, y `Ok<Todo>` expone el payload a través de un `Value` fuertemente tipado. Esa es la ventaja de "improve unit testing" que la documentación lista para `TypedResults`: con `Results` primero tendrías que convertir el `IResult` de vuelta a un tipo concreto antes de poder hacer aserciones sobre él. Aquí el tipo ya es concreto, así que la aserción es de una sola línea. Si tu handler es lo bastante pequeño como para ir en línea en `MapGet`, extraerlo a un método estático solo para hacerlo testeable es una refactorización razonable; la comparación [minimal APIs vs controllers en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) recorre cuándo compensa esa estructura.

## El techo de seis tipos y cómo mantenerte por debajo

`Results<>` está definido con dos hasta seis parámetros genéricos, así que un único endpoint puede declarar como máximo seis tipos de resultado distintos. En la práctica eso es de sobra: un endpoint que devuelve `Ok`, `Created`, `NotFound`, `BadRequest`, `Conflict` y `ValidationProblem` ya está en el límite y probablemente hace demasiado. Extender el techo se ha solicitado (rastreado como [dotnet/aspnetcore#61706](https://github.com/dotnet/aspnetcore/issues/61706)), pero por ahora seis es el muro.

Si realmente lo alcanzas, tienes dos salidas razonables. La primera es colapsar fallos relacionados en un único tipo de problema: en lugar de listar `BadRequest`, `Conflict` y `UnprocessableEntity` por separado, devuelve `ProblemHttpResult` vía `TypedResults.Problem(...)` y codifica la distinción en el payload RFC 9457, que es la misma forma que la validación integrada cubierta en [cómo personalizar las respuestas de error de validación de minimal API](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) ya emite. La segunda es recurrir a `IResult` para ese único endpoint y añadir las anotaciones `.Produces` a mano, aceptando los metadatos manuales como el precio de más de seis ramas. No recurras a ninguna de las dos hasta que hayas superado realmente seis; la mayoría de los endpoints viven cómodamente en dos o tres.

## Trampas que hacen tropezar

- **`Ok` y `Ok<T>` son tipos distintos.** `TypedResults.Ok()` sin argumento devuelve `Ok` (un `200` sin cuerpo); `TypedResults.Ok(value)` devuelve `Ok<T>`. Si tu unión lista `Ok<Todo>` pero una rama llama al `TypedResults.Ok()` sin parámetros, no compilará, porque `Ok` no es `Ok<Todo>`. Lista la variante exacta que produce cada rama.
- **El tipo de retorno de la unión debe deletrearse por completo.** No hay abreviatura ni inferencia. `async Task<Results<Ok<Todo>, NotFound>>` es verboso, y eso es intencional: el framework lee esa declaración exacta para construir la especificación, así que abreviarla no es una opción.
- **Un `Problem` devuelto desde el handler sigue saltándose `CustomizeProblemDetails`.** Poner `ProblemHttpResult` en la unión documenta la respuesta, pero un `ProblemDetails` que construyes y devuelves desde el handler se serializa directamente y no pasa por `IProblemDetailsService`. Si dependes de un callback global `CustomizeProblemDetails` para estampar un `traceId`, no se disparará para estos; ese mecanismo se detalla en el [post sobre personalización de IProblemDetailsService](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).
- **El orden en la lista genérica no importa, pero es tu documentación.** `Results<Ok<Todo>, NotFound>` y `Results<NotFound, Ok<Todo>>` se comportan de forma idéntica. Elige un orden consistente (éxito primero es la convención común) para que un lector pueda escanear el contrato de un endpoint de un vistazo.
- **Aún añades metadatos que no son de estado explícitamente.** La unión cubre los tipos de respuesta y los códigos de estado. Cosas como `.WithName`, `.WithTags`, `.RequireAuthorization` o un `Produces` personalizado para un tipo de contenido no predeterminado son preocupaciones separadas y siguen yendo en el endpoint builder, exactamente como lo harían con cualquier otro endpoint, incluida la configuración de JWT en [cómo configurar la autenticación JWT bearer en una minimal API](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

El modelo mental que conviene retener: `IResult` es la vía de escape que devuelve cualquier cosa y no documenta nada, mientras que `Results<T1, TN>` es un contrato declarado que el compilador impone y OpenAPI lee. Recurre a la unión siempre que un endpoint tenga más de una respuesta posible, devuelve el helper `TypedResults` correspondiente desde cada rama, y deja que el sistema de tipos mantenga tu handler, tus pruebas y tu especificación de acuerdo. Cuando un endpoint tiene de verdad una única forma de respuesta, salta la unión y declara ese único tipo concreto directamente, por ejemplo `Task<Ok<Todo[]>>`; la unión gana su verbosidad solo cuando hay más de una rama que documentar.

## Related

- [Cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService en ASP.NET Core 11](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para dar forma al `ProblemHttpResult` que pones en la unión.
- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) para el generador integrado que lee estos metadatos.
- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para el resultado `ValidationProblem` que a menudo se une a la unión.
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para agrupar endpoints tipados y aplicar metadatos compartidos.
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para cómo difieren las convenciones de tipo de retorno entre los dos modelos.

## Sources

- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, la unión `Results<TResult1, TResultN>`, los operadores de conversión implícita, la verificación en tiempo de compilación, el requisito del `Task<>` asíncrono y el ejemplo de prueba unitaria).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, `Results<TResult1, TResult2>` hasta la sobrecarga de seis parámetros).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (el diseño original de la unión `Results<>`).
- dotnet/aspnetcore, [Extend Results in TypedResults to support more than 6 types (issue #61706)](https://github.com/dotnet/aspnetcore/issues/61706) (el techo de seis tipos y la solicitud de elevarlo).
