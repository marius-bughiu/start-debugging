---
title: "grpc-dotnet 2.85 aplica MaxReceiveMessageSize después de la descompresión, no solo antes"
description: "Grpc.AspNetCore y Grpc.Net.Client 2.85.0 ahora aplican MaxReceiveMessageSize al tamaño descomprimido de los mensajes gzip y deflate. Una solicitud de 260 KB que se infla hasta 256 MiB se rechaza con ResourceExhausted, pero las cargas comprimidas grandes y legítimas también pueden empezar a fallar."
pubDate: 2026-10-31
tags:
  - "grpc"
  - "aspnetcore"
  - "dotnet"
  - "security"
  - "breaking-changes"
lang: "es"
translationOf: "2026/10/grpc-dotnet-2-85-enforces-maxreceivemessagesize-after-decompression"
translatedBy: "claude"
translationDate: 2026-10-31
---

[grpc-dotnet 2.85.0](https://github.com/grpc/grpc-dotnet/releases/tag/v2.85.0) se publicó el 29 de octubre de 2026, y `Grpc.AspNetCore.Server` y `Grpc.Net.Client` 2.85.0 ya están en NuGet. Las notas de la versión tienen cuatro líneas, y una de ellas es fácil de pasar por alto: "Enforce receive message size limits during decompression". Cierra una brecha real de agotamiento de memoria, y también puede empezar a rechazar tráfico que ayer funcionaba.

## Qué medía el límite antes

Tanto `GrpcServiceOptions.MaxReceiveMessageSize` en el servidor como `GrpcChannelOptions.MaxReceiveMessageSize` en el cliente tienen un valor predeterminado de 4 MB (4 194 304 bytes). Hasta la 2.84.0, esa comprobación se hacía contra el prefijo de longitud del frame de gRPC, que en un mensaje comprimido es el tamaño **comprimido**. Una vez superada la comprobación, el mensaje se inflaba con un simple `compressionStream.CopyTo(new MemoryStream())`, sin ningún tope.

Así, un par que enviara `grpc-encoding: gzip` podía pasar la comprobación de 4 MB con una carga diminuta y hacer que el otro lado reservara memoria para lo que fuera que los datos se inflaran. La reproducción del [PR #2780](https://github.com/grpc/grpc-dotnet/pull/2780) es una solicitud comprimida de 260 934 bytes que se expande a 256 MiB. No hacía falta activar nada: cuando `CompressionProviders` está vacío, `GrpcServiceOptionsSetup` registra `GzipCompressionProvider` y `DeflateCompressionProvider` por ti, y `GrpcChannel` incluye los mismos valores predeterminados. Todos los servicios gRPC de ASP.NET Core estaban expuestos a sus llamadores, y todos los clientes estaban expuestos a los servidores a los que llamaban.

## Cómo lee la 2.85.0 los mensajes comprimidos

La corrección mueve la descompresión de ambos lados a un `CommonGrpcProtocolHelpers.TryReadCompressedMessage` compartido. Cuando hay un límite configurado, lee el flujo de descompresión en bloques de 8 KB tomados de un pool y nunca pide más de un byte por encima del límite:

```csharp
// Read at most one byte beyond the limit to detect oversized messages without fully decompressing them.
while ((read = compressionStream.Read(buffer, 0, (int)Math.Min(buffer.Length, maxReceiveMessageSize.Value - output.Length + 1))) > 0)
{
    if (output.Length + read > maxReceiveMessageSize.Value)
    {
        message = default;
        return false;
    }

    output.Write(buffer, 0, read);
}
```

La llamada entonces falla con `StatusCode.ResourceExhausted` y el detalle "Received message exceeds the maximum configured message size." antes de que tu método de servicio o el deserializador del cliente vea nada. En la reproducción del PR, la bomba de 256 MiB ahora cuesta unos 9 MiB de asignaciones. La comprobación del frame comprimido sigue ejecutándose primero, un mensaje exactamente en el límite todavía se acepta, y un límite `null` mantiene el comportamiento anterior sin restricciones.

## El problema al actualizar: las cargas legítimas también cuentan

El límite ahora significa "el mensaje que recibe tu código", que es lo que la mayoría suponía que significaba. Pero si ya mueves mensajes comprimidos que se inflan por encima de 4 MB (exportaciones masivas, cargas por lotes, flujos de instantáneas de datos muy repetitivos), esas llamadas funcionaban en la 2.84.0 porque solo se comprobaba el tamaño comprimido. En la 2.85.0 reciben `ResourceExhausted`.

Sube el límite de forma deliberada y lo más acotada posible:

```csharp
builder.Services.AddGrpc(options =>
{
    options.ResponseCompressionAlgorithm = "gzip";
    // Global default stays at 4 MB
})
.AddServiceOptions<ExportService>(options =>
{
    // This service legitimately receives large batches
    options.MaxReceiveMessageSize = 32 * 1024 * 1024;
});

// Client side, for responses that inflate past 4 MB
using var channel = GrpcChannel.ForAddress("https://exports.internal", new GrpcChannelOptions
{
    MaxReceiveMessageSize = 32 * 1024 * 1024
});
```

Evita establecer `MaxReceiveMessageSize = null` para que los errores desaparezcan: eso restaura exactamente la inflación sin límite que esta versión elimina.

Antes de actualizar, averigua cuáles de tus llamadores comprimen realmente: busca en tus trazas un encabezado de solicitud `grpc-encoding` distinto de `identity`, o metadatos `grpc-internal-encoding-request` y `ResponseCompressionAlgorithm` en la configuración de tu cliente y servidor. Si nada comprime, la 2.85.0 es una actualización directa. Si algo comprime, mide el tamaño descomprimido de tu mensaje real más grande y fija el límite por servicio por encima de ese valor. Para una visión más amplia de dónde encaja gRPC frente a REST y SignalR, consulta [gRPC vs REST vs SignalR para llamadas de servicio a servicio en .NET 11](/es/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/).
