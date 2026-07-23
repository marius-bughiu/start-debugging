---
title: "Typed results (Results<>) vs IResult vs IActionResult en ASP.NET Core 11"
description: "En ASP.NET Core 11, devuelve Results<T1, TN> con TypedResults para minimal APIs y ActionResult<T> para controladores. Trata IResult e IActionResult a secas como escotillas de escape: compilan para cualquier respuesta pero no le describen nada a OpenAPI, así que los pagas con atributos ProducesResponseType escritos a mano."
pubDate: 2026-07-23
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "es"
translationOf: "2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

Si tu endpoint tiene una sola respuesta posible, declara ese tipo concreto y sigue adelante. Si tiene varias, la respuesta precisa en ASP.NET Core 11 es: devuelve `Results<TResult1, TResultN>` con `TypedResults` desde una minimal API, y `ActionResult<T>` desde un controlador. Ambos te dan verificación en tiempo de compilación de que el handler solo devuelve lo que declara, y ambos le entregan al generador de OpenAPI los metadatos de la respuesta gratis. Los dos tipos de interfaz, `IResult` a secas e `IActionResult` a secas, son escotillas de escape: compilan sin importar lo que devuelvas, que es exactamente por lo que no le describen nada al framework y te obligan a escribir a mano `[ProducesResponseType]` o `.Produces` para obtener una especificación precisa. Todo lo que sigue apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14; los tipos de `HttpResults` se han comportado igual desde .NET 7, así que el mismo código corre sin cambios en .NET 10 GA.

Los tres contendientes del título de la cola se corresponden con dos mundos distintos. `IActionResult` es el mundo de los controladores MVC. `IResult` y su unión tipada `Results<>` son el mundo de las minimal API construido sobre el namespace `Microsoft.AspNetCore.Http.HttpResults`. El detalle que hace que valga la pena escribir esta comparación es que, a partir de .NET 7, los tipos de `HttpResults` también funcionan en controladores, así que en una acción de controlador ahora tienes una elección genuina entre los tipos de resultado de MVC y los de minimal API. Elegir bien significa entender qué carga y qué no carga cada tipo.

## La matriz de características

| Característica | `IActionResult` | `ActionResult<T>` | `IResult` (a secas) | `Results<T1, TN>` |
| --- | --- | --- | --- | --- |
| Hogar principal | Controladores | Controladores | Minimal APIs + controladores | Minimal APIs + controladores |
| Se autodescribe a OpenAPI | No | Parcial (infiere `T`) | No | Sí |
| Necesita `[ProducesResponseType]` / `.Produces` | Sí, con largueza | Para códigos de estado que no son `T` | Sí | No |
| Verificación de retorno en compilación | No | No | No | Sí |
| Negociación de contenido / formateadores | Sí | Sí | No | No |
| Cast implícito desde el tipo de payload | No (interfaz) | Sí (`T` a `ActionResult<T>`) | No | Sí (cada argumento de la unión) |
| Resultado directamente testeable | Requiere cast | Requiere cast | Requiere cast | `.Result` concreto |

Lee la matriz de arriba abajo y el patrón es claro. Las dos filas de interfaz dicen "No" en cada columna de metadatos y seguridad. Las dos filas tipadas se ganan su verbosidad convirtiendo el "No" en "Sí". La única columna donde las interfaces y `ActionResult<T>` le ganan a los tipos de `HttpResults` es la negociación de contenido, y esa única fila es la trampa que de vez en cuando elige por ti. Más sobre ella abajo.

## Cuándo elegir Results<> (y TypedResults)

Ve por la unión siempre que un endpoint de **minimal API** pueda responder con más de una forma.

- **Un endpoint de minimal API con un `200` y un `404`, en .NET 11.** Declara `Results<Ok<Todo>, NotFound>`, devuelve `TypedResults.Ok(todo)` y `TypedResults.NotFound()`, y elimina cada llamada a `.Produces`. La unión carga los metadatos ahora.
- **Cualquier endpoint donde la especificación deba mantenerse honesta.** Como el tipo de retorno *es* el contrato, agregar una rama `400` sin agregar `BadRequest` a la unión es un error de compilación, no una página de Swagger silenciosamente desactualizada.
- **Controladores donde quieres el mismo comportamiento autodescriptivo.** Los tipos de `HttpResults` son legales en una acción de controlador. `public Results<NotFound, Ok<Product>> GetById(int id)` compila y elimina todos tus atributos `[ProducesResponseType]`, exactamente como lo haría en una minimal API.

Esta es la forma canónica de una minimal API:

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

Sin `.Produces`, y el documento OpenAPI generado lista un `200` con un esquema `Todo` y un `404` sin cuerpo, ambos derivados del tipo de retorno. La conversión paso a paso, el techo de seis tipos y la ganancia en testeo se cubren en profundidad en [cómo devolver una unión tipada Results desde un endpoint de minimal API](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/); este post trata sobre cuándo elegirla frente a las alternativas, no sobre cómo conectarla.

## Cuándo elegir ActionResult<T>

Ve por `ActionResult<T>` cuando estás escribiendo una acción de **controlador** con un payload de éxito principal y una o más ramas de error.

- **Un `GET` de controlador que devuelve un `Product` o un `404`.** `ActionResult<Product>` te deja hacer `return product;` directamente (un cast implícito lo envuelve en un `ObjectResult`) y `return NotFound();` cuando no lo encuentra.
- **Quieres que el tipo de éxito se infiera en la especificación sin repetirlo.** Con `ActionResult<T>`, `[ProducesResponseType(200)]` ya no necesita `Type = typeof(Product)`; el framework lee `T`. La documentación lo dice claramente: "El tipo de retorno esperado de la acción se infiere del `T` en `ActionResult<T>`."
- **Necesitas negociación de contenido.** Los tipos de resultado de MVC fluyen a través de los formateadores configurados, así que un cliente que envía `Accept: application/xml` obtiene XML si tienes el formateador registrado. Los tipos de `HttpResults` no hacen esto en absoluto.

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

La razón por la que `ActionResult<T>` existe y `IActionResult` no puede reemplazarlo es una regla de C#, no una decisión del framework: C# no permite operadores de cast implícito en interfaces. `ActionResult<T>` es un tipo genérico concreto, así que puede definir la conversión implícita desde `T` que te deja escribir `return product;`. `IActionResult` es una interfaz, así que nunca puede. Esa es toda la brecha ergonómica entre los dos.

## Cuándo IActionResult o IResult a secas es realmente correcto

Ninguna interfaz está mal, solo son estrechas. Úsalas deliberadamente, no por defecto.

- **`IActionResult` cuando la acción genuinamente devuelve tipos de resultado no relacionados** y aceptas escribir `[ProducesResponseType]` para cada uno. Sigue siendo la elección honesta para una acción que podría devolver un archivo, una redirección y un cuerpo JSON desde tres ramas, donde no hay un único `T`.
- **`IResult` cuando tienes una rama de minimal API de una sola forma** y no quieres deletrear una unión de un solo brazo. Devolver un `IResult` a secas desde un handler que solo produce un estado está bien; solo agregas `.Produces` si te importa la documentación.
- **Compartir un handler entre una minimal API y un controlador.** Los tipos de `HttpResults` son la única familia de resultados que compila en ambos modelos de hosting, así que un método estático compartido que devuelve `IResult` o una unión `Results<>` es la forma de escribirlo una sola vez. Esa portabilidad es la razón documentada por la que los tipos existen fuera de las minimal APIs.

La versión de `IResult` a secas en un controlador se ve así, y nota que los atributos están de vuelta:

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

Cada helper `Results.*` devuelve `IResult`, así que el compilador infiere `IResult` para ambas ramas y nunca se queja, y el ApiExplorer ve una interfaz que no dice nada sobre códigos de estado. Por eso las dos líneas de `[ProducesResponseType]` son obligatorias aquí y están ausentes de la versión con `Results<>`: los metadatos no tienen de dónde más venir.

## La trampa que elige por ti: la negociación de contenido

Si tu API debe honrar cabeceras `Accept` y devolver XML, CSV o cualquier formato distinto del que el resultado codifica fijo, la familia `HttpResults` queda descartada, y esa decisión anula todo lo anterior. La documentación es explícita en que los tipos de `HttpResults` "***no*** aprovechan los formateadores configurados", y deletrea la consecuencia: "Algunas características como la `negociación de contenido` no están disponibles" y "El `Content-Type` producido lo decide la implementación de `HttpResults`." `TypedResults.Ok(product)` serializará JSON sin importar lo que pidió el cliente. Así que una API interna solo-JSON es libre de usar `Results<>` en un controlador y disfrutar de los metadatos autodescriptivos, pero una API pública con un formateador XML registrado tiene que quedarse en `ActionResult<T>` / `IActionResult` para los endpoints que negocian. Esto es un muro de capacidad, no una preferencia, que es por lo que pertenece a la cima de tu decisión y no al fondo.

La segunda función forzante es tu modelo de hosting. Si el endpoint vive en una minimal API, `IActionResult` y `ActionResult<T>` ni siquiera están disponibles para ti; son tipos de MVC que dependen del pipeline de controladores. La elección allí es solo entre `IResult` y `Results<>`, y `Results<>` gana para cualquier endpoint de múltiples respuestas. La compensación completa entre los dos modelos de hosting está expuesta en [minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

## Por qué las versiones tipadas no compilan por accidente

Hay una fricción que la gente encuentra con `Results<>` y vale la pena nombrarla para que no se lea como un bug. La inferencia de tipos no construirá la unión por ti. Esto no compila:

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

`TypedResults.NotFound()` y `TypedResults.Ok(todo)` son tipos concretos diferentes, así que el compilador no puede encontrar un tipo común para el ternario y la lambda no tiene un tipo de retorno inferible. La versión de `IResult` a secas compiló solo porque cada helper `Results.*` ya es `IResult`, dándole a las ramas un tipo compartido obvio. Con `TypedResults` pagas los metadatos más ricos declarando el tipo de retorno tú mismo: `Results<Ok<Todo>, NotFound>` para un handler síncrono o `Task<Results<Ok<Todo>, NotFound>>` para uno asíncrono. Esa declaración no es texto repetitivo que puedas acortar. Es la cadena exacta que el framework lee para construir la especificación, que es todo el punto.

La misma lógica explica por qué `ActionResult<IEnumerable<Product>>` funciona pero `ActionResult<T>` no puede envolver una interfaz que devuelves directamente: el cast implícito está definido desde `T`, y C# prohíbe los cast implícitos en interfaces, así que devolver una instancia de `IEnumerable` necesita un envoltorio explícito `Ok(...)`. Regla pequeña, ocasionalmente sorprendente.

## La recomendación, reafirmada con el panorama completo

- **Minimal API nueva, múltiples respuestas: `Results<T1, TN>` con `TypedResults`.** Verificación en tiempo de compilación más una especificación OpenAPI autodescriptiva, sin `.Produces`. Este es el valor por defecto y debería ser tu reflejo.
- **Minimal API nueva, respuesta única: el tipo concreto único**, por ejemplo `Task<Ok<Todo[]>>`. Salta la unión cuando no hay nada que desambiguar.
- **Controlador, solo-JSON, quieres los metadatos gratis: `Results<T1, TN>` en el controlador** funciona y elimina tus atributos. De lo contrario, **`ActionResult<T>`** para la ergonomía clásica de controladores.
- **Cualquier endpoint que deba negociar contenido (XML, CSV, tipos de medios personalizados): `ActionResult<T>` o `IActionResult`.** Los tipos de `HttpResults` no pueden hacer negociación de contenido, punto.
- **`IResult` a secas / `IActionResult` a secas: solo escotillas de escape.** Ve por ellos para respuestas genuinamente heterogéneas, ramas de una sola forma que no quieres escribir, o código compartido entre modelos de hosting, y acepta los metadatos escritos a mano que vienen con ellos.

El modelo mental a conservar: un tipo de retorno de interfaz acepta cualquier cosa y no documenta nada, así que el framework te obliga a re-declarar el contrato en atributos. Un tipo de retorno tipado, `Results<>` o `ActionResult<T>`, *es* el contrato, así que el compilador lo hace cumplir y el generador de OpenAPI lo lee. Elige el tipado a menos que una capacidad concreta, casi siempre la negociación de contenido, fuerce la interfaz. Para las ramas que devuelven una falla de validación, meter un `ProblemHttpResult` en la unión mantiene la forma consistente con el pipeline integrado descrito en [cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Relacionado

- [Cómo devolver una unión tipada Results desde un endpoint de minimal API en ASP.NET Core 11](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) para la conversión paso a paso, el techo de seis tipos y el testeo.
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para la elección de modelo de hosting que restringe qué tipos de retorno tienes siquiera.
- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) para el generador integrado que lee estos metadatos.
- [Cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService en ASP.NET Core 11](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para el `ProblemHttpResult` que a menudo se une a la unión.
- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para dónde encaja `ValidationProblem` en el conjunto de respuestas.

## Fuentes

- Microsoft Learn, [Controller action return types in ASP.NET Core web API](https://learn.microsoft.com/en-us/aspnet/core/web-api/action-return-types?view=aspnetcore-11.0) (`IActionResult`, `ActionResult<T>` y sus beneficios de cast implícito, la limitación de cast implícito en interfaces, y los tipos de `HttpResults` en controladores incluida la salvedad de la negociación de contenido).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, la unión `Results<TResult1, TResultN>`, operadores de cast implícito, verificación en tiempo de compilación, y metadatos autodescriptivos).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, y las sobrecargas de `Results<>`).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (el diseño original de la unión `Results<>`).
