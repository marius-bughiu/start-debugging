---
title: "ASP.NET Core 11 entrega tracing OpenTelemetry nativo: largue o pacote NuGet extra"
description: "ASP.NET Core no .NET 11 Preview 2 adiciona atributos semânticos do OpenTelemetry diretamente à atividade do servidor HTTP, removendo a necessidade do OpenTelemetry.Instrumentation.AspNetCore."
pubDate: 2026-04-12
tags:
  - "aspnet-core"
  - "dotnet-11"
  - "opentelemetry"
  - "observability"
lang: "pt-br"
translationOf: "2026/04/aspnetcore-11-native-opentelemetry-tracing"
translatedBy: "claude"
translationDate: 2026-04-25
---

Todo projeto ASP.NET Core que exporta traces tem a mesma linha no seu `.csproj`: uma referência ao `OpenTelemetry.Instrumentation.AspNetCore`. Esse pacote se inscreve ao `Activity` source do framework e marca cada span com os atributos semânticos que os exportadores esperam: `http.request.method`, `url.path`, `http.response.status_code`, `server.address`, e por aí vai.

A partir do [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/), o framework faz esse trabalho ele mesmo. ASP.NET Core agora popula os atributos padrão das convenções semânticas do OpenTelemetry diretamente na atividade do servidor HTTP, então a biblioteca de instrumentação separada não é mais requerida para coletar dados de tracing baseline.

## O que o framework agora fornece

Quando uma requisição chega ao Kestrel no .NET 11 Preview 2, o middleware embutido escreve os mesmos atributos que o pacote de instrumentação costumava adicionar:

- `http.request.method`
- `url.path` e `url.scheme`
- `http.response.status_code`
- `server.address` e `server.port`
- `network.protocol.version`

Estas são as [convenções semânticas do servidor HTTP](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) das quais todo backend compatível com OTLP depende para dashboards e alertas.

## Antes e depois

Uma configuração típica do .NET 10 para obter traces HTTP parecia assim:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddAspNetCoreInstrumentation()   // requires the NuGet package
            .AddOtlpExporter();
    });
```

No .NET 11, você se inscreve ao activity source embutido em vez disso:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddSource("Microsoft.AspNetCore")  // no extra package needed
            .AddOtlpExporter();
    });
```

O pacote `OpenTelemetry.Instrumentation.AspNetCore` não sumiu; ele ainda existe para equipes que precisam de seus callbacks de enriquecimento ou filtragem avançada. Mas os atributos baseline que 90% dos projetos precisam agora estão embutidos no framework.

## Por que isto importa

Menos pacotes significa um grafo de dependências menor, tempos de restore mais rápidos, e uma coisa a menos para manter sincronizada durante atualizações de versão maior. Também significa que aplicações ASP.NET Core publicadas com NativeAOT ganham traces padrão sem trazer código de instrumentação pesado em reflection.

Se você já está rodando o pacote de instrumentação, nada quebra. Os atributos do framework e os atributos do pacote se fundem limpamente na mesma `Activity`. Você pode remover a referência do pacote quando estiver pronto, testar seus dashboards, e seguir adiante.

As [notas de release completas do ASP.NET Core .NET 11 Preview 2](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/aspnetcore.md) cobrem o restante das mudanças, incluindo o suporte a TempData no Blazor SSR e o novo template de projeto Web Worker.
