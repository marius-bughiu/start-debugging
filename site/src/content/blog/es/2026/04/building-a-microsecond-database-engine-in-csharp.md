---
title: "Construyendo un motor de base de datos de latencia de microsegundos en C#"
description: "El proyecto Typhon de Loic Baumann apunta a commits ACID de 1-2 microsegundos usando ref structs, intrínsecos de hardware y memoria fijada, demostrando que C# puede competir a nivel de programación de sistemas."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "database"
lang: "es"
translationOf: "2026/04/building-a-microsecond-database-engine-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

La suposición de que los motores de base de datos de alto rendimiento requieren C, C++ o Rust está profundamente arraigada. El [proyecto Typhon](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) de Loic Baumann la desafía directamente: un motor de base de datos ACID embebido escrito en C#, apuntando a commits transaccionales de 1-2 microsegundos. El proyecto recientemente [llegó a la portada de Hacker News](https://news.ycombinator.com/item?id=47720060), provocando un debate animado sobre lo que .NET moderno puede hacer realmente.

## El kit de herramientas de rendimiento en C# moderno

El argumento central de Baumann es que el cuello de botella en el diseño de motores de base de datos es la disposición de memoria, no la elección del lenguaje. C# moderno proporciona las herramientas para controlar la memoria a un nivel que habría sido imposible hace una década.

Los tipos `ref struct` viven exclusivamente en la pila, eliminando asignaciones en el heap en rutas calientes:

```csharp
ref struct TransactionContext
{
    public Span<byte> WriteBuffer;
    public int PageIndex;
    public bool IsDirty;
}
```

Para regiones de memoria que nunca deben moverse, `GCHandle.Alloc` con `GCHandleType.Pinned` mantiene al recolector de basura fuera de las secciones críticas. Combinado con `[StructLayout(LayoutKind.Explicit)]`, obtienes control a nivel de C sobre cada offset de byte:

```csharp
[StructLayout(LayoutKind.Explicit, Size = 64)]
struct PageHeader
{
    [FieldOffset(0)]  public long PageId;
    [FieldOffset(8)]  public long TransactionId;
    [FieldOffset(16)] public int RecordCount;
    [FieldOffset(20)] public PageFlags Flags;
}
```

## Intrínsecos de hardware para rutas calientes

El namespace `System.Runtime.Intrinsics` da acceso directo a las instrucciones SIMD. Para un motor de base de datos escaneando páginas o computando checksums, esta es la diferencia entre "suficientemente rápido" y "competitivo con C":

```csharp
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

static unsafe uint Crc32Page(byte* data, int length)
{
    uint crc = 0;
    int i = 0;
    for (; i + 8 <= length; i += 8)
        crc = Sse42.Crc32(crc, *(ulong*)(data + i));
    for (; i < length; i++)
        crc = Sse42.Crc32(crc, data[i]);
    return crc;
}
```

## Forzando la disciplina en tiempo de compilación

Uno de los aspectos más interesantes del enfoque de Typhon es usar analizadores de Roslyn como rieles de seguridad. Los analizadores personalizados imponen reglas específicas del dominio (sin asignaciones accidentales en el heap en código transaccional, sin aritmética de punteros sin chequear fuera de módulos aprobados) en tiempo de compilación, en lugar de depender de la revisión de código.

Los genéricos restringidos con `where T : unmanaged` proporcionan otra capa, asegurando que las estructuras de datos genéricas funcionen solo con tipos blittable que tienen disposiciones de memoria predecibles.

## Lo que esto significa para .NET

Typhon todavía no es una base de datos de producción. Pero el proyecto demuestra que la brecha entre C# y los lenguajes de sistemas tradicionales se ha estrechado significativamente. Entre `Span<T>`, los intrínsecos de hardware, `ref struct` y el control explícito de la disposición de memoria, .NET 10 te da los bloques de construcción para trabajo de sistemas crítico en rendimiento sin abandonar el ecosistema gestionado.

El [análisis completo](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) vale la pena leerlo por los detalles arquitectónicos y los benchmarks.
