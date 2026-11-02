---
title: "Rendimiento de .NET 8: UnsafeAccessor frente a reflexión"
description: "Benchmark reproducible de .NET 8 con UnsafeAccessor, reflexión, reflexión almacenada, delegados almacenados y llamadas directas con trabajo observable."
pubDate: 2023-11-01
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
Un `UnsafeAccessor` se vincula a un miembro conocido sin buscarlo por reflexión ni usar `MethodInfo.Invoke`. Una comparación útil debe mantener observable el trabajo de destino y explicar qué hace cada ruta.

**Corrección — 2 de noviembre de 2026:** el antiguo repositorio no está disponible. Se restauró el ejemplo con comprobación funcional, diagnóstico de asignaciones, delegados almacenados y métodos de destino equivalentes sin inlining. Los tiempos anteriores cercanos a cero no demuestran sobrecoste cero universal y ya no se presentan como mediciones reproducibles.

## Descargar y ejecutar

[Descarga el código del benchmark](/examples/unsafe-accessor-benchmarks.zip). El proyecto apunta a .NET 8 y fija BenchmarkDotNet 0.15.8.

```sh
dotnet run -c Release -- --verify
dotnet run -c Release -- --job Dry --filter '*'
dotnet run -c Release -- --filter '*'
```

El primer comando comprueba que las cinco rutas devuelven `59` para la entrada `42`. El segundo verifica la ejecución con una iteración. Usa el último para mediciones normales y conserva los archivos generados de entorno e informes antes de interpretar los tiempos.

## Qué se compara

1. **Llamada directa:** invoca un método público.
2. **Unsafe accessor:** se vincula a un método privado con la misma operación.
3. **Búsqueda e invocación por reflexión:** busca e invoca el método en cada operación.
4. **Reflexión almacenada:** reutiliza `MethodInfo`, pero sigue aportando un array de objetos como argumentos.
5. **Delegado almacenado:** reutiliza un delegado de instancia abierto para el método privado.

Los dos métodos de destino devuelven la entrada más un campo de instancia y usan `MethodImplOptions.NoInlining`. Cada benchmark devuelve el resultado. La entrada es un parámetro de BenchmarkDotNet, evitando reducir el ejemplo a un método inline que devuelve una constante.

`MemoryDiagnoser` informa de asignaciones, incluido el array de argumentos y el boxing en los casos de reflexión. Las rutas hacen trabajo distinto; una diferencia temporal no corresponde únicamente a la comprobación de acceso.

## Verificación e interpretación

El proyecto restaurado se ejecutó con .NET 8.0.33 en macOS arm64. Pasaron la comprobación funcional y los cinco jobs Dry de BenchmarkDotNet. Sus tiempos no se publican como tabla de rendimiento: validan el arnés, no una estimación estable de nanosegundos.

Inlining, versión del runtime, arquitectura, trabajo de destino, caché y asignaciones influyen en los resultados. Un tiempo diminuto puede indicar que el JIT eliminó trabajo o que la medición está por debajo de la resolución útil del arnés. No demuestra que toda operación del accessor sea gratuita.

Un accessor también necesita conocer la firma al compilar. La reflexión sigue siendo útil si el tipo o miembro se descubre en ejecución. Consulta los [ejemplos de acceso a miembros](/es/2023/10/unsafe-accessor/) y la [referencia de Microsoft](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) para esa distinción.
