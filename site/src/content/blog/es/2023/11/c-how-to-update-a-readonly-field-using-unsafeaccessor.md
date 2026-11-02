---
title: "C#: cómo modificar un campo readonly con UnsafeAccessor"
description: "Ejemplo ejecutable de .NET 8 que expone un campo readonly con UnsafeAccessor, con límites explícitos de mutación y comportamiento observado."
pubDate: 2023-11-02
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Un unsafe accessor de .NET 8 puede exponer por referencia un campo de instancia, incluso si está declarado `readonly`. Escribir mediante esa referencia evita las reglas normales de asignación de C#. No cambia la declaración ni establece garantías generales sobre lecturas optimizadas de estado inmutable.

**Corrección — 2 de noviembre de 2026:** se restauró el ejemplo inaccesible. Se eliminaron la afirmación general de rendimiento y el resultado incondicional de lectura directa; el ejemplo verificado observa el valor mediante el accessor.

## Ejemplo ejecutable

[Descarga el ejemplo completo](/examples/unsafe-accessor.zip). Incluye demostraciones de miembros privados y este caso readonly:

```cs
using System.Runtime.CompilerServices;

var holder = new ReadonlyHolder();
Accessors.ReadonlyField(holder) = 42;
Console.WriteLine(Accessors.ReadonlyField(holder)); // 42 in the verified run

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}
```

Ejecuta el proyecto descargado con `dotnet run -c Release`. El ejemplo completo comprueba el valor inicial, realiza la escritura y verifica el resultado del accessor en .NET 8.0.33.

## Qué demuestra

La firma coincide con el tipo declarante, nombre y tipo del campo. Devolver `ref int` permite la asignación mostrada. No hace que escrituras por referencias ajenas, mutaciones concurrentes o todas las optimizaciones JIT/AOT se comporten igual. Una lectura directa en otra parte no debe convertirse en una promesa universal de que la mutación está admitida.

Para el estado de la aplicación, prefiere inicialización en el constructor o una API explícitamente mutable. Las escrituras por reflexión a campos de instancia y los campos static readonly también tienen restricciones distintas del runtime; no son casos intercambiables.

Consulta la [guía de acceso a miembros](/es/2023/10/unsafe-accessor/) para accessors habituales y el [proyecto benchmark](/es/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) para comparar rutas de llamada. La [referencia oficial](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) describe firmas y límites de versión.
