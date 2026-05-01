---
title: ".NET 9: el fin de lock(object)"
description: ".NET 9 introduce System.Threading.Lock, una primitiva de sincronización ligera y dedicada que reemplaza lock(object) con mejor rendimiento y una intención más clara."
pubDate: 2026-01-02
tags:
  - "dotnet"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/net-9-the-end-of-lockobject"
translatedBy: "claude"
translationDate: 2026-05-01
---
Durante casi dos décadas, los desarrolladores de C# se han apoyado en un patrón sencillo para la sincronización de hilos: crear una instancia privada de `object` y pasarla a la sentencia `lock`. Aunque efectivo, este enfoque conlleva costos ocultos de rendimiento que .NET 9 finalmente elimina con la introducción de `System.Threading.Lock`.

## El costo oculto de `Monitor`

Cuando escribes `lock (myObj)`, el compilador lo traduce en llamadas a `System.Threading.Monitor.Enter` y `Monitor.Exit`. Este mecanismo se apoya en el encabezado del objeto (object header word), un fragmento de metadatos asociado a cada tipo de referencia en el heap administrado.

Usar un `object` estándar para bloquear obliga al runtime a:

1.  Asignar un objeto en el heap solo por su identidad.
2.  Inflar el encabezado del objeto para acomodar información de sincronización (el "sync block") cuando hay contención.
3.  Aumentar la presión sobre el recolector de basura (GC), incluso si el objeto nunca se escapa de la clase.

En escenarios de alto rendimiento, estas micro-asignaciones y manipulaciones de encabezado se acumulan.

## Llega `System.Threading.Lock`

.NET 9 introduce un tipo dedicado: `System.Threading.Lock`. No es solo un envoltorio sobre `Monitor`; es una primitiva de sincronización ligera diseñada específicamente para la exclusión mutua.

Cuando el compilador de C# 13 encuentra una sentencia `lock` que apunta a una instancia de `System.Threading.Lock`, genera código distinto. En lugar de `Monitor.Enter`, llama a `Lock.EnterScope()`, que devuelve una struct `Lock.Scope`. Esta struct implementa `IDisposable` para liberar el lock, garantizando la seguridad entre hilos incluso si ocurren excepciones.

### Antes vs. después

Aquí está el enfoque tradicional que estamos dejando atrás:

```cs
public class LegacyCache
{
    // The old way: allocating a heap object just for locking
    private readonly object _syncRoot = new();
    private int _count;

    public void Increment()
    {
        lock (_syncRoot) // Compiles to Monitor.Enter(_syncRoot)
        {
            _count++;
        }
    }
}
```

Y aquí está el patrón moderno en .NET 9:

```cs
using System.Threading;

public class ModernCache
{
    // The new way: a dedicated lock instance
    private readonly Lock _sync = new();
    private int _count;

    public void Increment()
    {
        // C# 13 recognizes this type and optimizes the IL
        lock (_sync) 
        {
            _count++;
        }
    }
}
```

## Por qué importa

Las mejoras son estructurales:

1.  **Intención más clara**: el nombre del tipo `Lock` declara explícitamente su propósito, a diferencia de un `object` genérico.
2.  **Rendimiento**: `System.Threading.Lock` evita la sobrecarga del sync block del encabezado del objeto. Usa una implementación interna más eficiente que reduce los ciclos de CPU al adquirir y liberar el lock.
3.  **Compatibilidad futura**: usar el tipo dedicado permite al runtime optimizar aún más la mecánica del bloqueo sin romper el comportamiento heredado de `Monitor`.

## Buenas prácticas

Esta característica requiere tanto **.NET 9** como **C# 13**. Si estás actualizando un proyecto existente, puedes reemplazar mecánicamente `private readonly object _lock = new();` por `private readonly Lock _lock = new();`. El compilador se encarga del resto.

No expongas la instancia `Lock` públicamente. Igual que con el viejo patrón con `object`, la encapsulación es clave para evitar interbloqueos provocados por código externo que bloquee tus primitivas internas de sincronización.

Para los desarrolladores que construyen sistemas de alta concurrencia, este pequeño cambio representa un paso significativo hacia adelante en la reducción de la sobrecarga del runtime.
