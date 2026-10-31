---
title: "grpc-dotnet 2.85 применяет MaxReceiveMessageSize после распаковки, а не только до неё"
description: "Grpc.AspNetCore и Grpc.Net.Client 2.85.0 теперь применяют MaxReceiveMessageSize к распакованному размеру сообщений gzip и deflate. Запрос в 260 КБ, который разворачивается в 256 МиБ, отклоняется с ResourceExhausted, но и легитимные крупные сжатые данные могут начать завершаться ошибкой."
pubDate: 2026-10-31
tags:
  - "grpc"
  - "aspnetcore"
  - "dotnet"
  - "security"
  - "breaking-changes"
lang: "ru"
translationOf: "2026/10/grpc-dotnet-2-85-enforces-maxreceivemessagesize-after-decompression"
translatedBy: "claude"
translationDate: 2026-10-31
---

[grpc-dotnet 2.85.0](https://github.com/grpc/grpc-dotnet/releases/tag/v2.85.0) вышел 29 октября 2026 года, а `Grpc.AspNetCore.Server` и `Grpc.Net.Client` 2.85.0 уже доступны в NuGet. Примечания к релизу состоят из четырёх строк, и одну из них легко пропустить: "Enforce receive message size limits during decompression". Она закрывает реальную дыру, позволявшую исчерпать память, и при этом может начать отклонять трафик, который вчера работал.

## Что измерял лимит раньше

И `GrpcServiceOptions.MaxReceiveMessageSize` на сервере, и `GrpcChannelOptions.MaxReceiveMessageSize` на клиенте по умолчанию равны 4 МБ (4 194 304 байта). До версии 2.84.0 эта проверка выполнялась по префиксу длины кадра gRPC, а для сжатого сообщения это **сжатый** размер. После прохождения проверки сообщение распаковывалось простым `compressionStream.CopyTo(new MemoryStream())`, вообще без ограничения.

Поэтому сторона, отправившая `grpc-encoding: gzip`, могла пройти проверку в 4 МБ крошечной нагрузкой и заставить другую сторону выделить столько памяти, во сколько разворачиваются данные. Воспроизведение в [PR #2780](https://github.com/grpc/grpc-dotnet/pull/2780) использует сжатый запрос в 260 934 байта, который разворачивается в 256 МиБ. Включать ничего не требовалось: когда `CompressionProviders` пуст, `GrpcServiceOptionsSetup` сам регистрирует `GzipCompressionProvider` и `DeflateCompressionProvider`, а `GrpcChannel` поставляется с теми же значениями по умолчанию. Каждый gRPC-сервис на ASP.NET Core был уязвим для своих вызывающих сторон, а каждый клиент был уязвим для серверов, к которым обращался.

## Как 2.85.0 читает сжатые сообщения

Исправление переносит распаковку на обеих сторонах в общий `CommonGrpcProtocolHelpers.TryReadCompressedMessage`. Если лимит задан, он читает поток распаковки порциями по 8 КБ из пула и никогда не запрашивает больше чем на один байт сверх лимита:

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

После этого вызов завершается с `StatusCode.ResourceExhausted` и подробностью "Received message exceeds the maximum configured message size." ещё до того, как ваш метод сервиса или десериализатор клиента что-либо увидит. В воспроизведении из PR бомба на 256 МиБ теперь обходится примерно в 9 МиБ выделений. Проверка сжатого кадра по-прежнему выполняется первой, сообщение ровно на границе лимита по-прежнему принимается, а лимит `null` сохраняет прежнее неограниченное поведение.

## Подводный камень при обновлении: легитимные данные тоже учитываются

Теперь лимит означает "сообщение, которое получает ваш код", именно так его и понимало большинство. Но если вы уже передаёте сжатые сообщения, которые разворачиваются больше чем на 4 МБ (массовые выгрузки, пакетные загрузки, потоки снимков из сильно повторяющихся данных), на 2.84.0 эти вызовы работали, потому что проверялся только сжатый размер. На 2.85.0 они получают `ResourceExhausted`.

Повышайте лимит осознанно и как можно точечнее:

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

Не задавайте `MaxReceiveMessageSize = null`, чтобы избавиться от ошибок: это вернёт именно ту неограниченную распаковку, которую убирает этот релиз.

Перед обновлением выясните, какие из ваших вызывающих сторон действительно используют сжатие: поищите в трассировках заголовок запроса `grpc-encoding` со значением, отличным от `identity`, а в настройке клиента и сервера поищите метаданные `grpc-internal-encoding-request` и `ResponseCompressionAlgorithm`. Если ничто не сжимает данные, 2.85.0 обновляется без последствий. Если что-то сжимает, измерьте распакованный размер самого большого реального сообщения и задайте лимит для сервиса выше него. Более широкую картину того, где gRPC находится рядом с REST и SignalR, смотрите в статье [gRPC vs REST vs SignalR для вызовов между сервисами в .NET 11](/ru/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/).
