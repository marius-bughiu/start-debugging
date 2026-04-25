---
title: "Runtime Async de .NET 11 reemplaza las state machines con trazas de pila más limpias"
description: "Runtime Async en .NET 11 mueve el manejo de async/await de las state machines generadas por el compilador al runtime mismo, produciendo trazas de pila legibles, breakpoints correctos, y menos asignaciones en heap."
pubDate: 2026-04-06
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
  - "debugging"
lang: "es"
translationOf: "2026/04/dotnet-11-runtime-async-cleaner-stack-traces"
translatedBy: "claude"
translationDate: 2026-04-25
---

Si alguna vez te has quedado mirando una traza de pila asíncrona en .NET tratando de averiguar qué método realmente lanzó, conoces el dolor. La infraestructura de state machine generada por el compilador convierte una simple cadena de llamadas de tres métodos en un muro de `AsyncMethodBuilderCore`, `MoveNext`, y nombres genéricos destrozados. .NET 11 Preview 2 entrega una característica preview llamada Runtime Async que arregla esto al nivel más profundo posible: el CLR mismo ahora gestiona la suspensión y reanudación asíncrona en lugar del compilador C#.

## Cómo funcionaba antes: state machines en todas partes

En .NET 10 y anterior, marcar un método como `async` le dice al compilador C# que lo reescriba en un struct o clase que implementa `IAsyncStateMachine`. Cada variable local se vuelve un campo en ese tipo generado, y cada `await` es una transición de estado dentro de `MoveNext()`. El resultado es correcto, pero tiene costos:

```csharp
async Task<string> FetchDataAsync(HttpClient client, string url)
{
    var response = await client.GetAsync(url);
    response.EnsureSuccessStatusCode();
    return await response.Content.ReadAsStringAsync();
}
```

Cuando ocurre una excepción dentro de `FetchDataAsync`, la traza de pila incluye frames para `AsyncMethodBuilderCore.Start`, el generado `<FetchDataAsync>d__0.MoveNext()`, y la fontanería genérica de `TaskAwaiter`. Para una cadena de tres llamadas asíncronas, puedes ver fácilmente 15+ frames donde solo tres llevan información significativa.

## Lo que Runtime Async cambia

Con Runtime Async habilitado, el compilador ya no emite una state machine completa. En su lugar, marca el método con metadatos que le dicen al CLR que maneje la suspensión nativamente. El runtime mantiene las variables locales en la pila y solo las derrama al heap cuando la ejecución realmente cruza un límite de `await` que no puede completarse de forma síncrona. El resultado práctico: menos asignaciones y trazas de pila dramáticamente más cortas.

Una cadena async de tres métodos como `OuterAsync -> MiddleAsync -> InnerAsync` produce una traza de pila que mapea directamente a tu fuente:

```
at Program.InnerAsync() in Program.cs:line 24
at Program.MiddleAsync() in Program.cs:line 14
at Program.OuterAsync() in Program.cs:line 8
```

Sin `MoveNext` sintético, sin `AsyncMethodBuilderCore`, sin genéricos con nombres destrozados. Solo métodos y números de línea.

## La depuración realmente funciona ahora

Preview 2 agregó una corrección crítica: los breakpoints ahora se enlazan correctamente dentro de los métodos runtime-async. En Preview 1, el depurador a veces saltaba breakpoints o aterrizaba en líneas inesperadas al pasar por límites de `await`. Con Preview 2, puedes establecer un breakpoint en una línea después de un `await`, golpearlo, e inspeccionar locales normalmente. Pasar por encima de un `await` aterriza en la siguiente sentencia, no dentro de la infraestructura del runtime.

Esto también beneficia a las herramientas de profiling y al logging de diagnóstico. Cualquier cosa que llame a `new StackTrace()` o lea `Environment.StackTrace` en runtime ahora ve la cadena de llamadas real, lo que hace que el logging estructurado y los manejadores de excepciones personalizados sean más útiles sin filtrado extra.

## Habilitando Runtime Async

Esto sigue siendo una característica preview. Opta agregando dos propiedades a tu `.csproj`:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

El soporte del lado del CLR está habilitado por defecto en .NET 11, así que ya no necesitas establecer la variable de entorno `DOTNET_RuntimeAsync`. La flag del compilador es el único interruptor.

## Qué tener en cuenta

Runtime Async aún no es el predeterminado para código de producción. El equipo de .NET sigue trabajando en casos extremos con tail calls, ciertas restricciones genéricas, e interacción con herramientas de diagnóstico existentes. Si ya estás en previews de .NET 11 y quieres probarlo en un proyecto de prueba, las dos líneas de MSBuild de arriba son todo lo que necesitas.

Los detalles completos de Runtime Async están en las [notas de versión de .NET 11 Preview 2](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/runtime.md) y la página [What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) en Microsoft Learn.
