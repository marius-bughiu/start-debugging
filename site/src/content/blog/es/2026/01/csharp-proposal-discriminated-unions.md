---
title: "Propuesta de C#: uniones discriminadas"
description: "Un vistazo a la propuesta de uniones discriminadas en C#: la palabra clave union, coincidencia de patrones exhaustiva y cómo podría reemplazar bibliotecas como OneOf y jerarquías de clases."
pubDate: 2026-01-02
updatedDate: 2026-01-04
tags:
  - "csharp"
  - "csharp-proposals"
lang: "es"
translationOf: "2026/01/csharp-proposal-discriminated-unions"
translatedBy: "claude"
translationDate: 2026-05-01
---
El "santo grial" de las características de C# lleva años en discusión. Y tras años apoyándonos en bibliotecas de terceros como `OneOf` o en jerarquías de clases verbosas, parece que finalmente podríamos obtener soporte nativo para **uniones discriminadas (DUs)** en una versión futura de C#.

## El problema: representar "uno de"

Si querías que una función devolviera _o bien_ un resultado genérico de `Success` _o bien_ un `Error` específico, tenías malas opciones:

1.  **Lanzar excepciones** (caro como flujo de control).
2.  **Devolver `object`** (perdías seguridad de tipos).
3.  **Usar una jerarquía de clases** (verbosa y permite otros herederos).

## La solución: tipos `union`

La propuesta introduce la palabra clave `union`, que te permite definir jerarquías de tipos cerradas en las que el compilador conoce todos los casos posibles.

```cs
// Define a union
public union Result<T>
{
    Success(T Value),
    Error(string Message, int Code)
}
```

Esto genera bajo el capó un layout de struct altamente optimizado, similar al funcionamiento de los enums de Rust.

## Coincidencia de patrones exhaustiva

El verdadero poder de las DUs aparece al consumirlas. La expresión switch **debe** ser exhaustiva. Si olvidas un caso, el código no compila.

```cs
public string HandleResult(Result<int> result) => result switch
{
    Result.Success(var val) => $"Got value: {val}",
    Result.Error(var msg, _) => $"Failed: {msg}",
    // Compiler Error: No default case needed, but all cases must be covered!
};
```

## Por qué importa

De aceptarse, esta característica cambiaría fundamentalmente el manejo de errores en .NET. Podrías modelar estados de dominio con precisión (por ejemplo, `Loading`, `Loaded`, `Error`) sin la sobrecarga en runtime de las asignaciones de clases ni la carga cognitiva de patrones de visitor complejos.
