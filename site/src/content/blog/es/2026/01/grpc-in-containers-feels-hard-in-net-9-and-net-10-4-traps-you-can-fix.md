---
title: "gRPC en contenedores parece difícil en .NET 9 y .NET 10: 4 trampas que puedes corregir"
description: "Cuatro trampas comunes al alojar gRPC en contenedores con .NET 9 y .NET 10: desajustes de protocolo HTTP/2, confusión sobre la terminación de TLS, sondeos de salud rotos y mala configuración del proxy -- con la corrección de cada una."
pubDate: 2026-01-10
tags:
  - "grpc"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix"
translatedBy: "claude"
translationDate: 2026-04-30
---
Volvió a aparecer hoy en r/dotnet: "¿Por qué es tan difícil alojar servicios gRPC en contenedores?". La respuesta corta es que gRPC tiene opiniones firmes sobre HTTP/2, y los contenedores vuelven más explícito el borde de la red. Te obligan a decidir dónde termina TLS, qué puertos hablan HTTP/2 y qué proxy va delante.

Discusión original: [https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/](https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/)

## Trampa 1: el puerto del contenedor es accesible, pero no habla HTTP/2

gRPC requiere HTTP/2 de extremo a extremo. Si un proxy lo degrada a HTTP/1.1, obtienes fallas misteriosas del tipo "unavailable" que parecen errores de la aplicación.

En .NET 9 / .NET 10, declara la intención del servidor de forma explícita:

```cs
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // Inside a container you usually run plaintext HTTP/2 and terminate TLS at the proxy.
    options.ListenAnyIP(8080, listen =>
    {
        listen.Protocols = HttpProtocols.Http2;
    });
});

builder.Services.AddGrpc();

var app = builder.Build();
app.MapGrpcService<GreeterService>();
app.MapGet("/", () => "gRPC service. Use a gRPC client.");
app.Run();
```

## Trampa 2: la terminación de TLS es confusa (y a los clientes gRPC les importa)

Muchos equipos asumen que "contenedor = TLS". En la práctica, terminar TLS en el borde es más simple:

-   **Kestrel**: corre HTTP/2 sin TLS en `8080` dentro del clúster.
-   **Ingress / proxy inverso**: termina TLS y reenvía al servicio sobre HTTP/2.

Si terminas TLS en Kestrel, también necesitas certificados dentro del contenedor y exponer el puerto correcto. Es viable, solo que son más piezas en movimiento.

## Trampa 3: los sondeos de salud verifican lo que no deben

Los sondeos HTTP de Kubernetes y los sondeos básicos de balanceadores de carga suelen ser HTTP/1.1. Si sondeas tu endpoint gRPC directamente, puede fallar aun cuando el servicio esté sano.

Dos correcciones prácticas:

-   **Expón un endpoint HTTP plano** para los sondeos (como el `MapGet("/")` de arriba) en un puerto aparte, o en el mismo puerto si tu proxy lo soporta.
-   **Usa el chequeo de salud de gRPC** (`grpc.health.v1.Health`) si tu entorno soporta sondeos conscientes de gRPC.

## Trampa 4: los proxies y los valores por defecto de HTTP/2 te muerden

La forma más fácil de hacer que gRPC "parezca difícil" es poner delante un proxy que no esté configurado para HTTP/2 hacia el upstream. Asegúrate de configurar tu proxy de forma explícita para:

-   aceptar HTTP/2 desde los clientes
-   reenviar HTTP/2 al servicio upstream (no solo HTTP/1.1)

Ese último punto es donde muchas configuraciones por defecto de Nginx fallan con gRPC.

## Una configuración de contenedor que se mantiene aburrida

-   **Contenedor**: escucha en `8080` con `HttpProtocols.Http2`.
-   **Proxy/ingress**: termina TLS en `443`, habla HTTP/2 con el cliente y con el upstream.
-   **Observabilidad**: activa los logs estructurados para las fallas de solicitudes, e incluye los códigos de estado gRPC.

Si quieres un único punto de referencia antes de tocar Kubernetes, empieza validando en local: corre el contenedor, golpéalo con `grpcurl`, luego pon un proxy delante y verifica que sigue negociando HTTP/2 de extremo a extremo.

Lectura adicional: [https://learn.microsoft.com/aspnet/core/grpc/](https://learn.microsoft.com/aspnet/core/grpc/)
