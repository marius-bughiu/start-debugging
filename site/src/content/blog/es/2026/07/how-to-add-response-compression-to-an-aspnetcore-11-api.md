---
title: "Cómo agregar compresión de respuestas a una API de ASP.NET Core 11"
description: "Una guía completa de la compresión de respuestas en ASP.NET Core 11: AddResponseCompression y UseResponseCompression, el nuevo proveedor Zstandard integrado junto a Brotli y Gzip, niveles de compresión, EnableForHttps y el riesgo de CRIME/BREACH, tipos MIME personalizados, el orden del middleware y cuándo dejar que lo haga el proxy inverso."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
lang: "es"
translationOf: "2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api"
translatedBy: "claude"
translationDate: 2026-07-14
---

Para agregar compresión de respuestas a una API de ASP.NET Core 11 necesitas exactamente dos líneas: registra el middleware con `builder.Services.AddResponseCompression()` y agrégalo al pipeline con `app.UseResponseCompression()`. Eso te da Brotli, Gzip y (nuevo en .NET 11) Zstandard, negociados automáticamente a partir del encabezado `Accept-Encoding` del cliente. El detalle es que no hace nada sobre HTTPS a menos que lo habilites con `EnableForHttps = true`, y esa habilitación conlleva un riesgo de seguridad real que debes entender antes de activarla. Este artículo cubre todo el camino: la configuración de dos líneas, la incorporación de Zstandard en .NET 11, los niveles de compresión, los tipos MIME, el problema con HTTPS y los casos en los que deberías dejar que tu proxy inverso haga la compresión.

Todo aquí apunta a .NET 11 (Preview 5 al momento de escribir, con disponibilidad general en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14. El middleware `Microsoft.AspNetCore.ResponseCompression` es estable desde ASP.NET Core 2.1, así que las partes de Brotli y Gzip funcionan sin cambios en .NET 8, 9 y 10. El proveedor Zstandard es la única pieza exclusiva de .NET 11 en adelante.

## Las dos partes móviles

La compresión de respuestas vive en el framework compartido, así que no hay ningún paquete de NuGet que instalar. Registra los servicios y agrega el middleware:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression();

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/data", () => Enumerable.Range(0, 1000)
    .Select(i => new { Id = i, Name = $"Item {i}", Note = "some repeated text" }));

app.Run();
```

Este es el procedimiento completo, de principio a fin:

1. Llama a `builder.Services.AddResponseCompression()` para registrar el middleware y sus proveedores predeterminados (Brotli, Gzip y Zstandard en .NET 11).
2. Llama a `app.UseResponseCompression()` temprano en el pipeline, antes de cualquier middleware que escriba el cuerpo de la respuesta.
3. Si tu API se sirve sobre HTTPS (casi siempre), establece `EnableForHttps = true` en las opciones, después de leer la sección de seguridad más abajo.
4. Agrega cualquier tipo MIME no predeterminado que sirvas (por ejemplo `image/svg+xml`) a `ResponseCompressionOptions.MimeTypes`.
5. Ajusta el nivel de compresión por proveedor si el predeterminado (el más rápido) no es el equilibrio que buscas.
6. Verifica con un cliente que envíe `Accept-Encoding` e inspecciona los encabezados de respuesta `Content-Encoding` y `Vary`.

Esa es toda la característica. El resto de este artículo trata de hacer cada paso correctamente en lugar de solo hacer que compile.

## Qué cambia en .NET 11: Zstandard ahora viene integrado

Si has configurado la compresión de respuestas en una versión anterior de .NET, la memoria muscular dice "Brotli y Gzip". En .NET 11 esa lista creció. Zstandard (token de codificación `zstd`, [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878)) es ahora un proveedor de compresión de primera clase, integrado en la pila de `System.IO.Compression` sin paquete de NuGet, sin P/Invoke y sin bindings de terceros. Cuando llamas a `AddResponseCompression()` sin proveedores explícitos, ASP.NET Core 11 registra los tres: `BrotliCompressionProvider`, `GzipCompressionProvider` y `ZstandardCompressionProvider`.

El orden de negociación también cambió. En .NET 10 y anteriores, el middleware prefería Brotli y luego recurría a Gzip. En .NET 11, la preferencia es Zstandard primero, luego Brotli y luego Gzip. Así que cuando un navegador moderno envía `Accept-Encoding: gzip, deflate, br, zstd`, una API de ASP.NET Core 11 ahora responde con `Content-Encoding: zstd`. El motivo del reordenamiento es que Zstandard alcanza un mejor punto en la curva de velocidad/ratio para respuestas dinámicas de API: en su nivel predeterminado comprime notablemente más rápido que Brotli con un ratio equivalente, y descomprime más rápido que Brotli y Gzip, lo que importa cuando el cliente es un dispositivo móvil u otro servicio.

La consecuencia operativa importante: después de actualizar a .NET 11, tu API empezará a emitir `zstd` a cualquier cliente que lo anuncie, sin que cambies una sola línea. Eso está bien para navegadores y clientes HTTP modernos, pero si tienes un consumidor interno antiguo que decía soportar `zstd` y en realidad no puede decodificarlo (raro, pero pasa con clientes hechos a mano), verás cuerpos corruptos. La solución no es deshabilitar la compresión globalmente, sino restringir la lista de proveedores, como muestra la siguiente sección.

## Elegir proveedores de forma explícita

En cuanto agregas aunque sea un proveedor a mano, los predeterminados automáticos se desactivan. Este es el error más común: escribir `options.Providers.Add<BrotliCompressionProvider>()` y luego preguntarse por qué Gzip dejó de funcionar. Cuando agregas proveedores de forma explícita, solo están activos los que listas.

Así que para mantener los tres y habilitar la compresión sobre HTTPS:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
```

El orden en que agregas los proveedores es el orden de preferencia del servidor cuando un cliente acepta más de uno. Pon Zstandard primero si quieres que se prefiera, y Gzip al final como recurso universal. Si quieres forzar solo Gzip (por ejemplo, para coincidir con la configuración de un CDN heredado), agrega únicamente `GzipCompressionProvider` y ningún otro, y el middleware nunca emitirá Brotli ni Zstandard.

## Niveles de compresión, y por qué el predeterminado es "el más rápido"

Cada proveedor tiene como predeterminado `CompressionLevel.Fastest`, no `Optimal`. Eso sorprende a quienes esperan el cuerpo más pequeño posible de fábrica. El predeterminado es deliberado: para una respuesta dinámica calculada por solicitud, la CPU que gastas comprimiendo está en la ruta crítica de cada respuesta, así que el framework favorece la latencia sobre el último puñado de puntos porcentuales de tamaño. `Optimal` y `SmallestSize` pueden costar varias veces la CPU por una reducción de un solo dígito porcentual en un JSON ya pequeño.

Estableces el nivel por proveedor a través de su clase de opciones:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize;
});
```

El enum `CompressionLevel` tiene cuatro valores: `NoCompression`, `Fastest`, `Optimal` y `SmallestSize`. Para una API interactiva, deja Zstandard y Brotli en `Fastest`. Reserva `Optimal` o `SmallestSize` para respuestas que comprimes una vez y sirves muchas, lo que en una API pura suele significar que te conviene más cachear tú mismo los bytes comprimidos que pagar compresión óptima en cada solicitud. Si además sirves recursos estáticos, ten en cuenta que la compresión de archivos estáticos es un asunto aparte (en tiempo de compilación o en el CDN), no algo que este middleware deba hacer en tiempo de solicitud.

Zstandard tiene su propia perilla, más fina. Su calidad va de 1 a 22, con el predeterminado alrededor del nivel 3, y la estableces mediante `ZstandardCompressionProviderOptions`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 6 // 1 to 22; higher = smaller output, slower
    };
});
```

Una calidad más alta significa un cuerpo más pequeño y más CPU. El nivel 6 es un paso razonable por encima del predeterminado cuando tus respuestas son grandes y repetitivas (piensa en endpoints de listas que devuelven miles de objetos similares) y tienes margen de CPU.

## El problema de seguridad con HTTPS que no puedes saltarte

`EnableForHttps` es `false` por defecto, y ese predeterminado es una decisión de seguridad, no un descuido. Comprimir una respuesta cuyo cuerpo mezcla un secreto (un token de sesión, un token CSRF, un número de cuenta) con entrada influida por un atacante, sobre TLS, abre la puerta a los ataques [CRIME](https://en.wikipedia.org/wiki/CRIME) y [BREACH](https://en.wikipedia.org/wiki/BREACH). Estos ataques de canal lateral infieren el secreto observando cómo cambia el tamaño de la respuesta comprimida a medida que el atacante varía la entrada que controla. El ratio de compresión filtra información sobre el contenido, y sobre HTTPS el tamaño del cuerpo cifrado sigue siendo observable.

Para una API JSON típica que no devuelve secretos por usuario reflejados junto a valores de consulta controlados por el atacante, habilitar la compresión sobre HTTPS es algo normal y razonable, y casi todo el mundo lo hace. Pero deberías tomar esa decisión de forma deliberada:

- Si tus respuestas nunca incrustan un token secreto en el cuerpo junto a entrada reflejada del usuario, habilitar la compresión sobre HTTPS es de bajo riesgo.
- Si podrían hacerlo (una página HTML con un token antifalsificación, un endpoint que devuelve un término de búsqueda junto a un identificador de sesión), mitiga antes de habilitar: usa tokens antifalsificación (la mitigación estándar en ASP.NET Core), evita reflejar entrada no confiable en respuestas que contienen secretos y considera dejar la compresión desactivada para esos endpoints específicos.

El flag `EnableForHttps` es global. Si necesitas compresión para endpoints de datos públicos pero no para uno sensible, la división más limpia es ejecutar los endpoints sensibles sin compresión segmentando el pipeline, o servirlos con un `Content-Type` que deliberadamente dejes fuera de la lista de MIME comprimibles.

Un detalle más: incluso con `EnableForHttps = false`, es posible que aún veas un encabezado `Content-Encoding` en producción. IIS, IIS Express y Azure App Service pueden aplicar Gzip en la capa del servidor web de forma independiente a tu aplicación. Si aparece una respuesta comprimida que no configuraste, revisa el encabezado de respuesta `Server` antes de asumir que el middleware se está portando mal.

## Tipos MIME: qué se comprime realmente

El middleware solo comprime respuestas cuyo `Content-Type` coincide con su lista. Los predeterminados cubren los payloads habituales de API y web: `application/json`, `application/javascript`, `application/xml`, `text/css`, `text/html`, `text/json`, `text/plain` y `text/xml`. Para una API JSON obtienes compresión sin configurar nada, porque `application/json` está en la lista.

Para comprimir algo fuera de los predeterminados, agrégalo a `ResponseCompressionOptions.MimeTypes`. Los comodines como `text/*` no son compatibles, así que lista cada tipo:

```csharp
// .NET 11, C# 14
using System.Linq;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "image/svg+xml", "application/manifest+json" });
});
```

No agregues formatos ya comprimidos como PNG, JPEG, WebP o ZIP. Están comprimidos de forma nativa, y pasarlos por Brotli o Zstandard quema CPU para producir un cuerpo del mismo tamaño o ligeramente mayor. Lo mismo aplica a respuestas muy pequeñas: por debajo de aproximadamente 150 a 1000 bytes la sobrecarga de la compresión puede hacer que la salida sea más grande que la entrada, así que las respuestas diminutas no valen la pena de comprimir sin importar el tipo.

## Orden: UseResponseCompression va temprano

El orden del middleware decide si la compresión funciona siquiera. `app.UseResponseCompression()` debe ejecutarse antes de cualquier middleware que escriba en el cuerpo de la respuesta, porque la compresión funciona envolviendo el flujo de respuesta. Si otro middleware ya empezó a escribir, el envoltorio de compresión nunca ve esos bytes. En la práctica, ponlo cerca de la parte superior del pipeline:

```csharp
// .NET 11, C# 14
var app = builder.Build();

app.UseResponseCompression();   // first, so it wraps everything below
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Cuando se aplica la compresión, el middleware también hace lo correcto con los encabezados de caché de forma automática: elimina `Content-Length` (la longitud del cuerpo cambió), quita `Content-MD5` (el hash ya no es válido) y agrega `Vary: Accept-Encoding` para que las cachés almacenen por separado las variantes comprimida y sin comprimir. No gestionas eso a mano.

## Cuándo omitir el middleware por completo

El middleware de compresión de respuestas es la herramienta correcta cuando alojas directamente en Kestrel o HTTP.sys sin nada por delante, porque ninguno de esos servidores ofrece compresión integrada. Pero si tu API está detrás de IIS, Nginx, Apache o un CDN, el proxy inverso normalmente puede comprimir más rápido que el middleware administrado, y hacerlo en un solo lugar es más fácil de razonar. La propia recomendación de Microsoft es preferir la compresión basada en el servidor cuando esté disponible.

Dos trampas que vigilar cuando hay un proxy de por medio:

- Nginx elimina el encabezado `Accept-Encoding` cuando hace de proxy hacia arriba, lo que impide silenciosamente que el middleware de ASP.NET Core comprima. Si mantienes el middleware detrás de Nginx, o configuras Nginx para preservar el encabezado o dejas que Nginx haga la compresión y descartas el middleware.
- La doble compresión es trabajo desperdiciado y puede corromper respuestas. Si el proxy ya comprime, no ejecutes además el middleware para los mismos tipos de contenido. Elige una sola capa.

Para una minimal API servida directamente desde Kestrel en un contenedor sin proxy sidecar, el middleware es exactamente lo correcto y la configuración de dos líneas del inicio de este artículo es todo lo que necesitas. Para cualquier cosa detrás de un proxy o CDN maduro, mide primero: puede que ya estés obteniendo una compresión que no configuraste.

## Proveedores personalizados, en breve

Si necesitas una codificación que el framework no incluye, implementa `ICompressionProvider`. La propiedad `EncodingName` es el token que el middleware coteja con `Accept-Encoding`, y `CreateStream` devuelve tu envoltorio de compresión:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

public sealed class CustomCompressionProvider : ICompressionProvider
{
    public string EncodingName => "mycustomcompression";
    public bool SupportsFlush => true;

    public Stream CreateStream(Stream outputStream)
    {
        // Wrap outputStream in your compression stream here.
        return outputStream;
    }
}
```

Regístralo como cualquier otro proveedor con `options.Providers.Add<CustomCompressionProvider>()`. En la práctica, con Zstandard ahora integrado, la necesidad de proveedores personalizados casi ha desaparecido. Entre Zstandard, Brotli y Gzip, .NET 11 cubre todas las codificaciones que un cliente HTTP real pedirá, que es el objetivo del cambio de .NET 11: la opción rápida y moderna ahora está activada por defecto y ya no tienes que salir del framework para obtenerla.

## Relacionados

- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin almacenar en búfer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explica por qué el middleware de compresión y el streaming pueden entrar en conflicto.
- [Cómo agregar caché de salida a una minimal API en ASP.NET Core 11](/es/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) combina bien con la compresión para endpoints con muchas lecturas.
- [Cómo organizar los endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) ayuda cuando quieres compresión en algunos grupos de rutas pero no en otros.
- [Cómo devolver una unión Results tipada desde un endpoint de minimal API en ASP.NET Core 11](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) cubre los tipos de respuesta que atraviesan este middleware.
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) vale la pena si te importa el costo de CPU de la compresión en los arranques en frío.

## Fuentes

- [Response compression in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionOptions.EnableForHttps (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.responsecompression.responsecompressionoptions.enableforhttps)
- [CompressionLevel enum (API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.compressionlevel)
- [RFC 8878: Zstandard Compression](https://datatracker.ietf.org/doc/html/rfc8878)
- [CRIME attack (Wikipedia)](https://en.wikipedia.org/wiki/CRIME) y [BREACH attack (Wikipedia)](https://en.wikipedia.org/wiki/BREACH)
