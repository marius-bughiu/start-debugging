---
title: "gRPC em contêineres parece difícil no .NET 9 e .NET 10: 4 armadilhas que você pode corrigir"
description: "Quatro armadilhas comuns ao hospedar gRPC em contêineres com .NET 9 e .NET 10: incompatibilidade de protocolo HTTP/2, confusão sobre terminação de TLS, health checks quebrados e proxy mal configurado -- com a correção para cada uma."
pubDate: 2026-01-10
tags:
  - "grpc"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix"
translatedBy: "claude"
translationDate: 2026-04-30
---
Apareceu de novo hoje no r/dotnet: "Por que hospedar serviços gRPC em contêineres é tão difícil?". A resposta curta é que o gRPC é opinativo sobre HTTP/2, e os contêineres deixam a borda da rede mais explícita. Você é forçado a decidir onde o TLS termina, quais portas falam HTTP/2 e qual proxy fica na frente.

Discussão original: [https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/](https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/)

## Armadilha 1: a porta do contêiner está acessível, mas não fala HTTP/2

O gRPC exige HTTP/2 de ponta a ponta. Se um proxy fizer downgrade para HTTP/1.1, você obtém falhas misteriosas do tipo "unavailable" que parecem bugs da aplicação.

No .NET 9 / .NET 10, declare a intenção do servidor de forma explícita:

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

## Armadilha 2: a terminação de TLS é confusa (e os clientes gRPC se importam)

Muitos times assumem que "contêiner = TLS". Na prática, terminar o TLS na borda é mais simples:

-   **Kestrel**: rode HTTP/2 sem TLS na `8080` dentro do cluster.
-   **Ingress / proxy reverso**: termine o TLS e encaminhe para o serviço por HTTP/2.

Se você terminar o TLS no Kestrel, também precisa de certificados dentro do contêiner e expor a porta correta. Funciona, só são mais peças em movimento.

## Armadilha 3: os health checks verificam a coisa errada

Os probes HTTP do Kubernetes e os probes básicos de load balancer costumam ser HTTP/1.1. Se você sondar seu endpoint gRPC diretamente, ele pode falhar mesmo quando o serviço está saudável.

Duas correções práticas:

-   **Exponha um endpoint HTTP simples** para os probes (como o `MapGet("/")` acima) em uma porta separada, ou na mesma porta se o seu proxy suportar.
-   **Use o health checking do gRPC** (`grpc.health.v1.Health`) se o seu ambiente suportar probes que entendem gRPC.

## Armadilha 4: os proxies e os defaults de HTTP/2 te mordem

A forma mais fácil de fazer o gRPC "parecer difícil" é colocar na frente um proxy que não está configurado para HTTP/2 no upstream. Garanta que o seu proxy esteja explicitamente configurado para:

-   aceitar HTTP/2 dos clientes
-   encaminhar HTTP/2 ao serviço upstream (não apenas HTTP/1.1)

Esse último ponto é onde muitas configurações padrão do Nginx falham com gRPC.

## Uma configuração de contêiner que continua sem graça

-   **Contêiner**: escute na `8080` com `HttpProtocols.Http2`.
-   **Proxy/ingress**: termine o TLS na `443`, fale HTTP/2 com o cliente e com o upstream.
-   **Observabilidade**: ative logs estruturados para falhas de requisição e inclua os códigos de status gRPC.

Se você quer um único ponto de referência antes de mexer no Kubernetes, comece validando localmente: rode o contêiner, bata nele com `grpcurl`, depois coloque um proxy na frente e verifique se ele continua negociando HTTP/2 de ponta a ponta.

Leitura adicional: [https://learn.microsoft.com/aspnet/core/grpc/](https://learn.microsoft.com/aspnet/core/grpc/)
