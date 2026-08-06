---
title: "gRPC vs REST vs SignalR para llamadas entre servicios en .NET 11"
description: "Para llamadas internas entre servicios en .NET 11, elige gRPC por defecto cuando controlas ambos extremos del contrato y la llamada es punto a punto. Usa REST con JSON cuando algo que no controlas tiene que llamar al servicio. SignalR no es un transporte RPC entre servicios: recurre a él solo cuando un productor debe distribuir un mensaje a muchos consumidores de larga vida."
pubDate: 2026-08-06
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "grpc"
  - "signalr"
  - "csharp"
lang: "es"
translationOf: "2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-06
---

Si el servicio A llama al servicio B y nada más llama a B, usa gRPC. Controlas ambos extremos, así que un cliente generado y un contrato binario no te cuestan nada y te dan una carga útil de aproximadamente la mitad del tamaño del equivalente en JSON, además de propagación real de deadlines. Usa REST con JSON en cuanto algo que no controlas tenga que llamar al servicio: un navegador, un socio, un comando curl en un manual de operaciones. SignalR es el caso raro, y el error más común en esta comparación es tratarlo como una tercera opción de RPC. No lo es. SignalR es una capa de gestión de conexiones y distribución, y solo se gana su lugar cuando un productor tiene que enviar mensajes a muchos consumidores de larga vida. Todo lo que sigue apunta a .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`, GA prevista para noviembre de 2026) y C# 14, con `Grpc.AspNetCore` 2.83.0.

## La decisión en una tabla

| Característica | gRPC | REST con JSON | SignalR |
| --- | --- | --- | --- |
| Forma de la llamada | RPC punto a punto | Solicitud/respuesta punto a punto | Un productor, muchos consumidores |
| Contrato | Obligatorio, `.proto` | Opcional, OpenAPI | Ninguno, nombres de método por cadena |
| Protocolo | HTTP/2 (obligatorio) | HTTP/1.1, HTTP/2, HTTP/3 | WebSockets, SSE, long polling |
| Carga útil | Protobuf, binaria | JSON, texto | JSON o MessagePack |
| Cliente | Generado desde `.proto` | Escrito a mano o generado desde OpenAPI | Escrito a mano, cadenas para nombres de método |
| Streaming | Cliente, servidor, bidireccional | Servidor (chunked / SSE) | Servidor, cliente, bidireccional |
| La cancelación del llamador llega al llamado | Sí, más un deadline nativo | Solo como aborto de conexión | Sí desde .NET 11, invocaciones sin streaming |
| Se puede llamar desde un navegador | No, requiere gRPC-Web o transcodificación | Sí | Sí, ese es el objetivo |
| Funciona detrás de un balanceador L4 | Mal | Sí | Requiere sesiones persistentes o un backplane |
| Legible por humanos en el cable | No | Sí | Sí con JSON, no con MessagePack |
| Viene incluido con ASP.NET Core | No, paquete NuGet aparte | Sí | Sí |

Dos filas deciden casi todos los casos reales. "Forma de la llamada" separa SignalR de las otras dos, y "contrato" separa gRPC de REST. Si te encuentras sopesando filas más abajo en la tabla, probablemente ya tomaste la decisión y estás buscando permiso.

## Por qué SignalR sigue apareciendo en esta comparación, y por qué normalmente pierde

SignalR aparece en las búsquedas sobre comunicación entre servicios porque un método de hub se parece exactamente a un RPC:

```csharp
// .NET 11, C# 14 -- looks like RPC, is not built for it
public sealed class PricingHub : Hub
{
    public Task<decimal> GetPrice(string sku) => _pricing.LookupAsync(sku);
}
```

Un llamador puede perfectamente hacer `InvokeAsync<decimal>("GetPrice", sku)` desde otro servicio y obtener una respuesta. Funciona. Sin embargo, lo que has construido es un canal RPC sobre una tecnología cuyo centro de diseño completo es la gestión del ciclo de vida de conexiones para clientes que van y vienen. Heredas los costes de ese diseño sin necesitar ninguno de sus beneficios.

Los costes concretos: los nombres de método son cadenas resueltas por reflexión en tiempo de despacho, así que renombrar produce un fallo en ejecución en lugar de un fallo de compilación. No hay esquema, así que nada genera un cliente y nada valida la forma de la carga útil. Escalar horizontalmente significa que cada servidor del grupo debe alcanzar cada conexión, lo que implica un backplane de Redis o el Azure SignalR Service, más sesiones persistentes si no estás sobre WebSockets. Y una conexión de hub tiene estado: tu llamador ahora tiene que razonar sobre una máquina de estados de reconexión para lo que antes era una solicitud sin estado.

SignalR es la respuesta correcta cuando el tráfico realmente es distribución a muchos. Un servicio de precios que debe enviar actualizaciones de cotizaciones a cuarenta procesos worker es un problema de SignalR, porque SignalR tiene grupos, difusión y un backplane, y gRPC no tiene ninguno de esos. La propia [comparación entre gRPC y las API HTTP](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison) de Microsoft lo dice directamente: gRPC soporta streaming pero no tiene el concepto de difundir a conexiones registradas, así que cada llamada gRPC tiene que transmitir a su cliente individualmente.

La distinción es la distribución a muchos, no el "tiempo real". El streaming bidireccional de gRPC es tiempo real. Simplemente es punto a punto.

## Qué pone realmente cada uno en el cable

El argumento de rendimiento a favor de gRPC suele enunciarse como "Protobuf es más pequeño que JSON" sin ningún número asociado. Aquí está el número, para un mensaje con la forma de una respuesta interna típica:

```protobuf
// proto3
message OrderStatus {
  string order_id   = 1;  // "8f14e45f-ceea-467a-9c1d-2b7f2f0c3a11"
  int32  status     = 2;  // 3
  int64  updated_at = 3;  // 1786060800
  double total      = 4;  // 129.95
  string currency   = 5;  // "EUR"
}
```

| Codificación | Bytes del mensaje | Bytes con framing | Proporción vs JSON |
| --- | --- | --- | --- |
| JSON (`System.Text.Json`, opciones por defecto) | 116 | 116 | 100% |
| MessagePack (protocolo binario de hub de SignalR) | 66 | n/d | 56.9% |
| Protobuf (`Google.Protobuf` 3.35.1) | 60 | 65 | 51.7% |
| Invocación del protocolo JSON de hub de SignalR | n/d | 165 | 142% |

**Metodología**: se serializaron las mismas cinco propiedades en cada codificación y se contaron los bytes, medido en Windows 11 con el runtime .NET 10.0.5 (SDK 10.0.201), `Google.Protobuf` 3.35.1 y `MessagePack` 3.1.8. Los formatos de cable están especificados independientemente de la versión del runtime, así que los conteos de bytes son idénticos en .NET 11; solo cambia el runtime que hace la codificación. "Bytes con framing" añade el prefijo de longitud de cinco bytes de gRPC (un byte de bandera de compresión más cuatro bytes de longitud big-endian) y, para SignalR, el sobre de invocación JSON más el separador de registro `0x1E`.

Lee esa tabla con atención antes de usarla para justificar nada. Protobuf ahorra 56 bytes en un mensaje de 116 bytes. En un servicio que atiende diez mil llamadas por segundo eso son 560 KB/s de salida, lo cual importa si pagas por tráfico entre zonas y es ruido si no lo haces. La fila de SignalR es la interesante: el sobre del protocolo JSON de hub hace que una sola invocación sea *más grande* que el equivalente REST plano, porque estás pagando por `type`, `target` y `arguments` además de la carga útil. Cambiar un hub a MessagePack recupera la mayor parte de eso, a costa de la legibilidad humana que era la razón para considerar un protocolo de texto en primer lugar.

El tamaño de serialización también es la más débil de las ventajas de gRPC. Las más fuertes son el cliente generado y el deadline.

## Cuándo elegir gRPC

- **Interno, punto a punto, y controlas ambos repositorios.** El archivo `.proto` es el contrato, ambos lados generan a partir de él, y un campo que renombras rompe la compilación en ambos lados en el mismo pull request. Ese es todo el argumento, y vale más que el conteo de bytes.
- **Necesitas deadlines que lleguen al llamado.** Un deadline de gRPC viaja con la llamada, así que el servicio B sabe cuánto tiempo está dispuesto a esperar todavía el servicio A y puede abandonar su propia consulta a la base de datos. HTTP no tiene equivalente: cancelar una solicitud de `HttpClient` aborta la conexión y el servidor observa `HttpContext.RequestAborted`, pero nada le comunica al servidor el presupuesto original.
- **Llamadores en varios lenguajes.** Un servicio en Go o Python que consume tu `.proto` obtiene un cliente real gratis. Entregarle al mismo equipo un documento OpenAPI y desearle suerte es una experiencia peor.
- **Rutas calientes con mucha conversación.** Una vez que un stream bidireccional está abierto, los mensajes viajan sobre una solicitud HTTP/2 existente en lugar de pagar por una nueva en cada llamada. La [guía de rendimiento de gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance) de Microsoft recomienda esto explícitamente como técnica avanzada para rutas de alto rendimiento, con la advertencia de que `RequestStream.WriteAsync` no es seguro para múltiples hilos y necesitas un `Channel<T>` para ordenar las escrituras.

```csharp
// .NET 11, C# 14 -- Grpc.AspNetCore 2.83.0
// Server
builder.Services.AddGrpc();
app.MapGrpcService<OrderService>();

// Client: register through the factory so channels are reused.
builder.Services
    .AddGrpcClient<Orders.OrdersClient>(o => o.Address = new Uri("https://orders"))
    .AddStandardResilienceHandler();

// Call site: the deadline is the point.
var reply = await client.GetStatusAsync(
    new OrderRequest { OrderId = id },
    deadline: DateTime.UtcNow.AddSeconds(2),
    cancellationToken: ct);
```

Usa `AddGrpcClient` en lugar de `GrpcChannel.ForAddress` en el código de aplicación. Crear un canal por llamada fuerza un socket nuevo, un handshake TCP, una negociación TLS y un preámbulo de conexión HTTP/2 cada vez, y la factoría reutiliza el canal por ti. Si estás superponiendo reintentos, el mismo [handler de resiliencia que envuelve HttpClient](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) se aplica aquí, porque un canal gRPC es un `SocketsHttpHandler` por debajo.

## Cuándo elegir REST con JSON

- **Lo llama cualquier cosa para la que no puedas regenerar un cliente.** Los navegadores no hablan gRPC en absoluto, y tanto gRPC-Web como la transcodificación JSON son adiciones reales a tu topología de despliegue. Si la respuesta a "quién llama a esto" incluye a alguien fuera de tu compilación, publica JSON.
- **La llamada es poco frecuente.** Un trabajo nocturno de conciliación que llama a un endpoint no justifica un archivo `.proto`, un paso de generación de código en CI y un segundo protocolo en tu service mesh.
- **Quieres depurarlo con las herramientas que ya tienes.** Protobuf en el cable es opaco sin el esquema. Un 500 a las 3 de la mañana es más fácil de diagnosticar cuando puedes reproducir la solicitud con curl.
- **Tu balanceador de carga es L4.** Esto no es una preferencia, y se trata más abajo.

```csharp
// .NET 11, C# 14 -- minimal API + typed client
app.MapGet("/orders/{id}", async (string id, IOrderStore store, CancellationToken ct)
    => await store.FindAsync(id, ct) is { } o
        ? Results.Ok(o)
        : Results.NotFound());

// Caller
builder.Services
    .AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders"))
    .AddStandardResilienceHandler();
```

Para algo más estructurado que esto, [devolver una unión Results tipada](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) te da comprobación en tiempo de compilación de las formas de respuesta y un documento OpenAPI correcto sin atributos escritos a mano, lo que recupera una parte de la disciplina de contrato que hacía atractivo a gRPC.

## Cuándo SignalR es realmente la elección correcta

- **Un productor, muchos consumidores de larga vida, y cada consumidor necesita el mismo mensaje.** Cotizaciones de precios, estado de una cola de trabajos, invalidación de configuración. Los grupos y la difusión son las funcionalidades que estás comprando.
- **El conjunto de consumidores cambia en tiempo de ejecución.** SignalR gestiona conexión, desconexión y reconexión. Reimplementar eso sobre streams de gRPC es un proyecto.
- **Algunos de los consumidores son navegadores.** Si un panel de control y un conjunto de servicios worker necesitan el mismo flujo, un solo hub sirve a ambos, y ninguna configuración de gRPC sirve al navegador sin un proxy.

.NET 11 mejora SignalR de forma significativa para conexiones de larga vida en dos aspectos. El endpoint `/refresh` junto con `EnableAuthenticationRefresh` hace que una conexión de hub ya no se caiga cuando expira su token bearer, lo cual era la mayor fuente individual de reconexiones espurias en despliegues autenticados por token. Y los [clientes de SignalR por fin pueden cancelar un método de hub en ejecución](/es/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/), así que cancelar el `CancellationToken` que pasaste a `InvokeAsync` realmente llega al servidor. Ambas funcionalidades son solo para el cliente .NET en Preview 6; el soporte para el cliente JavaScript y para el Azure SignalR Service sigue en progreso.

## Los detalles que deciden por ti

**Los balanceadores de carga L4 rompen gRPC.** Un canal gRPC es una conexión HTTP/2, y cada llamada se multiplexa sobre ella. Un balanceador L4 distribuye conexiones TCP, así que cada llamada de ese canal aterriza en el mismo backend para siempre. Tu flota acaba con una instancia caliente y muchas ociosas. Arreglarlo significa balanceo de carga del lado del cliente o un proxy L7 como Envoy, Linkerd o YARP, y esa decisión suele pertenecer a un equipo de plataforma más que a ti. Si no puedes hacer ese cambio, la comparación ha terminado y gana REST. La misma clase de fricción de infraestructura aparece al [ejecutar gRPC en contenedores](/es/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/), donde un proxy que solo habla HTTP/1.1 produce fallos que no se parecen en nada a una discrepancia de protocolo.

**gRPC se publica fuera del ciclo de .NET, y la lista de TFM lo demuestra.** `Grpc.AspNetCore` 2.83.0, publicado el 2026-08-03, apunta a `net8.0`, `net9.0` y `net10.0`. No hay un target framework `net11.0`, y no hay ninguna sección sobre gRPC en las notas de la versión [Novedades de ASP.NET Core en .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11). Esto no es una laguna de soporte: un ensamblado `net10.0` se carga y se ejecuta en .NET 11. Es una diferencia de cadencia. gRPC en .NET se mantiene en `grpc/grpc-dotnet` con su propio calendario de publicación, así que una funcionalidad de .NET 11 que beneficiaría a gRPC llega cuando grpc-dotnet la publique, no en noviembre. Planifica tus notas de actualización en consecuencia.

**HTTP/2 es obligatorio para gRPC y opcional para todo lo demás.** Eso es una restricción real en cualquier salto donde no controles los intermediarios. También significa que gRPC no se beneficia de HTTP/3 hoy, mientras que un endpoint REST sí: [configurar Kestrel para servir HTTP/3](/es/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/) es un cambio de una línea en el endpoint, y el Kestrel de .NET 11 ahora empieza a procesar solicitudes HTTP/3 sin esperar al stream de control y al frame SETTINGS, reduciendo la latencia de la primera solicitud en conexiones nuevas.

**El escalado horizontal de SignalR es una dependencia, no un ajuste.** Más de una instancia de servidor significa un backplane de Redis o el Azure SignalR Service, y los transportes que no son WebSocket necesitan además sesiones persistentes. Compara eso con un endpoint REST sin estado detrás de un balanceador round-robin antes de decidir que la distribución a muchos merece la pena.

**La observabilidad no es igual.** Los tres emiten trazas de `ActivitySource` que fluyen a través de OpenTelemetry, así que [conectar las trazas a un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) los cubre a todos. Lo que difiere es qué puedes ver en una captura de red: JSON es legible, Protobuf y MessagePack necesitan el esquema y herramientas.

## La recomendación, repetida

Traza la frontera primero en la distribución a muchos. Si un servicio tiene que notificar a muchos consumidores de larga vida, eso es SignalR, y ninguno de los otros dos tiene sustituto para los grupos y un backplane. Todo lo demás es punto a punto, y ahí la pregunta es quién es dueño del contrato. Si controlas ambos extremos y puedes regenerar clientes en el mismo pull request que cambia el esquema, gRPC se paga solo mediante el cliente generado y los deadlines propagados, con la carga útil más pequeña como bonificación en lugar de como razón. Si alguien fuera de tu compilación llama al servicio, publica REST con JSON y deja de optimizar bytes que no estás pagando.

El modo de fallo que conviene evitar es elegir gRPC para un servicio con tres llamadas por minuto porque un benchmark mostró un 51.7% de tamaño de carga útil, y luego descubrir que tu balanceador L4 fija cada llamada a un solo pod. Cincuenta y seis bytes por mensaje no valen una migración de plataforma.

## Relacionado

- [gRPC en contenedores parece difícil en .NET 9 y .NET 10: 4 trampas que puedes arreglar](/es/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- [Los clientes de SignalR por fin pueden cancelar un método de hub en ejecución en .NET 11 Preview 6](/es/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/)
- [Cómo configurar Kestrel para servir HTTP/3 en ASP.NET Core 11](/es/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/)
- [Polly vs handlers de resiliencia en .NET 11: ¿cuál deberías usar?](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)

## Fuentes

- [Compare gRPC services with HTTP APIs](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison), Microsoft Learn
- [Performance best practices with gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance), Microsoft Learn
- [Overview of ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), Microsoft Learn
- [Grpc.AspNetCore 2.83.0](https://www.nuget.org/packages/Grpc.AspNetCore), NuGet
- [SignalR Hub Protocol specification](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md), dotnet/aspnetcore
- [gRPC over HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md), grpc/grpc
