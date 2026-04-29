---
title: "Idea para C# 14: los interceptores podrían hacer que la generación de código fuente de System.Text.Json se sienta automática"
description: "Una discusión de la comunidad propuso usar interceptores de C# 14 para reescribir las llamadas a JsonSerializer de modo que utilicen automáticamente un JsonSerializerContext generado, manteniendo la generación de código fuente compatible con AOT y con sitios de llamada más limpios."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
  - "system-text-json"
  - "aot"
lang: "es"
translationOf: "2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics"
translatedBy: "claude"
translationDate: 2026-04-29
---

Una de las discusiones más interesantes de .NET en las últimas 24 a 48 horas fue una pregunta simple: ¿por qué la generación de código fuente de `System.Text.Json` todavía se siente "manual" en el sitio de llamada?

El detonante fue un hilo del 7 de febrero de 2026 que proponía un enfoque muy en el espíritu de C# 14: **interceptores** que reescriben las llamadas `JsonSerializer.Serialize` y `JsonSerializer.Deserialize` para usar un `JsonSerializerContext` generado de forma automática.

## La brecha ergonómica: el contexto funciona, pero se propaga por tu código

Si quieres seguridad de trimming y rendimiento predecible en **.NET 10**, la generación de código fuente es una opción sólida. La fricción es que terminas hilando el contexto por todas partes:

```csharp
using System.Text.Json;

var foo = JsonSerializer.Deserialize<Foo>(json, FooJsonContext.Default.Foo);
var payload = JsonSerializer.Serialize(foo, FooJsonContext.Default.Foo);
```

Es explícito y correcto, pero es ruidoso. Ese ruido tiende a filtrarse en capas de la aplicación que no deberían preocuparse por las tuberías de serialización.

## Cómo se vería una reescritura basada en interceptores

La idea es: mantener los sitios de llamada limpios:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json);
```

Y luego tener un interceptor (en tiempo de compilación) que lo reescriba en la llamada basada en contexto que habrías escrito a mano:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json, GlobalJsonContext.Default.Foo);
```

Si tienes múltiples perfiles de opciones, el interceptor necesita una asignación determinista a la instancia de contexto correcta. Ahí es donde empieza la parte de "esto es difícil".

## Las restricciones que lo hacen viable o no (AOT es el juez)

Para que esto sea más que una idea bonita, tiene que sobrevivir en los entornos donde la generación de código fuente más importa:

- **NativeAOT y trimming**: la reescritura no debe reintroducir accidentalmente fallbacks basados en reflexión.
- **Identidad de las opciones**: necesitas una forma estable de elegir un contexto para un `JsonSerializerOptions` dado. Las opciones mutadas en tiempo de ejecución no encajan bien.
- **Compilación parcial**: los interceptores deben comportarse de manera consistente entre proyectos, ensamblados de prueba y compilaciones incrementales.

Si se cumplen esas restricciones, obtienes una victoria poco común: **mantener la canalización compatible con AOT**, pero eliminar las "tuberías de contexto" de la mayor parte de tu código.

La conclusión práctica de hoy: incluso si los interceptores no llegan exactamente con la forma discutida, esta es una señal fuerte de que los desarrolladores de .NET quieren mejor ergonomía alrededor de la generación de código fuente. Esperaría que las herramientas, los analizadores o los patrones de framework futuros se muevan en esa dirección.

Fuentes:

- [Hilo de Reddit](https://www.reddit.com/r/csharp/comments/1qyaviv/interceptors_for_systemtextjson_source_generation/)
- [Documentación de generación de código fuente de System.Text.Json](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation)
