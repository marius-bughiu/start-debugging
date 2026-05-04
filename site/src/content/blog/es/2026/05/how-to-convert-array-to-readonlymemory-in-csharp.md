---
title: "Cómo convertir T[] a ReadOnlyMemory<T> en C# (operador implícito y constructor explícito)"
description: "Tres formas de envolver un T[] en un ReadOnlyMemory<T> en .NET 11: la conversión implícita, el constructor explícito y AsMemory(). Cuándo cada una es la opción correcta."
pubDate: 2026-05-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
template: "how-to"
lang: "es"
translationOf: "2026/05/how-to-convert-array-to-readonlymemory-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-04
---

Si solo quieres una vista `ReadOnlyMemory<T>` sobre un arreglo existente, el camino más corto es la conversión implícita: `ReadOnlyMemory<byte> rom = bytes;`. Si necesitas un segmento, prefiere `bytes.AsMemory(start, length)` o `new ReadOnlyMemory<byte>(bytes, start, length)`. Las tres no asignan memoria, pero solo el constructor y `AsMemory` aceptan un offset y una longitud, y solo el constructor es explícito en el sitio de la llamada (lo cual importa en revisiones de código).

Versiones referenciadas en este post: .NET 11 (runtime), C# 14. `System.Memory` viene como parte de `System.Runtime` en .NET moderno, así que no se necesita ningún paquete adicional.

## Por qué hay más de un camino de conversión

`ReadOnlyMemory<T>` está en la BCL desde .NET Core 2.1 (y en el paquete NuGet `System.Memory` en .NET Standard 2.0). Microsoft añadió varios puntos de entrada a propósito: uno sin fricción para el caso del 90%, un constructor explícito para código que necesita destacar la conversión, y un método de extensión que refleja `AsSpan()` para que puedas alternar mentalmente entre span y memory sin cambiar de contexto.

Concretamente, la BCL expone:

1. Una conversión implícita de `T[]` a `Memory<T>` y de `T[]` a `ReadOnlyMemory<T>`.
2. Una conversión implícita de `Memory<T>` a `ReadOnlyMemory<T>`.
3. El constructor `new ReadOnlyMemory<T>(T[])` y la sobrecarga con segmentación `new ReadOnlyMemory<T>(T[] array, int start, int length)`.
4. Los métodos de extensión `AsMemory<T>(this T[])`, `AsMemory<T>(this T[], int start)`, `AsMemory<T>(this T[], int start, int length)` y `AsMemory<T>(this T[], Range)` definidos en `MemoryExtensions`.

Cada camino está libre de asignaciones. La elección es mayormente estilística, con dos distinciones reales: solo el constructor y `AsMemory` aceptan un segmento, y solo la conversión implícita permite que un argumento `T[]` fluya hacia un parámetro `ReadOnlyMemory<T>` sin que quien llama escriba nada.

## El ejemplo mínimo

```csharp
// .NET 11, C# 14
using System;

byte[] payload = "hello"u8.ToArray();

// Path 1: implicit operator
ReadOnlyMemory<byte> a = payload;

// Path 2: explicit constructor, full array
ReadOnlyMemory<byte> b = new ReadOnlyMemory<byte>(payload);

// Path 3: explicit constructor, slice
ReadOnlyMemory<byte> c = new ReadOnlyMemory<byte>(payload, start: 1, length: 3);

// Path 4: AsMemory extension, full array
ReadOnlyMemory<byte> d = payload.AsMemory();

// Path 5: AsMemory extension, slice with start + length
ReadOnlyMemory<byte> e = payload.AsMemory(start: 1, length: 3);

// Path 6: AsMemory extension, range
ReadOnlyMemory<byte> f = payload.AsMemory(1..4);
```

Las seis producen instancias `ReadOnlyMemory<byte>` que apuntan al mismo arreglo subyacente. Ninguna copia el arreglo. Las seis son seguras en bucles ajustados porque el costo es una pequeña copia de struct, no una copia de buffer.

## Cuándo el operador implícito es la opción correcta

La conversión implícita de `T[]` a `ReadOnlyMemory<T>` es la más limpia en sitios de llamada donde el tipo de destino ya es un parámetro `ReadOnlyMemory<T>`:

```csharp
// .NET 11
public Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
{
    // ...
    return Task.CompletedTask;
}

byte[] payload = GetPayload();
await WriteAsync(payload); // implicit conversion happens here
```

No escribes `payload.AsMemory()` ni `new ReadOnlyMemory<byte>(payload)`. El compilador emite la conversión por ti. Esto importa de dos formas: el sitio de la llamada se mantiene legible en código caliente, y tu API puede tomar `ReadOnlyMemory<T>` sin obligar a cada llamador a aprender un tipo nuevo.

La contrapartida es que la conversión es invisible. Si quieres que un revisor de código note "este código ahora pasa una vista `ReadOnlyMemory<T>` en lugar de un arreglo", el operador implícito lo oculta.

## Cuándo el constructor vale su verbosidad

`new ReadOnlyMemory<byte>(payload, start, length)` es la forma explícita. Recurres a él en tres situaciones:

1. **Necesitas un segmento con offset y longitud.** La conversión implícita siempre cubre el arreglo completo.
2. **Quieres que el sitio de la llamada haga visible la conversión.** Un campo como `private ReadOnlyMemory<byte> _buffer;` inicializado por el constructor es más fácil de buscar que un operador implícito.
3. **Quieres que el compilador verifique los límites del offset y la longitud una vez, en la construcción.** Todos los caminos verifican los límites eventualmente, pero el constructor acepta `start` y `length` como parámetros y lanza `ArgumentOutOfRangeException` de inmediato si caen fuera del arreglo, antes de que cualquier consumidor toque la memoria.

```csharp
// .NET 11
byte[] frame = ReceiveFrame();
const int headerLength = 16;

// Skip the header. Bounds-checked here, not when the consumer reads.
var payload = new ReadOnlyMemory<byte>(frame, headerLength, frame.Length - headerLength);

await ProcessAsync(payload);
```

Si `frame.Length < headerLength`, la `ArgumentOutOfRangeException` se lanza en el sitio de construcción, donde las variables locales todavía están en el ámbito y un depurador puede mostrarte cuánto era realmente `frame.Length`. Si difieres la segmentación a `ProcessAsync`, pierdes esa localidad y la falla aparece donde sea que el segmento se materialice finalmente.

## Cuándo usar `AsMemory()` en su lugar

`AsMemory()` es lo mismo que el constructor, con dos ventajas ergonómicas: se lee de izquierda a derecha (`payload.AsMemory(1, 3)` en lugar de `new ReadOnlyMemory<byte>(payload, 1, 3)`), y tiene una sobrecarga para `Range`, así que la sintaxis de segmentación de C# funciona:

```csharp
// .NET 11, C# 14
byte[] payload = GetPayload();
const int headerLength = 16;

ReadOnlyMemory<byte> body = payload.AsMemory(headerLength..);
ReadOnlyMemory<byte> first16 = payload.AsMemory(..headerLength);
ReadOnlyMemory<byte> middle = payload.AsMemory(8..24);
```

`AsMemory(Range)` devuelve `Memory<T>`, y la conversión a `ReadOnlyMemory<T>` aquí pasa por la conversión implícita de `Memory<T>` a `ReadOnlyMemory<T>`. Eso también está libre de asignaciones.

Si ya adoptaste mentalmente `AsSpan()` (el mismo patrón para `Span<T>`), `AsMemory()` es la versión de ese hábito que sobrevive a través de un `await`.

## Qué pasa con arreglos `null`

Pasar un arreglo `null` a la conversión implícita o a `AsMemory()` no lanza una excepción. Produce un `ReadOnlyMemory<T>` por defecto, que es semánticamente equivalente a `ReadOnlyMemory<T>.Empty` (`IsEmpty == true`, `Length == 0`):

```csharp
// .NET 11
byte[]? maybeNull = null;

ReadOnlyMemory<byte> a = maybeNull;            // default, not a NullReferenceException
ReadOnlyMemory<byte> b = maybeNull.AsMemory(); // also default
// new ReadOnlyMemory<byte>(maybeNull) also returns default
```

El constructor de un solo argumento `new ReadOnlyMemory<T>(T[]? array)` documenta esto explícitamente: una referencia nula produce un `ReadOnlyMemory<T>` con valor por defecto. El constructor de tres argumentos `new ReadOnlyMemory<T>(T[]? array, int start, int length)` sí lanza `ArgumentNullException` si el arreglo es null y especificas un start o length distintos de cero, porque los límites no pueden satisfacerse contra `null`.

Esta tolerancia a `null` es conveniente para cargas útiles opcionales, pero también es una trampa: un llamador que pase `null` recibirá silenciosamente un buffer vacío en lugar de un crash, lo que puede enmascarar un bug río arriba. Si tu método depende de que el arreglo no sea null, valida antes de envolver.

## Segmentar el resultado también es gratis

Una vez que tienes un `ReadOnlyMemory<T>`, llamar a `.Slice(start, length)` produce otro `ReadOnlyMemory<T>` sobre el mismo almacenamiento subyacente. No hay segunda copia ni segunda asignación:

```csharp
// .NET 11
ReadOnlyMemory<byte> all = payload.AsMemory();

ReadOnlyMemory<byte> head = all.Slice(0, 16);
ReadOnlyMemory<byte> body = all.Slice(16);
```

El struct `ReadOnlyMemory<T>` almacena una referencia al `T[]` original (o a un `MemoryManager<T>`), un offset dentro de ese almacenamiento y una longitud. Segmentar simplemente devuelve un struct nuevo con el offset y la longitud ajustados. Por eso los seis caminos de conversión anteriores son seguros de usar incluso en bucles ajustados: el costo es una copia de struct, no una copia de buffer.

## Volver de `ReadOnlyMemory<T>` a `Span<T>`

Dentro de un método síncrono usualmente quieres un span, no un memory:

```csharp
// .NET 11
public int CountZeroBytes(ReadOnlyMemory<byte> data)
{
    ReadOnlySpan<byte> span = data.Span; // allocation-free
    int count = 0;
    foreach (byte b in span)
    {
        if (b == 0) count++;
    }
    return count;
}
```

`.Span` es una propiedad de `ReadOnlyMemory<T>` que devuelve un `ReadOnlySpan<T>` sobre la misma memoria. Usa el span para el bucle interno, mantén el memory en campos y a través de fronteras `await`. La inversa (span a memory) intencionalmente no se proporciona porque los spans pueden vivir en la pila, donde un `Memory<T>` no puede llegar.

## Lo que no puedes hacer (y los rodeos)

`ReadOnlyMemory<T>` es genuinamente de solo lectura en lo que respecta a la API pública. No hay un `ToMemory()` público que devuelva el `Memory<T>` mutable subyacente. La salida de emergencia vive en `MemoryMarshal`:

```csharp
// .NET 11
using System.Runtime.InteropServices;

ReadOnlyMemory<byte> ro = payload.AsMemory();
Memory<byte> rw = MemoryMarshal.AsMemory(ro);
```

Esto es inseguro en el sentido de "el sistema de tipos te estaba diciendo algo". Recurre a esto solo cuando estés seguro de que ningún otro consumidor depende del contrato de solo lectura que acabas de romper, por ejemplo en una prueba unitaria o en código que posee el buffer de extremo a extremo.

`ReadOnlyMemory<T>` tampoco puede apuntar a un `string` mediante los caminos de conversión desde arreglos. `string.AsMemory()` devuelve un `ReadOnlyMemory<char>` que envuelve la cadena misma, no un `T[]`. Los caminos de conversión desde `T[]` cubiertos arriba no aplican a strings, pero el resto de la superficie de la API (segmentación, `Span`, igualdad) se comporta de forma idéntica.

## Cómo elegir uno en tu base de código

Un valor por defecto razonable en una base de código .NET 11:

- **En firmas de API**: toma `ReadOnlyMemory<T>`. Llamadores con un `T[]` lo pasarán tal cual (operador implícito), llamadores con un segmento pasarán `array.AsMemory(start, length)`. No renuncias a nada.
- **En sitios de llamada con un arreglo completo**: usa la conversión implícita, no escribas `.AsMemory()`. Es ruido.
- **En sitios de llamada con un segmento**: usa `array.AsMemory(start, length)` o `array.AsMemory(range)`. Evita `new ReadOnlyMemory<T>(array, start, length)` a menos que la explicitud en el sitio de la llamada sea precisamente el punto.
- **En rutas calientes**: no importa para el rendimiento. El JIT reduce los seis caminos a la misma construcción de struct. Elige el que se lea mejor.

## Relacionado

- [Cómo usar `SearchValues<T>` correctamente en .NET 11](/es/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) para búsquedas amigables con span que se complementan naturalmente con `ReadOnlyMemory<T>.Span`.
- [Cómo usar Channels en lugar de `BlockingCollection` en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) cuando quieres pipelines asíncronos que pasan cargas útiles `ReadOnlyMemory<T>`.
- [Cómo usar `IAsyncEnumerable<T>` con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) para patrones de streaming que combinan bien con vistas de memoria.
- [Cómo leer un CSV grande en .NET 11 sin quedarse sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) que se apoya fuertemente en segmentar sin copiar.
- [Cómo usar el nuevo tipo `System.Threading.Lock` en .NET 11](/es/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) para la primitiva de sincronización que querrás alrededor de `Memory<T>` mutable compartido entre hilos.

## Fuentes

- [Referencia de `ReadOnlyMemory<T>` (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1)
- [Referencia de `MemoryExtensions.AsMemory` (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.memoryextensions.asmemory)
- [Guías de uso de Memory<T> y Span<T> (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-span/)
- [Referencia de `MemoryMarshal.AsMemory` (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.asmemory)
