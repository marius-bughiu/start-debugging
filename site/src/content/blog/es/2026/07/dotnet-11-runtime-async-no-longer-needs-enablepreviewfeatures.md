---
title: ".NET 11 Runtime Async elimina la marca EnablePreviewFeatures"
description: "A medida que las versiones preliminares de .NET 11 avanzan hacia el lanzamiento de noviembre, Runtime Async se ha graduado: los proyectos net11.0 se activan con una sola propiedad de MSBuild, y las propias bibliotecas del runtime ahora se compilan con ella."
pubDate: 2026-07-11
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
lang: "es"
translationOf: "2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures"
translatedBy: "claude"
translationDate: 2026-07-11
---

Cuando Runtime Async aparecio por primera vez en .NET 11 Preview 2, activarlo significaba dos propiedades de MSBuild y reconocer de forma explicita que estabas viviendo al limite. A medida que las versiones preliminares han avanzado hacia el lanzamiento de noviembre de 2026 (Preview 6 llego el 10 de julio), esa barrera ha desaparecido silenciosamente. Runtime Async sigue siendo una caracteristica en version preliminar, pero un proyecto `net11.0` ya no necesita `<EnablePreviewFeatures>true</EnablePreviewFeatures>` para usarlo, y las propias bibliotecas del runtime de .NET ahora se compilan con el.

## Una propiedad en lugar de dos

Si seguiste el [articulo original sobre Runtime Async](/es/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), tu `.csproj` se veia asi:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

La forma de activarlo ahora es solo la marca del compilador:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
</PropertyGroup>
```

`EnablePreviewFeatures` incorporaba toda la superficie del analizador `System.Runtime.Experimental` y marcaba tu proyecto como participante de todas las API preliminares del SDK. Eliminarlo significa que puedes probar el async nativo del runtime sin dar luz verde accidentalmente a otras caracteristicas experimentales no relacionadas en todo el ensamblado.

## La BCL ahora la usa en su propio codigo

La senal mas importante es que las bibliotecas del runtime de .NET se compilan con `runtime-async=on`. Ya no contienen maquinas de estado generadas por el compilador y dependen por completo del async proporcionado por el runtime. Cada `await` que haces hacia `System.Net.Http`, `System.IO` o `System.Text.Json` ya se ejecuta sobre el nuevo modelo. Esto le da a la caracteristica una amplia validacion funcional y de rendimiento antes de convertirse en el valor predeterminado, y significa que una aplicacion cuyas unicas dependencias asincronas son bibliotecas del framework ya esta migrada en la practica.

## Interruptores que cambiaron sin avisar

Si tenias scripts o perfiles de inicio que manipulaban las antiguas variables de entorno, ya no existen. Las variables `DOTNET_RuntimeAsync` y `UNSUPPORTED_RuntimeAsync` que solian alternar el comportamiento se han eliminado. Para excluir un proyecto especifico ahora, define una propiedad del proyecto en su lugar:

```xml
<PropertyGroup>
  <UseRuntimeAsync>false</UseRuntimeAsync>
</PropertyGroup>
```

## Mayor cobertura de compilacion

Dos correcciones amplian donde se aplica realmente Runtime Async. Las sobrescrituras covariantes de `Task` a `Task<T>` ahora funcionan: cuando una clase derivada devuelve `Task<T>` para un metodo base tipado como `Task`, el runtime genera un thunk que devuelve void para salvar la diferencia en la convencion de llamadas, de modo que el despacho virtual funciona para ambas variantes, incluso bajo NativeAOT. Y se ha eliminado la restriccion que impedia insertar (inline) los metodos runtime-async durante la compilacion ReadyToRun (crossgen2), asi que la ruta rapida sincrona de un metodo asincrono sin await puede insertarse de principio a fin.

Nada de esto convierte todavia a Runtime Async en el valor predeterminado de produccion. Pero la friccion para probarlo en una base de codigo real de .NET 11 ahora es una sola linea de MSBuild, y la biblioteca estandar ya es la prueba de que aguanta. Todos los detalles de activacion estan en la pagina [Novedades del runtime de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime).
