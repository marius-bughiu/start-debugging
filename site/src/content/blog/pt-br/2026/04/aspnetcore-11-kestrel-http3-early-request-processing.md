---
title: "Kestrel começa a processar requisições HTTP/3 antes do frame SETTINGS no .NET 11 Preview 3"
description: ".NET 11 Preview 3 permite o Kestrel servir requisições HTTP/3 antes do control stream e do frame SETTINGS do peer chegarem, cortando latência de handshake na primeira requisição de cada nova conexão QUIC."
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "ASP.NET Core"
  - "Kestrel"
  - "HTTP/3"
  - "Performance"
lang: "pt-br"
translationOf: "2026/04/aspnetcore-11-kestrel-http3-early-request-processing"
translatedBy: "claude"
translationDate: 2026-04-24
---

Um dos ganhos pequenos mas visíveis no [anúncio do .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) é uma mudança no Kestrel para HTTP/3: o servidor não espera mais o control stream do cliente e o frame SETTINGS aterrissarem antes de começar a processar requisições. A mudança chegou em [dotnet/aspnetcore #65399](https://github.com/dotnet/aspnetcore/pull/65399) e mira a latência da primeira requisição em conexões QUIC novinhas, que é exatamente onde o HTTP/3 perdia terreno para uma conexão HTTP/2 já aquecida.

## O que o handshake HTTP/3 custava antes

HTTP/3 roda sobre QUIC, então o handshake de transporte (TLS 1.3 + QUIC) já está dobrado no setup da conexão. Por cima, o protocolo define um control stream unidirecional no qual cada lado envia primeiro um frame `SETTINGS`. Esses settings anunciam coisas como `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, `SETTINGS_QPACK_BLOCKED_STREAMS` e `SETTINGS_MAX_FIELD_SECTION_SIZE`. O Kestrel anteriormente bloqueava o pipeline de processamento de requisição nesse primeiro frame do peer. Na prática isso significava que uma conexão nova precisava esperar um roundtrip lógico extra depois do handshake QUIC antes dos seus handlers `Map*` rodarem, mesmo que o cliente já tivesse feito 0-RTT de um frame `HEADERS` num stream de requisição.

Você consegue ver o sintoma se despejar o trace da conexão com `Logging__LogLevel__Microsoft.AspNetCore.Server.Kestrel=Trace`:

```text
Connection id "0HN7..." accepted (HTTP/3).
Stream id "0" started (control).
Waiting for SETTINGS frame from peer.
Stream id "4" started (request).  <-- request arrived, but not dispatched yet
SETTINGS frame received.
Dispatching request on stream id "4".
```

Esse buraco `Waiting for SETTINGS frame` escala com o RTT do peer, não com o trabalho do servidor.

## O que o Preview 3 muda

No Preview 3, o Kestrel despacha streams de requisição assim que chegam e aplica os settings do peer quando o control stream alcança. A especificação permite isso: a seção 6.2.1 da RFC 9114 deixa as implementações começarem a processar frames em streams de requisição em paralelo com o handshake do control stream, desde que apliquem settings retroativamente em qualquer coisa que ainda não se comprometeu a uma decisão no fio.

Nada muda no nível do seu handler, a mesma minimal API continua funcionando:

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

O efeito do Preview 3 está no fio: o frame `HEADERS` no stream 4 acima é agora despachado imediatamente, e o frame `SETTINGS` é aplicado a quaisquer campos codificados em QPACK que ainda não foram decodificados. Para um simples `GET /ping` que não manda referências de tabela dinâmica, a requisição completa sem nunca esperar pelo control stream.

## O que verificar do seu lado

Vale checar dois caveats antes de se apoiar no novo comportamento.

Primeiro, se você manda response headers grandes, o Kestrel ainda respeita o `SETTINGS_MAX_FIELD_SECTION_SIZE` final do peer antes de serializar o frame `HEADERS` de volta. Se o peer ainda não mandou SETTINGS, vale o default na [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114#name-settings) (ilimitado), o que significa que sua resposta ainda pode ser rejeitada depois se o setting real do peer for menor. Mantenha os response headers pequenos na primeira requisição de uma conexão.

Segundo, qualquer coisa medida como time-to-first-byte numa sessão QUIC nova deve cair perceptivelmente. Um benchmark apertado local sobre loopback com latência artificial de peer de 50ms mostrou a primeira requisição caindo de aproximadamente `2 * RTT + server_time` para `1 * RTT + server_time`. Requisições subsequentes na mesma conexão já estavam livres antes do Preview 3 e continuam livres agora.

Se você roda HTTP/3 atrás de YARP ou um API gateway, garanta que está atualizando para um build do .NET 11 Preview 3 ponta a ponta; o ganho está do lado do Kestrel do salto QUIC, então o reverse proxy é onde você o verá. O conjunto completo de notas de HTTP/3 e Kestrel para essa preview vive nas [release notes do ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md).
