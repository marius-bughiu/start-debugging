---
title: "Cómo configurar Kestrel para servir HTTP/3 en ASP.NET Core 11"
description: "Una guía completa para habilitar HTTP/3 en Kestrel en ASP.NET Core 11: la configuración del endpoint con HttpProtocols.Http1AndHttp2AndHttp3, los requisitos de plataforma de MsQuic en Windows, Linux y macOS, por qué la primera solicitud nunca es HTTP/3, cómo verificarlo con HttpClient y middleware, el ajuste de QuicTransportOptions y los problemas de firewall y proxy que hacen que caiga silenciosamente."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "kestrel"
  - "http-3"
  - "performance"
lang: "es"
translationOf: "2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Para servir HTTP/3 desde Kestrel configuras un endpoint HTTPS con `listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3`. Esa es toda la superficie de la API. Todo lo que sale mal después es del entorno: falta MsQuic en el host, UDP está bloqueado en el puerto, un proxy inverso termina la conexión antes de que QUIC llegue a ti, o estás probando con un navegador que rechaza el certificado de desarrollo sobre HTTP/3. Kestrel no lanza una excepción por ninguna de estas cosas. Deshabilita HTTP/3, sigue sirviendo HTTP/1.1 y HTTP/2, y tu salida de `curl` se ve exactamente igual que antes de cambiar nada.

Todo lo de aquí apunta a .NET 11 (probado contra Preview 6, SDK `11.0.100-preview.6.26359.118`) con `Microsoft.NET.Sdk.Web` y C# 14. HTTP/3 en Kestrel está totalmente soportado desde .NET 7, así que la configuración de abajo no cambia en .NET 8, 9 y 10. Lo único genuinamente nuevo en .NET 11 es el procesamiento temprano de solicitudes que se cubre al final.

## Los seis pasos, de principio a fin

1. Configura un endpoint HTTPS y asigna a `Protocols` el valor `HttpProtocols.Http1AndHttp2AndHttp3`.
2. Asegúrate de que MsQuic esté presente en el host, lo que significa Windows 11 o Windows Server 2022 o posterior, o el paquete `libmsquic` en Linux.
3. Abre el puerto UDP con el mismo número que tu puerto TLS en todos los firewalls y grupos de seguridad del camino.
4. Agrega una comprobación de arranque que registre en voz alta cuando `QuicListener.IsSupported` sea false, para que una dependencia faltante sea una línea de registro y no un misterio.
5. Verifica con `HttpClient` fijado a la versión 3.0, no con un navegador.
6. Registra `HttpContext.Request.Protocol` en un middleware para poder ver qué negociaron realmente los clientes en producción.

El resto de este artículo trata sobre hacer cada uno de esos pasos correctamente, en lugar de solo lograr que el código compile.

## Configurar el endpoint

No hay ningún paquete de NuGet que instalar. El transporte QUIC, `Microsoft.AspNetCore.Server.Kestrel.Transport.Quic`, viene en el framework compartido de ASP.NET Core. Solo necesitas cambiar cómo se declara el endpoint:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.ListenAnyIP(5001, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listenOptions.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", (HttpContext ctx) => new { protocol = ctx.Request.Protocol });

app.Run();
```

Dos detalles de ese fragmento hacen trabajo real. `UseHttps()` no es opcional: HTTP/3 exige TLS 1.3, así que un endpoint sin él nunca puede negociar h3. Y el valor del enum es `Http1AndHttp2AndHttp3`, no `Http3`. El valor por defecto de Kestrel es `Http1AndHttp2`, y el valor de tres protocolos es el que quieres en producción porque no todos los routers, proxies corporativos u operadores móviles pasan QUIC limpiamente. `HttpProtocols.Http3` por sí solo te da un endpoint sin ruta de retroceso: en un host donde MsQuic no esté disponible, Kestrel deshabilita HTTP/3 y no queda nada que ese endpoint pueda servir.

La misma opción está disponible desde la configuración, que suele ser el mejor lugar para ella porque te permite habilitar HTTP/3 por entorno sin recompilar:

```json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:5001",
        "Protocols": "Http1AndHttp2AndHttp3"
      }
    }
  }
}
```

También existe `Kestrel:EndpointDefaults:Protocols` si quieres aplicarlo a todos los endpoints. Ten en cuenta la regla de precedencia que engaña a la gente aquí: una llamada explícita a `Listen` o `ListenAnyIP` dentro de `ConfigureKestrel` anula `ASPNETCORE_URLS`, `--urls` y el `applicationUrl` de `launchSettings.json`. Kestrel registra una advertencia cuando eso ocurre ("Overriding address(es)"), y si se te pasa vas a perder una tarde preguntándote por qué tu aplicación ya no está en el puerto 7043. Elige un mecanismo, no los dos.

## Qué requiere MsQuic en cada plataforma

ASP.NET Core no implementa QUIC por sí mismo. `System.Net.Quic` se enlaza con [MsQuic](https://github.com/microsoft/msquic), y la matriz de plataformas se hereda por completo de esa biblioteca nativa.

En **Windows**, `msquic.dll` se distribuye como parte del runtime de .NET, así que no hay nada que instalar, pero el sistema operativo tiene que ser Windows 11 o Windows Server 2022 o posterior. Las versiones anteriores de Windows carecen de las API criptográficas que QUIC necesita, y ninguna cantidad de configuración lo soluciona. Esta es la razón más común por la que HTTP/3 no se activa en un destino de implementación corporativo que todavía corre Windows Server 2019.

En **Linux**, debes instalar `libmsquic` tú mismo. Se publica en el repositorio de paquetes de Microsoft en `packages.microsoft.com`, y también está en el repositorio community de Alpine:

```bash
# Debian / Ubuntu, after adding the packages.microsoft.com repo
sudo apt-get install libmsquic

# Alpine 3.21 and later
sudo apk add libmsquic
```

.NET 7 y posteriores requieren libmsquic 2.2 o más reciente. La línea 1.9.x a la que .NET 6 estaba fijado no es compatible, así que si arrastras un Dockerfile viejo de un proyecto de .NET 6, revisa la versión que estás bajando. Esto también significa que una imagen de contenedor `mcr.microsoft.com/dotnet/aspnet` normal **no** habla HTTP/3 de fábrica; tienes que agregar el paquete en tu propia capa de imagen. Si construyes imágenes con `dotnet publish /t:PublishContainer`, ese es un `RUN` extra que no puedes expresar solo con las propiedades de contenedor del SDK, y vas a necesitar un Dockerfile.

En **macOS**, el soporte es parcial y no oficial. Puedes hacer `brew install libmsquic`, pero el runtime no lo encontrará a menos que apuntes el cargador dinámico al prefijo de Homebrew:

```bash
DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH:$(brew --prefix)/lib dotnet run
```

Trata eso como una comodidad de desarrollo local, no como una configuración de producción soportada.

## Hacer ruidoso el retroceso silencioso

El comportamiento de retroceso de Kestrel es el valor por defecto correcto para un servidor web y el peor posible para depurar. Si falta MsQuic, HTTP/3 se deshabilita y la aplicación arranca con normalidad. Nada en la salida de registro por defecto a nivel `Information` te lo dice.

La solución es una comprobación de arranque de tres líneas contra la misma propiedad `IsSupported` que expone `System.Net.Quic`:

```csharp
// .NET 11, C# 14
using System.Net.Quic;

var app = builder.Build();

if (!QuicListener.IsSupported)
{
    app.Logger.LogWarning(
        "QUIC is not supported on this host. HTTP/3 is disabled and Kestrel " +
        "will serve HTTP/1.1 and HTTP/2 only. Check for libmsquic and TLS 1.3 support.");
}
```

`QuicListener.IsSupported` devuelve false por las dos razones que importan: la biblioteca nativa está ausente, o TLS 1.3 no está disponible. Usa `QuicListener.IsSupported` del lado del servidor y `QuicConnection.IsSupported` del lado del cliente. Actualmente reportan el mismo valor, pero la guía documentada es comprobar el que corresponde a tu rol.

Si quieres más detalle, sube la categoría de Kestrel a `Debug` y observa el enlace del puerto:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Server.Kestrel": "Debug"
    }
  }
}
```

## Por qué tu primera solicitud nunca es HTTP/3

Esta es la parte que hace pensar a la gente que su configuración está rota cuando funciona perfectamente.

Un cliente no puede saber que un servidor habla HTTP/3 antes de conectarse, porque no hay ningún registro DNS ni extensión TLS que lo anuncie. El descubrimiento ocurre a través del encabezado de respuesta [`alt-svc`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Alt-Svc): el cliente hace su primera solicitud sobre HTTP/1.1 o HTTP/2, ve un encabezado que nombra un endpoint h3, y usa QUIC para las solicitudes siguientes a ese origen. Kestrel agrega ese encabezado automáticamente siempre que HTTP/3 esté habilitado en el endpoint, así que obtienes algo así en la primera respuesta:

```text
HTTP/2 200
alt-svc: h3=":5001"
```

Por eso una prueba de una sola solicitud siempre reportará HTTP/2. Cualquier medición que tomes tiene que hacer al menos dos solicitudes sobre la misma instancia de cliente, y el cliente tiene que ser uno que respete `alt-svc`.

IIS es la excepción que conviene conocer. Cuando hospedas detrás de IIS, HTTP/3 está soportado en proceso, pero IIS no agrega `alt-svc` por ti. Lo agregas tú mismo, temprano en el pipeline:

```csharp
// .NET 11, C# 14 - only needed when hosting behind IIS
app.Use((context, next) =>
{
    context.Response.Headers.AltSvc = "h3=\":443\"";
    return next(context);
});
```

IIS además necesita Windows Server 2022 o Windows 11, un binding `https` y la clave de registro `EnableHttp3` establecida. Y ten en cuenta que el hospedaje fuera de proceso reporta `HTTP/1.1` desde `HttpRequest.Protocol` incluso en una conexión HTTP/3, porque ese es el protocolo que IIS usa para hacer de proxy hacia Kestrel. Solo el modelo en proceso reporta `HTTP/3`.

## Verificar que realmente funciona

No uses un navegador. Los navegadores rechazan los certificados autofirmados sobre HTTP/3, lo que incluye el certificado de desarrollo de ASP.NET Core, así que una prueba local en el navegador reportará HTTP/2 para siempre y no te dirá nada.

Usa `HttpClient` con la versión fijada. Para una prueba quieres `RequestVersionExact`, porque falla de forma ruidosa en vez de degradarse en silencio:

```csharp
// .NET 11, C# 14
using System.Net;

using var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version30,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
};

var response = await client.GetAsync("https://localhost:5001/ping");

Console.WriteLine($"status: {response.StatusCode}, version: {response.Version}");
// status: OK, version: 3.0
```

En el código de la aplicación quieres la política contraria. Fija la versión en 1.1 con `HttpVersionPolicy.RequestVersionOrHigher` para que el cliente suba a HTTP/3 cuando el servidor lo anuncie y degrade con elegancia cuando no. Fijar `RequestVersionExact` en producción convierte un tropiezo de red en un fallo duro, que es primo cercano de [los fallos de handshake TLS que aparecen como "The SSL connection could not be established"](/es/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

En el servidor, la verdad de campo es una línea de middleware:

```csharp
// .NET 11, C# 14
app.Use(async (context, next) =>
{
    app.Logger.LogInformation("Request served over {Protocol}", context.Request.Protocol);
    await next(context);
});
```

`HttpContext.Request.Protocol` es la cadena `"HTTP/3"` para una conexión QUIC. Si quieres ramificar según eso, `HttpProtocol.IsHttp3(context.Request.Protocol)` de `Microsoft.AspNetCore.Http` evita codificar el literal a mano. Emitir esto como dimensión de una métrica durante una semana después del despliegue es la única forma honesta de saber qué fracción de tu tráfico llegó realmente a h3, y suele ser menor de lo que esperas.

## Ajustar QuicTransportOptions

El transporte tiene su propio objeto de opciones, configurado mediante `UseQuic` en el web host builder en lugar de mediante `ConfigureKestrel`:

```csharp
// .NET 11, C# 14
builder.WebHost.UseQuic(options =>
{
    options.MaxBidirectionalStreamCount = 200;
    options.MaxUnidirectionalStreamCount = 20;
});
```

Los valores por defecto son `MaxBidirectionalStreamCount` 100, `MaxUnidirectionalStreamCount` 10, `MaxReadBufferSize` 1 MB, `MaxWriteBufferSize` 64 KB y `Backlog` 512. El conteo de streams bidireccionales es el que vale la pena revisar: limita las solicitudes concurrentes por conexión, y como QUIC no tiene bloqueo de cabeza de línea, un cliente que habría abierto varias conexiones HTTP/2 ahora puede meterlo todo por una sola. Si estás delante de una single-page app conversadora o de un cliente gRPC, 100 puede volverse el techo.

Si copiaste un ejemplo que envuelve este bloque en `#pragma warning disable CA2252`, eso viene de cuando `System.Net.Quic` se publicaba como versión preliminar. Esas API se estabilizaron en .NET 9, así que normalmente puedes quitar el pragma.

## Los problemas que más tiempo cuestan

**UDP no está abierto.** QUIC corre sobre UDP en el mismo número de puerto que tu endpoint TLS. Cada firewall, grupo de seguridad y balanceador de carga del camino tiene que permitir UDP entrante en ese puerto, y la mayoría de las plantillas por defecto solo abren TCP. Esta es la causa número uno de "funciona en mi máquina y no en Azure".

**Algo delante de ti termina la conexión.** Si un balanceador de carga de capa 7, un ingress controller o una CDN se sitúa entre el cliente y Kestrel, HTTP/3 tiene que estar habilitado *ahí*, y el salto de ese proxy a Kestrel es con frecuencia HTTP/1.1 de todos modos. Habilitar h3 en Kestrel detrás de un proxy que no reenvía QUIC no cambia absolutamente nada.

**Algunas sobrecargas de `UseHttps` no son compatibles.** Con HTTP/3 en juego, `HandshakeTimeout` y `OnAuthenticate` en `HttpsConnectionAdapterOptions` no hacen nada, y las sobrecargas de `UseHttps` que reciben un `ServerOptionsSelectionCallback` con un tiempo de espera de handshake, o un `TlsHandshakeCallbackOptions`, lanzan una excepción. Si haces selección dinámica de certificado por nombre de host, verifica ese camino antes de habilitar h3.

**Estás midiendo lo equivocado.** Las ganancias de HTTP/3 son menos viajes de ida y vuelta en el handshake y la ausencia de bloqueo de cabeza de línea bajo pérdida de paquetes. En una conexión de baja latencia y sin pérdidas entre dos máquinas del mismo centro de datos se verá idéntico a HTTP/2, y un benchmark corrido sobre loopback no mostrará nada. Mide en una red móvil real o con pérdidas, o no midas. El tamaño de la respuesta sigue dominando la mayoría de los presupuestos de latencia de una API, y por eso [la compresión de respuestas](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) suele ser una ganancia mayor y más barata que una actualización de protocolo.

## Qué cambió .NET 11

Antes de .NET 11, Kestrel esperaba a recibir el stream de control QUIC del par y su frame `SETTINGS` inicial antes de despachar cualquier stream de solicitud. Eso costaba aproximadamente un viaje de ida y vuelta lógico extra en cada conexión nueva, que es exactamente el escenario donde HTTP/3 se supone que gana a una conexión HTTP/2 ya caliente. En .NET 11, Kestrel despacha los streams de solicitud en cuanto llegan y aplica la configuración del par cuando el stream de control se pone al día. No hay nada que configurar y no hay cambios de código a nivel de handler: es un cambio de comportamiento a nivel de cable que obtienes al actualizar, cubierto con más detalle en el artículo sobre [el procesamiento temprano de solicitudes HTTP/3 en Kestrel](/es/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/).

Lo único que hay que tener presente es que Kestrel sigue respetando el `SETTINGS_MAX_FIELD_SECTION_SIZE` final del par antes de serializar los encabezados de respuesta. Mantén pequeños los encabezados de respuesta de la primera solicitud y obtienes el beneficio completo.

Si estás levantando un servicio nuevo y decidiendo cuánto del host configurar explícitamente, la opción de protocolo es una de un puñado de perillas que te empujan hacia un host construido a mano en lugar del predeterminado; las contrapartidas están detalladas en la comparación de [CreateBuilder, CreateSlimBuilder y CreateEmptyBuilder](/es/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/).

## Relacionados

- [Kestrel empieza a procesar solicitudes HTTP/3 antes del frame SETTINGS en .NET 11](/es/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)
- [Cómo agregar compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Fix: The SSL connection could not be established con HttpClient](/es/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)
- [Cómo publicar una aplicación .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder en ASP.NET Core 11](/es/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Fuentes

- [Use HTTP/3 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http3), Microsoft Learn
- [Configure endpoints for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints), Microsoft Learn
- [QUIC support in .NET, platform dependencies](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview#platform-dependencies), Microsoft Learn
- [Use HTTP/3 with HttpClient](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-http3), Microsoft Learn
- [Use ASP.NET Core with HTTP/3 on IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/http3), Microsoft Learn
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114), IETF
- [RFC 9000: QUIC, a UDP-based multiplexed and secure transport](https://www.rfc-editor.org/rfc/rfc9000), IETF
- [microsoft/msquic](https://github.com/microsoft/msquic), GitHub
