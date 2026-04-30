---
title: "gRPC в контейнерах кажется сложным в .NET 9 и .NET 10: 4 ловушки, которые можно исправить"
description: "Четыре частые ловушки при размещении gRPC в контейнерах с .NET 9 и .NET 10: несовпадение протокола HTTP/2, путаница с терминацией TLS, сломанные health-проверки и неверная настройка прокси -- с исправлением для каждой."
pubDate: 2026-01-10
tags:
  - "grpc"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "ru"
translationOf: "2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix"
translatedBy: "claude"
translationDate: 2026-04-30
---
Сегодня снова всплыло в r/dotnet: "Почему так сложно размещать gRPC-сервисы в контейнерах?". Короткий ответ: gRPC категоричен в отношении HTTP/2, а контейнеры делают сетевую границу более явной. Вы вынуждены решить, где терминируется TLS, какие порты говорят на HTTP/2 и какой прокси стоит спереди.

Исходное обсуждение: [https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/](https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/)

## Ловушка 1: порт контейнера доступен, но не говорит на HTTP/2

gRPC требует HTTP/2 от начала до конца. Если прокси понижает до HTTP/1.1, вы получаете загадочные сбои "unavailable", которые выглядят как баги приложения.

В .NET 9 / .NET 10 явно укажите намерение сервера:

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

## Ловушка 2: терминация TLS не определена (а gRPC-клиентам это важно)

Многие команды считают, что "контейнер = TLS". На практике терминировать TLS на границе проще:

-   **Kestrel**: запускайте HTTP/2 без TLS на `8080` внутри кластера.
-   **Ingress / обратный прокси**: терминируйте TLS и пересылайте сервису по HTTP/2.

Если вы всё-таки терминируете TLS в Kestrel, вам также нужны сертификаты внутри контейнера и нужный открытый порт. Это работоспособно, просто больше движущихся частей.

## Ловушка 3: health-проверки опрашивают не то

HTTP-пробы Kubernetes и базовые пробы балансировщиков нагрузки часто работают по HTTP/1.1. Если вы опрашиваете gRPC-эндпоинт напрямую, он может падать, даже когда сервис здоров.

Два практических решения:

-   **Откройте простой HTTP-эндпоинт** для проб (как `MapGet("/")` выше) на отдельном порту или на том же порту, если ваш прокси это поддерживает.
-   **Используйте gRPC health checking** (`grpc.health.v1.Health`), если ваше окружение поддерживает gRPC-осведомлённые пробы.

## Ловушка 4: прокси и значения HTTP/2 по умолчанию вас кусают

Самый простой способ заставить gRPC "казаться сложным" -- поставить впереди прокси, который не настроен на HTTP/2 в сторону upstream. Убедитесь, что ваш прокси явно настроен:

-   принимать HTTP/2 от клиентов
-   пересылать HTTP/2 в upstream-сервис (не только HTTP/1.1)

Именно на этом последнем пункте многие конфигурации Nginx по умолчанию ломаются с gRPC.

## Конфигурация контейнера, которая остаётся скучной

-   **Контейнер**: слушает на `8080` с `HttpProtocols.Http2`.
-   **Прокси/ingress**: терминирует TLS на `443`, говорит на HTTP/2 и с клиентом, и с upstream.
-   **Наблюдаемость**: включите структурированные журналы для сбоев запросов и пишите gRPC-коды состояния.

Если хочется единой точки отсчёта, прежде чем трогать Kubernetes, начните с локальной проверки: запустите контейнер, постучитесь к нему через `grpcurl`, затем поставьте прокси спереди и убедитесь, что HTTP/2 по-прежнему согласовывается от начала до конца.

Дополнительно: [https://learn.microsoft.com/aspnet/core/grpc/](https://learn.microsoft.com/aspnet/core/grpc/)
