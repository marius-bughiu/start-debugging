---
title: "System.Text.Json aprende a serializar los tipos union de C# en .NET 11 Preview 6"
description: "Cómo System.Text.Json en .NET 11 Preview 6 serializa los nuevos tipos union de C# escribiendo el caso activo, y las APIs JsonUnionAttribute y de clasificador de tipos que resuelven los casos ambiguos."
pubDate: 2026-07-21
tags:
  - "csharp"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "es"
translationOf: "2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-21
---

Los tipos union de C# han sido la característica estrella de las versiones preliminares de .NET 11, pero hasta ahora se detenían en la frontera del compilador. A partir de [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) (9 de julio de 2026), `System.Text.Json` los entiende de forma nativa: puedes serializar y deserializar una union sin escribir un `JsonConverter` personalizado. En Preview 6 encajaron otras dos piezas, así que todo esto por fin funciona sin código repetitivo: los tipos de soporte `System.Runtime.CompilerServices.UnionAttribute` e `IUnion` ahora se incluyen en el framework, de modo que una union compila en un proyecto `net11.0` sin más.

## Escribir el caso activo, no un envoltorio

Una union declara que un valor es exactamente uno de un conjunto fijo de tipos de caso. La forma abreviada genera un struct que contiene el caso que esté activo en ese momento:

```csharp
public union Pet(Cat, Dog, Bird);

public record Cat(string Name);
public record Dog(string Name);
public record Bird(string Name);
```

`System.Text.Json` reconoce esto a través de un nuevo tipo de contrato, `JsonTypeInfoKind.Union`. Cuando serializas una union, el serializador lee el caso activo y escribe *su* valor directamente, sin ningún envoltorio alrededor:

```csharp
Pet pet = new Dog("Rex");
string json = JsonSerializer.Serialize(pet);
// {"Name":"Rex"}
```

Para una union de primitivos, eso significa que una union de `int` y `string` va y vuelve limpiamente, porque los tokens JSON son estructuralmente distintos:

```csharp
Pet-like union of (int, string):
"hello"   // the string case
42        // the int case
```

Tanto el serializador basado en reflexión como el generador de código fuente admiten esto, así que no te ves obligado a abandonar la ruta compatible con AOT para usarlo.

## La brecha del discriminador, y cómo cerrarla

Escribir el valor en crudo es elegante, pero fíjate en lo que pasa con `Pet`: tanto `Dog("Rex")` como `Cat("Rex")` se serializan a `{"Name":"Rex"}`. En el camino de vuelta, el serializador no puede saber qué caso era. Este es el clásico problema de las uniones etiquetadas, y Preview 6 te entrega las herramientas para resolverlo en lugar de adivinar.

Tres nuevas APIs controlan cómo se descubren y nombran los casos: `JsonUnionAttribute`, `JsonUnionCaseInfo` y el par de clasificadores de tipos `JsonTypeClassifier` y `JsonSerializerOptions.TypeClassifiers`. Juntas te permiten adjuntar un discriminador de tipo al JSON emitido para que los casos ambiguos con forma de objeto se deserialicen de vuelta al tipo de caso correcto. Los casos estructuralmente distintos (como `int` frente a `string`) no necesitan nada de esto; la ceremonia solo entra en juego cuando las cargas útiles colisionarían.

Si has estado siguiendo la [cobertura de los tipos union desde Preview 2](/es/2026/04/csharp-15-union-types-dotnet-11-preview-2/), esta es la pieza que los hace utilizables a través de una frontera HTTP. Las unions siempre iban a vivir o morir según el soporte de serialización, y Preview 6 es donde dejan de ser una curiosidad del compilador y empiezan a ser algo que puedes poner en el cable.

Todos los detalles están en las [notas de la versión de las bibliotecas de Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/libraries.md).
