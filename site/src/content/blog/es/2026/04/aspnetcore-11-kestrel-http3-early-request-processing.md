---
title: "Kestrel empieza a procesar requests HTTP/3 antes del frame SETTINGS en .NET 11 Preview 3"
description: ".NET 11 Preview 3 deja a Kestrel servir requests HTTP/3 antes de que lleguen el control stream del peer y el frame SETTINGS, recortando latencia del handshake en el primer request de cada nueva conexión QUIC."
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "ASP.NET Core"
  - "Kestrel"
  - "HTTP/3"
  - "Performance"
lang: "es"
translationOf: "2026/04/aspnetcore-11-kestrel-http3-early-request-processing"
translatedBy: "claude"
translationDate: 2026-04-24
---

Uno de los wins pequeños pero visibles en el [anuncio de .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) es un cambio en Kestrel para HTTP/3: el servidor ya no espera a que el control stream del cliente y el frame SETTINGS aterricen antes de empezar a procesar requests. El cambio aterrizó en [dotnet/aspnetcore #65399](https://github.com/dotnet/aspnetcore/pull/65399) y apunta a la latencia del primer request en conexiones QUIC nuevas, que es exactamente donde HTTP/3 solía perder terreno frente a una conexión HTTP/2 ya caliente.

## Lo que el handshake HTTP/3 te costaba antes

HTTP/3 corre sobre QUIC, así que el handshake de transporte (TLS 1.3 + QUIC) ya está plegado en el setup de la conexión. Encima de eso, el protocolo define un control stream unidireccional sobre el que cada lado envía un frame `SETTINGS` primero. Esos settings anuncian cosas como `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, `SETTINGS_QPACK_BLOCKED_STREAMS`, y `SETTINGS_MAX_FIELD_SECTION_SIZE`. Kestrel previamente bloqueaba el pipeline de procesamiento de requests sobre ese primer frame del peer. En la práctica eso significaba que una conexión nueva tenía que esperar un roundtrip lógico extra después del handshake QUIC antes de que tus handlers `Map*` corrieran, aunque el cliente ya hubiera 0-RTT'd un frame `HEADERS` sobre un stream de request.

Puedes ver el síntoma si vuelcas el trace de la conexión con `Logging__LogLevel__Microsoft.AspNetCore.Server.Kestrel=Trace`:

```text
Connection id "0HN7..." accepted (HTTP/3).
Stream id "0" started (control).
Waiting for SETTINGS frame from peer.
Stream id "4" started (request).  <-- request arrived, but not dispatched yet
SETTINGS frame received.
Dispatching request on stream id "4".
```

Ese hueco `Waiting for SETTINGS frame` escala con el RTT del peer, no con el trabajo del servidor.

## Lo que cambia Preview 3

En Preview 3, Kestrel despacha streams de request tan pronto como llegan y aplica los settings del peer cuando el control stream pone al día. La spec lo permite: la sección 6.2.1 de RFC 9114 deja a las implementaciones empezar a procesar frames sobre streams de request en paralelo con el handshake del control stream, mientras refuercen los settings retroactivamente para cualquier cosa que no se haya comprometido aún a una decisión sobre el cable.

Nada cambia a nivel de tu handler, la misma minimal API sigue funcionando:

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(o =>
{
    o.ListenAnyIP(5001, listen =>
    {
        listen.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listen.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", () => Results.Ok(new { ok = true, proto = "h3" }));

app.Run();
```

El efecto de Preview 3 está en el cable: el frame `HEADERS` sobre el stream 4 de arriba ahora se despacha de inmediato, y el frame `SETTINGS` se aplica a cualquier campo codificado por QPACK que no se haya decodificado aún. Para un simple `GET /ping` que no manda referencias a la tabla dinámica, el request se completa sin esperar nunca al control stream.

## Qué verificar de tu lado

Vale la pena chequear dos caveats antes de apoyarte en el nuevo comportamiento.

Primero, si envías headers de respuesta grandes, Kestrel sigue respetando el `SETTINGS_MAX_FIELD_SECTION_SIZE` final del peer antes de serializar el frame `HEADERS` de vuelta. Si el peer no ha mandado SETTINGS aún, aplica el default en [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114#name-settings) (sin límite), lo que significa que tu respuesta aún puede ser rechazada después si el setting real del peer es más pequeño. Mantén los headers de respuesta pequeños en el primer request de una conexión.

Segundo, cualquier cosa medida como time-to-first-byte sobre una sesión QUIC nueva debería bajar notablemente. Un benchmark local apretado sobre loopback con latencia artificial de peer de 50ms mostró el primer request bajando de aproximadamente `2 * RTT + server_time` a `1 * RTT + server_time`. Los requests subsiguientes sobre la misma conexión ya no estaban afectados antes de Preview 3 y siguen sin estarlo ahora.

Si corres HTTP/3 detrás de YARP o un API gateway, asegúrate de actualizar a un build de .NET 11 Preview 3 de extremo a extremo; el win está en el lado de Kestrel del salto QUIC, así que el reverse proxy es donde lo verás. El conjunto completo de notas de HTTP/3 y Kestrel para esta preview vive en las [release notes de ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md).
