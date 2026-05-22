---
title: "C# 16 convierte unsafe en un contrato para quien llama"
description: "C# 16 rediseña la palabra clave unsafe para que propague una obligación al llamador en lugar de abrir silenciosamente un contexto unsafe, y ahora los bloques unsafe internos son obligatorios."
pubDate: 2026-05-22
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "memory-safety"
lang: "es"
translationOf: "2026/05/csharp-16-unsafe-keyword-caller-contract"
translatedBy: "claude"
translationDate: 2026-05-22
---

Richard Lander [presentó un rediseño](https://devblogs.microsoft.com/dotnet/improving-csharp-memory-safety/) de la palabra clave `unsafe` que cambia su significado después de 25 años. Hoy `unsafe` marca un detalle de implementación: conviertes un método o bloque en un contexto unsafe, escribes tu código de punteros y nadie que llame a ese método tiene idea de que está tocando código no seguro respecto a la memoria. El nuevo modelo, dirigido a **C# 16** como versión preliminar en **.NET 11** y producción en **.NET 12**, convierte `unsafe` en un contrato de cara a quien llama. La motivación es en parte el auge del código generado por IA: una obligación de seguridad que existe solo como convención es invisible para quien revisa y para el modelo que escribe el código.

## Qué significa ahora la palabra clave

Bajo las reglas actuales, marcar un método como `unsafe` hace dos tareas no relacionadas a la vez: te permite escribir operaciones con punteros dentro y no exige nada a quienes llaman. El rediseño las separa.

`unsafe` en la firma de un miembro pasa a ser un contrato que se propaga. Quienes llaman deben envolver la invocación en un bloque `unsafe { }`, igual que debes envolver la desreferencia de un `pointer`. Y dentro de un método `unsafe`, las operaciones unsafe en sí siguen necesitando un bloque interno explícito. Ya no hay pase libre:

```csharp
/// <safety>
/// The sum of <paramref name="ptr"/> and <paramref name="ofs"/> must address
/// a byte the caller is permitted to read.
/// </safety>
public static unsafe byte ReadByte(IntPtr ptr, int ofs)
{
    // SAFETY: relies on caller obligation.
    unsafe { return ((byte*)ptr)[ofs]; }
}
```

El bloque de documentación `/// <safety>` es el lugar formal para anotar la obligación, y un analizador marca los miembros `unsafe` que no la tengan.

## Cumplir con la obligación

Un método que llama a una API `unsafe` tiene dos opciones: seguir propagando siendo `unsafe` él mismo, o convertirse en un límite seguro validando la precondición y luego envolviendo la llamada.

```csharp
void Caller2()
{
    if (!ObligationSatisfied()) throw new InvalidOperationException();
    unsafe { ReadByte(ptr, ofs); } // the guard discharges the contract
}
```

Ese es justamente el punto: el bloque `unsafe` es donde afirmas "he comprobado la precondición", así que debe ser pequeño y deliberado, no envolver un método entero.

## Menor superficie, valor por defecto más estricto

Algunas otras reglas endurecen el modelo. El modificador de tipo `unsafe` desaparece, por lo que la condición unsafe vive solo en métodos, propiedades y campos. Los tipos puntero ya no hacen unsafe una firma por sí solos; pasar un `byte*` está bien, desreferenciarlo es el acto unsafe. Y las declaraciones `extern` reciben un nuevo modificador `safe` para atestiguar que una P/Invoke es segura de llamar:

```csharp
[LibraryImport("libc")]
internal static safe partial int getpid();
```

La configuración del proyecto también se divide. La propiedad existente `<AllowUnsafeBlocks>` sigue controlando si la palabra clave `unsafe` compila siquiera, mientras que una nueva propiedad de adhesión selecciona el modelo de C# 16 sobre qué cuenta como unsafe. Omite ambas y obtienes la postura más estricta.

Nada de esto hace seguro el código de punteros por sí mismo. Como dice Lander, las palabras clave "no son la seguridad; son el andamiaje que lleva a los desarrolladores a articularla y honrarla". Si mantienes una biblioteca con rutas críticas cargadas de punteros, la versión preliminar es el momento de empezar a escribir bloques `<safety>`, porque en .NET 12 serán tus llamadores quienes se vean obligados a envolver tus APIs.
