---
title: "MSTest 4.4 gradúa el generador de código fuente de reflexión, y los proyectos Native AOT lo obtienen automáticamente"
description: "MSTest 4.4 saca a MSTest.SourceGeneration del estado experimental y lo alinea con la versión de MSTest. Los proyectos de pruebas Native AOT lo incorporan sin opt-in, el modo ReflectionFree ya puede omitir la detección en runtime para [TestMethod] y [DataRow] simples, y cinco diagnósticos AOTSG te dicen qué formas de prueba no sobreviven."
pubDate: 2026-09-04
tags:
  - "mstest"
  - "native-aot"
  - "testing"
  - "source-generators"
  - "dotnet"
lang: "es"
translationOf: "2026/09/mstest-4-4-native-aot-source-generation"
translatedBy: "claude"
translationDate: 2026-09-04
---

Microsoft publicó ["Test what you ship: MSTest and Native AOT"](https://devblogs.microsoft.com/dotnet/mstest-source-generation/) el 3 de septiembre de 2026, y el argumento del título es justamente el punto. Si implementas tu aplicación con `PublishAot`, tu CI ha estado validando un binario distinto al que ejecutan tus usuarios: el host de pruebas se carga sobre CoreCLR con reflexión completa, así que un miembro que el trimmer habría eliminado sigue estando ahí cuando corre la aserción. La falla aparece en producción.

MSTest 4.3 incluyó una solución para eso en el paquete experimental `MSTest.SourceGeneration`, versionado de forma independiente. MSTest 4.4 lo gradúa: el paquete pierde la etiqueta de experimental y pasa a la línea de versión de MSTest, y `MSTest.Sdk` mantiene alineadas las versiones de `MSTest.SourceGeneration`, `MSTest.TestFramework` y `MSTest.TestAdapter` a través de `MSTestVersion`.

## Los proyectos Native AOT obtienen el generador sin opt-in

Un proyecto de pruebas que define `PublishAot` ahora incorpora el generador automáticamente:

```xml
<Project Sdk="MSTest.Sdk/4.4.0">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

El código de prueba en sí no cambia. Los miembros `[TestClass]` y `[TestMethod]` de siempre se quedan como están, y el generador emite el registro, los datos de atributos y los delegados de invocación en tiempo de compilación, antes de que corra el trimmer.

Para un proyecto que no es Native AOT y usa `MSTest.Sdk`, el generador es opcional:

```xml
<EnableMSTestSourceGeneration>true</EnableMSTestSourceGeneration>
```

Eso también funciona en bibliotecas de prueba reutilizables y bajo Central Package Management, donde el SDK genera los elementos `PackageVersion` correspondientes. No funciona en .NET Standard: los hooks de runtime de `MSTest.TestAdapter` que se necesitan no existen ahí, y el SDK falla la compilación con un error explícito en lugar de producir un registro roto.

## La detección en tiempo de compilación cambia una regla

Como la detección ocurre en tiempo de compilación, `[TestClass]` tiene que estar declarado en la clase misma. Heredarlo de una clase base antes funcionaba con reflexión y ahora no produce nada, en silencio. El analizador [MSTEST0069](https://learn.microsoft.com/en-us/dotnet/core/testing/mstest-analyzers/mstest0069) marca exactamente ese caso, que es la diferencia entre una advertencia de compilación y una ejecución de CI que reporta cero pruebas y termina en verde.

## Qué cubre realmente ReflectionFree en 4.4

`MSTestSourceGenMode` tiene `ReflectionFree` como valor por defecto para proyectos con trimming y Native AOT desde MSTest 4.3.2. En un runtime que todavía tiene reflexión, recurre al respaldo para todo lo que el generador no cubrió.

4.4 amplía el conjunto cubierto. La generación sin reflexión ahora materializa los metadatos completos de atributos heredados, incluidos `AttributeUsage` y `AllowMultiple`, y sobre [Microsoft.Testing.Platform](/es/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) puede omitir por completo la detección y validación en runtime para métodos `[TestMethod]` y `[DataRow]` síncronos simples. Las pruebas asíncronas, los atributos de método de prueba personalizados, `DynamicData`, las implementaciones propias de `ITestDataSource` y las formas ambiguas siguen tomando la ruta de respaldo. VSTest conserva su ruta existente en cualquier caso.

Cinco diagnósticos te dicen qué no puede generar el modo sin reflexión: `AOTSG0001` clase de prueba estática, `AOTSG0002` clase de prueba genérica abierta (incluida una anidada en un tipo genérico), `AOTSG0003` una clase que el código generado no puede alcanzar, como una clase file-local o anidada como privada, `AOTSG0004` método de prueba genérico y `AOTSG0005` un método de prueba con un parámetro `ref`, `in` u `out`.

Si algo se rompe y necesitas hacer bisección, hay una salida de emergencia que mantiene la detección pero restaura la ejecución por reflexión:

```xml
<PropertyGroup>
  <MSTestSourceGenMode>Rooting</MSTestSourceGenMode>
</PropertyGroup>
```

Una advertencia que vale la pena leer antes de reescribir un pipeline: el comportamiento de 4.4 está por ahora solo en compilaciones preliminares, hasta que salga MSTest 4.4.0. La [documentación de configuración del SDK de MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-sdk) tiene la lista completa de propiedades.
