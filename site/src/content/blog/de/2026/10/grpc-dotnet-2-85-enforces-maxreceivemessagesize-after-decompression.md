---
title: "grpc-dotnet 2.85 erzwingt MaxReceiveMessageSize auch nach der Dekomprimierung, nicht nur davor"
description: "Grpc.AspNetCore und Grpc.Net.Client 2.85.0 wenden MaxReceiveMessageSize jetzt auf die dekomprimierte Größe von gzip- und deflate-Nachrichten an. Eine 260 KB große Anfrage, die auf 256 MiB anwächst, wird mit ResourceExhausted abgelehnt, doch auch legitime große komprimierte Payloads können künftig fehlschlagen."
pubDate: 2026-10-31
tags:
  - "grpc"
  - "aspnetcore"
  - "dotnet"
  - "security"
  - "breaking-changes"
lang: "de"
translationOf: "2026/10/grpc-dotnet-2-85-enforces-maxreceivemessagesize-after-decompression"
translatedBy: "claude"
translationDate: 2026-10-31
---

[grpc-dotnet 2.85.0](https://github.com/grpc/grpc-dotnet/releases/tag/v2.85.0) erschien am 29. Oktober 2026, und `Grpc.AspNetCore.Server` sowie `Grpc.Net.Client` 2.85.0 sind bereits auf NuGet verfügbar. Die Release Notes umfassen vier Zeilen, und eine davon überliest man leicht: "Enforce receive message size limits during decompression". Sie schließt eine reale Lücke bei der Speichererschöpfung und kann zugleich Datenverkehr ablehnen, der gestern noch funktionierte.

## Was das Limit bisher gemessen hat

Sowohl `GrpcServiceOptions.MaxReceiveMessageSize` auf dem Server als auch `GrpcChannelOptions.MaxReceiveMessageSize` auf dem Client stehen standardmäßig auf 4 MB (4.194.304 Bytes). Bis 2.84.0 wurde diese Prüfung gegen das Längenpräfix des gRPC-Frames ausgeführt, bei einer komprimierten Nachricht also gegen die **komprimierte** Größe. Nach bestandener Prüfung wurde die Nachricht mit einem schlichten `compressionStream.CopyTo(new MemoryStream())` entpackt, ganz ohne Obergrenze.

Ein Gegenüber, das `grpc-encoding: gzip` sendete, konnte die 4-MB-Prüfung also mit einer winzigen Payload bestehen und die andere Seite dazu bringen, beliebig viel Speicher für die entpackten Daten zu reservieren. Die Reproduktion in [PR #2780](https://github.com/grpc/grpc-dotnet/pull/2780) ist eine 260.934 Bytes große komprimierte Anfrage, die auf 256 MiB anwächst. Man musste dafür nichts aktivieren: Ist `CompressionProviders` leer, registriert `GrpcServiceOptionsSetup` automatisch `GzipCompressionProvider` und `DeflateCompressionProvider`, und `GrpcChannel` bringt dieselben Standardwerte mit. Jeder ASP.NET Core gRPC-Dienst war gegenüber seinen Aufrufern angreifbar, und jeder Client gegenüber den Servern, die er aufrief.

## Wie 2.85.0 komprimierte Nachrichten liest

Der Fix verlagert die Dekomprimierung auf beiden Seiten in ein gemeinsames `CommonGrpcProtocolHelpers.TryReadCompressedMessage`. Ist ein Limit konfiguriert, liest es den Dekomprimierungs-Stream in 8-KB-Chunks aus einem Pool und fordert nie mehr als ein Byte über dem Limit an:

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

Der Aufruf scheitert dann mit `StatusCode.ResourceExhausted` und dem Detail "Received message exceeds the maximum configured message size.", bevor Ihre Dienstmethode oder der Deserialisierer des Clients etwas zu sehen bekommt. In der Reproduktion des PR kostet die 256-MiB-Bombe jetzt etwa 9 MiB an Allokationen. Die Prüfung des komprimierten Frames läuft weiterhin zuerst, eine Nachricht exakt am Limit wird weiterhin akzeptiert, und ein `null`-Limit behält das alte unbegrenzte Verhalten bei.

## Die Stolperfalle beim Upgrade: Auch legitime Payloads zählen

Das Limit bedeutet nun "die Nachricht, die Ihr Code erhält", so wie es die meisten ohnehin verstanden hatten. Wenn Sie jedoch bereits komprimierte Nachrichten übertragen, die auf mehr als 4 MB anwachsen (Bulk-Exporte, Batch-Uploads, Snapshot-Streams mit sehr repetitiven Daten), funktionierten diese Aufrufe unter 2.84.0, weil nur die komprimierte Größe geprüft wurde. Unter 2.85.0 erhalten sie `ResourceExhausted`.

Erhöhen Sie das Limit gezielt und so eng wie möglich:

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

Setzen Sie nicht `MaxReceiveMessageSize = null`, um die Fehler loszuwerden: Das stellt genau das unbegrenzte Entpacken wieder her, das dieses Release beseitigt.

Finden Sie vor dem Upgrade heraus, welche Ihrer Aufrufer tatsächlich komprimieren: Suchen Sie in Ihren Traces nach einem `grpc-encoding`-Request-Header mit einem anderen Wert als `identity`, oder nach `grpc-internal-encoding-request`-Metadaten und `ResponseCompressionAlgorithm` in Ihrer Client- und Server-Konfiguration. Wenn nichts komprimiert, ist 2.85.0 ein direkter Austausch. Wenn doch, messen Sie die dekomprimierte Größe Ihrer größten realen Nachricht und setzen das Limit pro Dienst darüber. Einen breiteren Überblick, wo gRPC im Vergleich zu REST und SignalR steht, finden Sie in [gRPC vs REST vs SignalR für Dienst-zu-Dienst-Aufrufe in .NET 11](/de/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/).
