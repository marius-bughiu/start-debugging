---
title: "MSTest 4.4.1 corrige las llamadas ambiguas a Assert con CS0121 que 4.4.0 rompió por debajo de C# 14"
description: "MSTest 4.4.0 agregó sobrecargas de Span<T> y ReadOnlySpan<T> a Assert.Contains y Assert.DoesNotContain, lo que hizo que aserciones comunes sobre arrays y cadenas fallaran con CS0121 en net8.0, net9.0 o cualquier proyecto por debajo de C# 14. MSTest 4.4.1, publicado el 2026-09-16, agrega sobrecargas exactas para arrays y reenviadores con restricciones. Dos formas de llamada con genérico explícito siguen fallando."
pubDate: 2026-09-17
tags:
  - "mstest"
  - "testing"
  - "csharp"
  - "dotnet"
  - "breaking-changes"
lang: "es"
translationOf: "2026/09/mstest-4-4-1-fixes-cs0121-ambiguous-assert-calls-below-csharp-14"
translatedBy: "claude"
translationDate: 2026-09-17
---

Si actualizaste MSTest a 4.4.0 en un proyecto que apunta a `net8.0` o `net9.0`, es posible que tu proyecto de pruebas haya dejado de compilar en líneas que no habían cambiado en años. [MSTest 4.4.1](https://github.com/microsoft/testfx/releases/tag/v4.4.1), publicado en NuGet el 2026-09-16, lo corrige. Aquí está qué se rompió, la matriz de versiones que medí y las dos formas de llamada que 4.4.1 todavía no cubre.

## Sobrecargas de Span que solo C# 14 puede ordenar

MSTest 4.4.0 agregó sobrecargas de `Span<T>` y `ReadOnlySpan<T>` junto a las de `IEnumerable<T>` ya existentes en `Assert.Contains` y `Assert.DoesNotContain`. En C# 14, las conversiones de span de primera clase le dan al compilador reglas de desempate para arrays y cadenas, así que elige una sobrecarga. Por debajo de C# 14, la conversión de `T[]` a `Span<T>` es solo un `op_Implicit` definido por el usuario, y ninguna sobrecarga es mejor que la otra. El [issue #11022](https://github.com/microsoft/testfx/issues/11022) lo reportó al día siguiente de que salió 4.4.0:

```text
error CS0121: The call is ambiguous between the following methods or properties:
'Assert.Contains<T>(T, System.Collections.Generic.IEnumerable<T>, string?, string, string)' and
'Assert.Contains<T>(T, System.Span<T>, string?, string, string)'
```

Como `net8.0` usa C# 12 por defecto y `net9.0` usa C# 13, esos TFM se rompen sin tocar nada. Lo mismo pasa con un proyecto `net10.0` fijado a un `LangVersion` más antiguo.

## La matriz de versiones

Compilé el mismo archivo contra cada versión con el SDK 10.0.302:

```csharp
int[] ids = [1, 2, 3];
string name = "Marius";

Assert.Contains(2, ids);
Assert.DoesNotContain(4, ids);
Assert.DoesNotContain('z', name);
Assert.Contains<int>(2, ids);
```

| MSTest | Destino / lenguaje | Resultado |
| --- | --- | --- |
| 4.3.3 | `net8.0`, `net10.0` | compila |
| 4.4.0 | `net10.0` (C# 14) | compila |
| 4.4.0 | `net8.0`, `net9.0` o `net10.0` con `LangVersion` 12 | 4 x `CS0121` |
| 4.4.0 | `net8.0` con `LangVersion` 14 | compila |
| 4.4.1 | `net8.0`, `net10.0` | compila |

Las cuatro llamadas fallan en 4.4.0, incluidas la explícita `Contains<int>` y la del caso `string`. La única solución alternativa en 4.4.0 es subir `LangVersion` a 14 en un TFM más antiguo, que no es una combinación soportada. Actualizar es la solución real:

```xml
<PackageReference Include="MSTest" Version="4.4.1" />
```

Si usas `MSTest.Sdk`, sube la versión en `global.json` o en el atributo `Sdk="MSTest.Sdk/4.4.1"`.

## Cómo lo corrige 4.4.1 y qué deja fuera

El [PR #11038](https://github.com/microsoft/testfx/pull/11038) agrega sobrecargas exactas de `T[]` a cada familia de `Assert` afectada. Una coincidencia exacta le gana a ambas conversiones, así que las llamadas inferidas y explícitas sobre arrays vuelven a resolverse. También agrega reenviadores con restricciones que mantienen funcionando las llamadas inferidas para otros tipos que se convierten a span, como `string`, `ArraySegment<T>` y tus propias colecciones. Reenvían al código existente de `IEnumerable<T>`, así que el comportamiento coincide con 4.3.3.

El PR indica que las llamadas con `<T>` explícito sobre tipos que no son arrays quedan fuera del alcance, y mi prueba en 4.4.1 con `net8.0` lo confirma:

```csharp
var seg = new ArraySegment<int>(ids);
Assert.Contains(2, seg);           // OK
Assert.Contains(2, ids.AsSpan());  // OK
Assert.Contains<int>(2, seg);      // CS0121
Assert.Contains<char>('M', name);  // CS0121
```

Quita el argumento de tipo y deja que la inferencia elija el reenviador, o haz un cast a `IEnumerable<T>`.

La misma versión también reduce lo que el generador de código fuente de MSTest marca como raíz para el recorte (trimming) y Native AOT, y corrige los literales generados para enums, tipos enteros pequeños, `NaN` y caracteres de control. Si activaste el generador después de que [MSTest 4.4 lo sacó de la fase experimental](/es/2026/09/mstest-4-4-native-aot-source-generation/), esa es una segunda razón para adoptar 4.4.1.
