---
title: "Rider 2026.1 incluye un visor de ASM para la salida de JIT, ReadyToRun y NativeAOT"
description: "Rider 2026.1 agrega un plugin .NET Disassembler que te permite inspeccionar el código máquina generado por los compiladores JIT, ReadyToRun y NativeAOT sin salir del IDE."
pubDate: 2026-04-13
tags:
  - "rider"
  - "jetbrains"
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "es"
translationOf: "2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly"
translatedBy: "claude"
translationDate: 2026-04-25
---

JetBrains lanzó [Rider 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/rider-2026-1-released/) el 30 de marzo, y la incorporación principal de tooling para desarrolladores es un nuevo visor de ASM que renderiza el desensamblado nativo de tu código C# directamente dentro del IDE. El plugin soporta la salida de JIT, ReadyToRun (crossgen2) y NativeAOT (ilc) en x86/x64 y ARM64.

## Por qué mirar el ensamblador en primer lugar

El código .NET sensible al rendimiento, piensa en bucles calientes, rutas SIMD, o asignaciones pesadas en struct, a veces se comporta de manera diferente a lo que la fuente C# sugiere. El JIT podría desvirtualizar una llamada, los datos de PGO podrían inlinear un método que esperabas se mantuviera como llamada, o NativeAOT podría disponer los structs de una forma que mate tus suposiciones de línea de caché. Hasta ahora necesitabas herramientas externas como [SharpLab](https://sharplab.io), el `DisassemblyDiagnoser` de BenchmarkDotNet, o el [Disasmo](https://github.com/EgorBo/Disasmo) de Egor Bogatov para ver qué llega realmente a la CPU. Rider 2026.1 trae ese flujo de trabajo al editor.

## Comenzando

Instala el plugin desde **Settings > Plugins > Marketplace** buscando ".NET Disassembler". Requiere un proyecto .NET 6.0+. Una vez instalado, abre cualquier archivo C#, coloca el cursor sobre un método o propiedad, y abre **View > Tool Windows > ASM Viewer** (o haz clic derecho y selecciónalo del menú contextual). Rider compila el objetivo y muestra la salida del ensamblador automáticamente.

Toma un ejemplo simple:

```csharp
public static int Sum(int[] values)
{
    int total = 0;
    for (int i = 0; i < values.Length; i++)
        total += values[i];
    return total;
}
```

Con PGO habilitado y la compilación por niveles activa, el JIT en .NET 10 vectorizará ese bucle en instrucciones SIMD. El visor de ASM te muestra las instrucciones `vpaddd` y `vmovdqu` que prueban que realmente sucedió, justo al lado de tu código fuente.

## Snapshot y diff

El plugin soporta snapshots. Puedes capturar la salida actual del ensamblador, hacer un cambio de código, y luego comparar las dos lado a lado. Esto es útil cuando quieres verificar que una pequeña refactorización (digamos, cambiar de `Span<T>` a `ReadOnlySpan<T>`, o agregar un atributo `[MethodImpl(MethodImplOptions.AggressiveInlining)]`) realmente cambia el código generado de la forma esperada.

## Opciones de configuración

La barra de herramientas en el visor de ASM te permite alternar:

- **Compilación por niveles** activada o desactivada
- **PGO** (optimización guiada por perfil)
- **Salida amigable para diff** que estabiliza direcciones para comparaciones más limpias
- Objetivo del compilador: JIT, ReadyToRun o NativeAOT

Alternar entre la salida de JIT y NativeAOT para el mismo método es una forma rápida de ver cuánto divergen los dos pipelines para tus patrones de código específicos.

## Dónde encaja esto

El visor de ASM no reemplaza a BenchmarkDotNet para medir el throughput real. Lo complementa. Cuando un benchmark muestra una regresión inesperada, el visor te da una ruta rápida hacia "¿qué cambió en el código generado?" sin cambiar herramientas ni escribir un arnés separado. El plugin está basado en el [proyecto Disasmo](https://github.com/EgorBo/Disasmo) de Egor Bogatov y está disponible en Windows, macOS y Linux. Detalles completos en el [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/29736--net-disassembler).
