---
title: "Kestrel начинает обрабатывать HTTP/3 запросы до SETTINGS-кадра в .NET 11 Preview 3"
description: ".NET 11 Preview 3 позволяет Kestrel обслуживать HTTP/3 запросы до прибытия control stream и SETTINGS-кадра пира, срезая задержку handshake у первого запроса каждого нового QUIC-соединения."
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "ASP.NET Core"
  - "Kestrel"
  - "HTTP/3"
  - "Performance"
lang: "ru"
translationOf: "2026/04/aspnetcore-11-kestrel-http3-early-request-processing"
translatedBy: "claude"
translationDate: 2026-04-24
---

Один из небольших, но заметных выигрышей в [анонсе .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) - изменение Kestrel для HTTP/3: сервер больше не ждёт, пока приземлятся control stream клиента и SETTINGS-кадр, прежде чем начать обработку запросов. Изменение приземлилось в [dotnet/aspnetcore #65399](https://github.com/dotnet/aspnetcore/pull/65399) и нацелено на задержку первого запроса на новеньких QUIC-соединениях - именно туда, где HTTP/3 раньше уступал уже прогретому HTTP/2.

## Сколько раньше стоил вам HTTP/3 handshake

HTTP/3 работает поверх QUIC, поэтому транспортный handshake (TLS 1.3 + QUIC) уже сложен в установку соединения. Сверху протокол определяет однонаправленный control stream, по которому каждая сторона сначала отправляет `SETTINGS`-кадр. Эти настройки анонсируют такие вещи, как `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, `SETTINGS_QPACK_BLOCKED_STREAMS` и `SETTINGS_MAX_FIELD_SECTION_SIZE`. Kestrel прежде блокировал конвейер обработки запросов на этом первом кадре от пира. На практике это значило, что новому соединению приходилось ждать один дополнительный логический roundtrip после QUIC handshake до запуска ваших `Map*`-обработчиков, даже если клиент уже 0-RTT отправил `HEADERS`-кадр на стриме запроса.

Симптом виден, если вывалить трассу соединения через `Logging__LogLevel__Microsoft.AspNetCore.Server.Kestrel=Trace`:

```text
Connection id "0HN7..." accepted (HTTP/3).
Stream id "0" started (control).
Waiting for SETTINGS frame from peer.
Stream id "4" started (request).  <-- request arrived, but not dispatched yet
SETTINGS frame received.
Dispatching request on stream id "4".
```

Эта пауза `Waiting for SETTINGS frame` масштабируется с RTT до пира, а не с работой сервера.

## Что меняет Preview 3

В Preview 3 Kestrel диспатчит стримы запросов, как только они приходят, и применяет настройки пира, когда подтянется control stream. Спецификация это допускает: раздел 6.2.1 RFC 9114 разрешает реализациям начинать обработку кадров на стримах запросов параллельно с handshake control stream, если они ретроактивно навязывают настройки тому, что ещё не зафиксировало решение на проводе.

На уровне ваших обработчиков ничего не меняется, тот же minimal API продолжает работать:

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

Эффект Preview 3 - на проводе: `HEADERS`-кадр на стриме 4 выше теперь диспатчится немедленно, а `SETTINGS`-кадр применяется к любым QPACK-кодированным полям, которые ещё не декодированы. Для простого `GET /ping`, не отправляющего ссылок на динамическую таблицу, запрос завершается, так и не дождавшись control stream.

## Что проверить со своей стороны

Прежде чем опираться на новое поведение, стоит проверить две оговорки.

Во-первых, если вы шлёте большие заголовки ответа, Kestrel по-прежнему уважает финальный `SETTINGS_MAX_FIELD_SECTION_SIZE` пира перед тем, как сериализовать `HEADERS`-кадр обратно. Если пир ещё не отправил SETTINGS, действует дефолт из [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114#name-settings) (без ограничения), а значит ваш ответ всё равно может быть отклонён позже, если реальный setting пира меньше. Держите заголовки ответа маленькими на первом запросе соединения.

Во-вторых, всё, что измеряется как time-to-first-byte на новой QUIC-сессии, должно заметно упасть. Тесный локальный бенчмарк по loopback с искусственной задержкой пира 50 мс показал падение первого запроса с примерно `2 * RTT + server_time` до `1 * RTT + server_time`. Последующие запросы по тому же соединению уже не страдали до Preview 3 и не страдают сейчас.

Если вы запускаете HTTP/3 за YARP или API gateway, убедитесь, что обновляетесь до .NET 11 Preview 3 от и до; выигрыш на стороне Kestrel за QUIC-хопом, поэтому увидите его на reverse proxy. Полный набор заметок по HTTP/3 и Kestrel для этой preview - в [release notes ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md).
