---
title: "Zstandard vs Brotli vs Gzip para compresión de respuestas en .NET 11"
description: "Zstandard es el valor predeterminado correcto para respuestas dinámicas de API en .NET 11, pero no con la calidad que trae el proveedor de ASP.NET Core. Benchmarks sobre payloads JSON reales que muestran por qué la calidad 1 supera a la calidad 3 predeterminada tanto en tamaño como en CPU, cuándo Brotli sigue ganando y por qué Gzip solo sobrevive como alternativa de compatibilidad."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "compression"
  - "performance"
lang: "es"
translationOf: "2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Para respuestas dinámicas de API en .NET 11, usa Zstandard, que ya es el predeterminado, pero configura `Quality = 1` explícitamente en lugar de aceptar el valor por defecto del proveedor. En los payloads JSON que medí, Zstandard con calidad 1 comprimió 7.37x mientras que la calidad 3 predeterminada del proveedor solo alcanzó 6.66x, y la calidad 1 lo hizo con casi el doble de throughput. Brotli solo gana cuando puedes comprimir una vez y servir muchas veces, e incluso entonces solo con calidad 11, que cuesta 3.2 segundos por respuesta de 3 MB. Gzip ahora es puramente una alternativa de compatibilidad.

Todo lo que sigue apunta a .NET 11 (Preview 7 al momento de escribir esto, GA en noviembre de 2026) y C# 14. El proveedor Zstandard es nuevo en ASP.NET Core 11; Brotli y Gzip están en el middleware desde ASP.NET Core 2.1 y se comportan igual en .NET 8, 9 y 10.

## La matriz

| | Zstandard | Brotli | Gzip |
| --- | --- | --- | --- |
| Token `Accept-Encoding` | `zstd` | `br` | `gzip` |
| Especificación | [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878) | [RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932) | [RFC 1952](https://www.ietf.org/rfc/rfc1952.txt) |
| Incluido en `System.IO.Compression` desde | .NET 11 | .NET Core 2.1 | .NET Framework 2.0 |
| Registrado por defecto en ASP.NET Core 11 | Sí, primero | Sí, segundo | Sí, tercero |
| Nivel predeterminado del proveedor | calidad 3 | `CompressionLevel.Fastest` | `CompressionLevel.Fastest` |
| Rango de niveles | `MinQuality` (negativo) a 22 | 0 a 11 | 0 a 9 |
| Ratio sobre JSON de 292 KB (mejor nivel razonable) | 7.26x | 7.01x | 6.55x |
| Throughput de compresión en ese nivel | 572 MB/s | 215 MB/s | 208 MB/s |
| Throughput de descompresión | 3103 MB/s | 1134 MB/s | 1575 MB/s |
| Funciona en Blazor WebAssembly | No | Sí | Sí |
| Soporte de diccionarios | Entrenable (`ZstandardDictionary`) | Solo estático integrado | No |

Las dos filas que deciden la mayoría de las discusiones son el throughput de descompresión y la fila de WebAssembly. Todo lo demás está lo bastante parejo como para lanzar una moneda.

## Qué registra .NET 11 en realidad, y en qué orden

Si llamas a `AddResponseCompression()` sin nombrar proveedores, ASP.NET Core 11 registra tres, y el orden en [`ResponseCompressionProvider`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs) es el orden de preferencia del servidor:

```csharp
// ASP.NET Core 11, from ResponseCompressionProvider.cs
_providers = new ICompressionProvider[]
{
    new CompressionProviderFactory(typeof(ZstandardCompressionProvider)),
    new CompressionProviderFactory(typeof(BrotliCompressionProvider)),
    new CompressionProviderFactory(typeof(GzipCompressionProvider)),
};
```

Así que un navegador que envía `Accept-Encoding: gzip, deflate, br, zstd` recibe `Content-Encoding: zstd` de una aplicación ASP.NET Core 11 que nunca configuraste. En .NET 10 esa misma solicitud recibía `br`. Ese es todo el cambio visible para el usuario, y ocurre al actualizar sin editar una sola línea.

En el momento en que agregas un proveedor a mano, los valores predeterminados se desactivan por completo y solo tu lista queda activa. Esta es la forma más común de desactivar Zstandard por accidente creyendo que solo estabas habilitando la compresión sobre HTTPS.

## La calidad predeterminada es la calidad equivocada

Aquí está la parte que no aparece en las notas de la versión. `BrotliCompressionProviderOptions` y `GzipCompressionProviderOptions` usan ambos `CompressionLevel.Fastest` por defecto. El proveedor Zstandard no tiene una propiedad `Level` en absoluto. Tiene esto:

```csharp
// ASP.NET Core 11, from ZstandardCompressionProviderOptions.cs
public ZstandardCompressionOptions CompressionOptions { get; set; } = new();
```

Un `ZstandardCompressionOptions` recién creado deja `Quality` en `0`, y `0` significa "valor predeterminado definido por la implementación", que libzstd resuelve como nivel 3. Así que los proveedores Brotli y Gzip vienen ajustados para latencia mientras que el proveedor Zstandard viene con el valor equilibrado de libzstd. Nadie documentó esa asimetría, pero es lo que dice el código fuente.

Sería un detalle menor si la calidad 3 fuera simplemente una opción más lenta y más pequeña. No lo es. En los payloads JSON que medí, la calidad 3 es peor que la calidad 1 en **ambos** ejes:

| Calidad zstd | Tamaño del JSON de 2.88 MB | Ratio | Throughput de compresión |
| --- | --- | --- | --- |
| 1 | 409,809 B | 7.37x | 806 MB/s |
| 2 | 427,111 B | 7.07x | - |
| 3 (predeterminado del proveedor) | 453,130 B | 6.66x | 425 MB/s |
| 4 | 460,813 B | 6.55x | - |
| 5 | 449,750 B | 6.71x | - |
| 6 | 436,263 B | 6.92x | 159 MB/s |
| 9 | 422,148 B | 7.15x | - |
| 12 | 416,795 B | 7.24x | 54 MB/s |
| 19 | 362,100 B | 8.34x | - |

Lee esa columna otra vez. El ratio cae del nivel 1 al nivel 4, luego vuelve a subir, y no supera al nivel 1 de nuevo hasta el nivel 9. Pagar 1.9x de CPU para obtener un cuerpo 11% más grande es un mal negocio en cualquier dirección.

Esto no es un bug ni es específico de .NET. Los niveles de Zstandard no son un único dial: cada nivel selecciona una estrategia distinta de búsqueda de coincidencias, más sus propios parámetros de ventana, cadena, hash y coincidencia mínima. Preguntarle directamente a libzstd por los parámetros que usa muestra la discontinuidad:

```
level  1: strategy=1 (fast)   windowLog=19 chainLog=13 hashLog=14 minMatch=7
level  2: strategy=1 (fast)   windowLog=20 chainLog=15 hashLog=16 minMatch=6
level  3: strategy=2 (dfast)  windowLog=21 chainLog=16 hashLog=17 minMatch=5
level  4: strategy=2 (dfast)  windowLog=21 chainLog=18 hashLog=18 minMatch=5
level  5: strategy=3 (greedy) windowLog=21 chainLog=18 hashLog=19 minMatch=5
level  6: strategy=4 (lazy)   windowLog=21 chainLog=18 hashLog=19 minMatch=5
```

El salto del nivel 2 al nivel 3 baja `minMatch` de 6 a 5 y cambia de estrategia. Sobre texto con secuencias largas y muy repetitivas (claves JSON repetidas una vez por elemento del arreglo, una cadena `notes` idéntica en cada registro), la configuración del nivel 1 encuentra coincidencias menos numerosas pero más largas, que se codifican mejor por entropía. Esas tablas de niveles se ajustaron contra un corpus general, así que el orden se mantiene en promedio, no sobre tu payload.

La regla práctica: el nivel predeterminado de cualquier códec es una conjetura sobre datos que nunca ha visto. Mide las dos o tres formas reales de tus endpoints y fija la calidad.

## El benchmark

Payload: un arreglo JSON de registros de clientes, la forma que realmente devuelve un endpoint de listado. Determinista, para que puedas reproducirlo:

```csharp
// .NET 10 / .NET 11, C# 14
static Guid NextGuid(Random rnd)
{
    var b = new byte[16];
    rnd.NextBytes(b);
    return new Guid(b);
}

static byte[] MakeListPayload(int count, int seed)
{
    var rnd = new Random(seed);
    string[] cities = ["Bucharest", "Berlin", "Lisbon", "Warsaw", "Dublin", "Madrid", "Helsinki"];
    string[] statuses = ["active", "pending", "suspended", "closed"];
    var items = Enumerable.Range(1, count).Select(i => new
    {
        id = i,
        externalId = NextGuid(rnd).ToString(),
        name = $"Customer {i}",
        email = $"user{i}@example.com",
        city = cities[rnd.Next(cities.Length)],
        status = statuses[rnd.Next(statuses.Length)],
        balance = Math.Round(rnd.NextDouble() * 10000, 2),
        createdAt = new DateTime(2024, 1, 1).AddMinutes(i * 7).ToString("O"),
        tags = new[] { "vip", "eu", "newsletter" }.Take(rnd.Next(1, 4)).ToArray(),
        notes = "Imported from the legacy CRM during the 2024 migration."
    });
    return JsonSerializer.SerializeToUtf8Bytes(items);
}
```

Método: cada códec envuelve un `MemoryStream` exactamente como el middleware de compresión de respuestas envuelve el cuerpo de la respuesta, de modo que la preparación del codificador por respuesta queda dentro de la medición. Tres iteraciones de calentamiento, luego 60 iteraciones medidas para el payload de 292 KB y 15 para el de 2.88 MB, reportando la mediana. Máquina: Intel Core Ultra 7 265KF, Windows 11, .NET 10.0.5 x64.

Una advertencia honesta sobre el entorno. Mi máquina tiene solo el SDK 10.0.201, así que `System.IO.Compression.ZstandardStream` no estaba disponible para compilar. Las filas de Zstandard provienen de [ZstdSharp.Port](https://www.nuget.org/packages/ZstdSharp.Port) 0.8.8, un port administrado de la implementación de referencia. Dos cosas hacen defendible esa sustitución. Primero, .NET 11 incorpora [libzstd 1.5.7](https://github.com/dotnet/runtime/blob/main/src/native/external/zstd/lib/zstd.h), y verifiqué cada tamaño de salida de ZstdSharp contra libzstd 1.5.7 nativo sobre los mismos bytes: coinciden dentro del 0.05% (41,132 frente a 41,135 bytes con calidad 1, 43,644 frente a 43,647 con calidad 3). Por lo tanto, los tamaños comprimidos son los que producirá .NET 11. Segundo, el throughput es el número que no es transferible: libzstd nativo alcanzó 1092 MB/s con calidad 1 en este hardware donde el port administrado alcanzó 806 MB/s, así que trata la columna de velocidad de Zstandard como un piso, no como un techo.

**JSON de 292 KB (1 000 registros), 298,727 bytes en bruto:**

| códec | nivel | comprimido | ratio | comp MB/s | descomp MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 69,832 | 4.28x | 743 | 1488 |
| gzip | Optimal | 45,586 | 6.55x | 208 | 1575 |
| brotli | Fastest | 44,606 | 6.70x | 564 | 808 |
| brotli | Optimal | 42,610 | 7.01x | 215 | 1134 |
| brotli | q11 (SmallestSize) | 34,025 | 8.78x | 1 | 728 |
| zstd | q1 | 41,132 | 7.26x | 572 | 3103 |
| zstd | q3 (predeterminado del proveedor) | 43,644 | 6.84x | 276 | 1796 |
| zstd | q6 | 41,009 | 7.28x | 112 | 1735 |
| zstd | q12 | 38,881 | 7.68x | 20 | 1320 |

**JSON de 2.88 MB (10 000 registros), 3,018,756 bytes en bruto:**

| códec | nivel | comprimido | ratio | comp MB/s | descomp MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 697,252 | 4.33x | 712 | 1443 |
| gzip | Optimal | 452,661 | 6.67x | 204 | 1620 |
| brotli | Fastest | 447,954 | 6.74x | 786 | 726 |
| brotli | Optimal | 429,060 | 7.04x | 186 | 1088 |
| brotli | q11 (SmallestSize) | 341,338 | 8.84x | 1 | 842 |
| zstd | q1 | 409,805 | 7.37x | 806 | 3158 |
| zstd | q3 (predeterminado del proveedor) | 454,007 | 6.65x | 425 | 1914 |
| zstd | q6 | 436,263 | 6.92x | 159 | 1846 |
| zstd | q12 | 416,792 | 7.24x | 54 | 1891 |

Tres resultados sostienen toda la comparación.

**Zstandard con calidad 1 domina a Brotli `Fastest`.** Salida más pequeña (41,132 frente a 44,606 bytes), el mismo throughput de compresión (572 frente a 564 MB/s) y 3.8x el throughput de descompresión. No hay ningún eje en el que la configuración rápida de Brotli sea la mejor opción para una respuesta dinámica.

**Gzip `Fastest` no es competitivo en tamaño.** 69,832 bytes frente a los 41,132 de Zstandard es un cuerpo 70% más grande sin ventaja de throughput. Si sigues emitiendo `gzip` a clientes modernos, lo estás pagando en ancho de banda.

**Brotli q11 es una trampa en la ruta de solicitud.** Es genuinamente la salida más pequeña de la tabla, 8.78x, aproximadamente un 17% mejor que Zstandard con calidad 1. También tardó 272 milisegundos con el payload de 292 KB y 3.2 segundos con el de 2.88 MB. Eso es por respuesta. Cualquiera que mida "Brotli comprime mejor" y configure `SmallestSize` en una API en producción habrá agregado tres segundos de latencia limitada por CPU a cada respuesta grande.

## Cuándo elegir cada uno

**Zstandard, calidad 1** para cualquier cosa calculada por solicitud. Endpoints de listado JSON, respuestas GraphQL, HTML renderizado en el servidor, respuestas de ingesta de logs. Este es el predeterminado en .NET 11 y el único cambio que necesitas es fijar la calidad.

**Zstandard, calidad 12 a 19** para contenido comprimido una vez y cacheado, donde almacenas los bytes comprimidos y los sirves repetidamente. La calidad 19 alcanzó 8.34x sobre el payload grande, cerrando la mayor parte de la brecha con Brotli q11 a una fracción del costo. Combínalo con [output caching](/es/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) para que la CPU se pague una vez por entrada de caché en lugar de una vez por solicitud.

**Brotli, calidad 11** para recursos estáticos comprimidos en tiempo de compilación. Tu bundle de JS, tu CSS, tu payload WASM. El tiempo de compresión no importa cuando ocurre en CI, y el diccionario estático integrado de Brotli está ajustado exactamente para este contenido. No hagas esto en el middleware de compresión de respuestas; precomprime y sirve el archivo `.br`.

**Brotli, `Optimal`** cuando necesitas soporte amplio de clientes y no puedes usar Zstandard. Notablemente, esto incluye Blazor WebAssembly, que se discute más abajo.

**Gzip** solo como última entrada de la lista de proveedores, para clientes que no anuncian nada más. Mantenlo registrado; nunca lo prefieras.

## Los detalles que deciden por ti

**Zstandard no existe en el navegador ni en WASI.** El runtime marca toda la familia de tipos con `[UnsupportedOSPlatform("browser")]` y `[UnsupportedOSPlatform("wasi")]`. Si tu cliente es una aplicación Blazor WebAssembly que hace su propia descompresión, o estás ejecutando sobre `wasi-wasm`, Zstandard no es una opción y el analizador te lo dirá en tiempo de compilación. La compresión del lado del servidor hacia un navegador no se ve afectada: el propio soporte de `zstd` del navegador maneja `Content-Encoding: zstd` de forma nativa, y eso lleva ya un tiempo disponible en Chrome, Edge y Firefox. Esto solo afecta al código que llama a `ZstandardStream` dentro de un runtime WASM.

**`CompressionLevel.NoCompression` no significa "sin compresión" para Zstandard.** El runtime mapea el enum sobre la calidad de zstd así:

```csharp
// .NET 11, from ZstandardUtils.cs
CompressionLevel.NoCompression => Quality_Min,   // ZSTD_minCLevel(), a large negative number
CompressionLevel.Fastest       => 1,
CompressionLevel.Optimal       => Quality_Default,  // 3
CompressionLevel.SmallestSize  => Quality_Max,      // 22
```

`NoCompression` mapea a la *calidad mínima*, que sigue siendo una configuración que comprime, solo que extremadamente rápida y débil. Para Gzip y Brotli, `NoCompression` sí significa bloques almacenados. Pasar el mismo valor del enum a los tres códecs te da tres comportamientos distintos.

**Las calidades negativas son válidas, y la documentación de ASP.NET Core no las menciona.** [La página de compresión de respuestas](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0) dice que el nivel de calidad "va de 1 a 22". El código fuente del runtime es más amplio: `Quality` acepta cualquier valor desde `MinQuality` hasta `MaxQuality`, con los negativos documentados como una extensión del rango velocidad/ratio. Rara vez son lo que quieres para JSON. La calidad -5 llevó la compresión hasta 1635 MB/s pero el ratio se derrumbó de 7.37x a 3.81x, lo que para una respuesta de 3 MB significa enviar unos 375 KB más por la red para ahorrar un milisegundo de CPU. Recurre a la calidad 1, no a los negativos.

**Habilitar la compresión sobre HTTPS sigue siendo algo opcional con un riesgo real asociado.** `EnableForHttps` es `false` por defecto porque comprimir una respuesta que mezcla un secreto con entrada influida por un atacante filtra ese secreto a través del tamaño comprimido ([CRIME](https://en.wikipedia.org/wiki/CRIME) y [BREACH](https://en.wikipedia.org/wiki/BREACH)). Cambiar de códec no cambia esto: Zstandard es exactamente igual de vulnerable de lo que era Gzip. Si quieres el razonamiento y la lista de mitigaciones, la [guía completa de configuración de compresión de respuestas](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) lo cubre.

**Las respuestas pequeñas pierden con cualquier códec.** La respuesta de un solo registro en mi conjunto de pruebas ocupa 179 bytes. Gzip `Fastest` la convirtió en 188 bytes, más grande que la entrada, y Zstandard con calidad 1 en 157 bytes, una "ganancia" de 1.14x que se come por completo el overhead de encuadre y la preparación del codificador por respuesta. La guía del propio framework es no comprimir por debajo de aproximadamente 150 a 1 000 bytes, y la elección del códec no mueve ese umbral.

## Cómo configurarlo

La configuración completa para una API JSON, con la calidad fijada:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 1
    };
});

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/customers", () => Results.Ok(GetCustomers()));

app.Run();
```

Agregar los tres proveedores explícitamente es redundante con los valores predeterminados, pero documenta el orden de preferencia para la siguiente persona y sobrevive a que alguien agregue un cuarto proveedor más adelante.

Vale la pena conocer otras dos perillas de `ZstandardCompressionOptions` para respuestas en streaming. `TargetBlockSize` (rango válido de 1 340 a 131 072 bytes) sugiere con qué frecuencia el codificador emite un bloque; valores más pequeños significan menor latencia para una respuesta que gotea, a cierto costo en ratio. `EnableLongDistanceMatching` mejora los ratios en cuerpos grandes a costa de memoria. Ninguna vale la pena tocar hasta que hayas fijado la calidad y medido.

Si tus respuestas son pequeñas, uniformes y repetitivas, la característica que realmente vale la pena investigar es `ZstandardDictionary`. Entrenar un diccionario sobre muestras representativas permite a Zstandard comprimir payloads que individualmente son demasiado pequeños para construir una ventana útil, que es el único caso en el que la respuesta de 179 bytes de arriba se vuelve comprimible. Brotli y Gzip no tienen un equivalente que puedas entrenar tú mismo.

## La recomendación, otra vez

Toma el valor predeterminado de .NET 11 y fija una propiedad. Zstandard con calidad 1 dio el mejor ratio de cualquier nivel que corra lo bastante rápido para una ruta de solicitud, igualó la configuración más rápida de Brotli en throughput de compresión y descomprimió alrededor de 3x más rápido que cualquier otra cosa de la tabla, que es el número que sienten tus clientes móviles. Deja Brotli y Gzip registrados debajo para que los clientes antiguos sigan recibiendo algo.

No aceptes la calidad predeterminada del proveedor, que es 3. Es la única configuración de esta comparación que pierde en tamaño y velocidad al mismo tiempo, y es lo que obtienes si no cambias nada.

## Relacionado

- [Cómo agregar compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) cubre por completo la configuración del middleware, los tipos MIME y la decisión de seguridad sobre HTTPS.
- [.NET 11 agrega compresión Zstandard nativa a System.IO.Compression](/es/2026/04/dotnet-11-zstandard-compression-system-io/) presenta la API `ZstandardStream` fuera del contexto HTTP.
- [Output caching vs response caching en ASP.NET Core 11](/es/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) es cómo haces asequible un nivel de compresión alto.
- [Compresión Deflate y Gzip basada en spans en .NET 11](/es/2026/05/dotnet-11-span-based-deflate-gzip-compression/) cubre las APIs de un solo paso y sin asignaciones para los códecs más antiguos.
- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin bufferizar](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explica dónde la compresión y el streaming interactúan mal.

## Fuentes

- [Compresión de respuestas en ASP.NET Core 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionProvider.cs, orden de proveedores por defecto (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs)
- [ZstandardCompressionProviderOptions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ZstandardCompressionProviderOptions.cs)
- [ZstandardCompressionOptions.cs, semántica de calidad y ventana (dotnet/dotnet)](https://github.com/dotnet/dotnet/blob/main/src/runtime/src/libraries/System.IO.Compression.Zstandard/src/System/IO/Compression/ZstandardCompressionOptions.cs)
- [Referencia de la clase ZstandardCompressionOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardcompressionoptions?view=net-11.0)
- [Support zstd Content-Encoding (dotnet/aspnetcore issue 50643)](https://github.com/dotnet/aspnetcore/issues/50643)
- [RFC 8878: Zstandard Compression and the application/zstd Media Type](https://datatracker.ietf.org/doc/html/rfc8878)
- [Implementación de referencia de Zstandard](https://github.com/facebook/zstd)
