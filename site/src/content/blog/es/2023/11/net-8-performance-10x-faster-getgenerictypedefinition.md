---
title: "Rendimiento de GetGenericTypeDefinition en .NET 8: benchmark reproducible"
description: "Reproduce llamadas repetidas a GetGenericTypeDefinition con BenchmarkDotNet y compara runtimes .NET seleccionados sin asumir una aceleración fija."
pubDate: 2023-11-05
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
Microsoft documentó mejoras en la gestión de información de tipos genéricos en .NET 8, incluido almacenar el resultado de `GetGenericTypeDefinition` en el objeto `Type`. Es una optimización concreta del runtime, no un multiplicador fijo para cualquier trabajo de reflexión.

**Corrección — 2 de noviembre de 2026:** se retiraron el antiguo título «10x» y la tabla sin atribución porque no están disponibles los artefactos de ejecución ni el repositorio originales. Se conserva la URL histórica y ahora se mantiene un benchmark ejecutable con este sitio.

## Restaurar el benchmark

[Descarga el proyecto fuente](/examples/generic-type-definition-benchmarks.zip). Se compila para .NET 7 y .NET 8 y fija BenchmarkDotNet 0.13.12. El trabajo principal es:

```cs
public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```

El proyecto completo incluye imports y runner. Ejecuta la comprobación funcional y las mediciones normales:

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --filter '*'
```

La comprobación funcional verifica que el resultado es `typeof(List<>)`. Un job Dry permite comprobar rápidamente la ejecución, pero su tiempo no es un resultado de rendimiento fiable.

## Comparar .NET 7 y .NET 8

Instala ambos runtimes y selecciónalos explícitamente:

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

La comparación histórica exige esos runtimes reales; ejecutar una aplicación dirigida a .NET 8 en un runtime posterior no reproduce mediciones de .NET 8. Conserva los detalles de entorno y los informes generados junto a cualquier resultado publicado.

Este benchmark mide llamadas repetidas sobre un `Type` conocido. No mide carga de tipos, descubrimiento sin caché ni una aplicación completa. El [análisis de rendimiento de .NET 8 de Microsoft](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/) explica la optimización y aporta sus propias mediciones, separadas de la verificación de este proyecto.

Para otro trabajo de reflexión, consulta la [comparación de UnsafeAccessor](/es/2023/11/net-8-performance-unsafeaccessor-vs-reflection/).
