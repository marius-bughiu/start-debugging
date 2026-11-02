---
title: "O que é o .NET Aspire? AppHost, descoberta de serviços e dashboard"
description: "Como o AppHost do Aspire conecta uma API a um frontend, o que o ServiceDefaults configura e o que o dashboard mostra."
pubDate: 2023-11-14
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Uma API e um frontend podem iniciar normalmente e, ainda assim, o frontend chamar a porta errada. Com o Aspire, você descreve os serviços e suas dependências em um **AppHost**. Na execução local, o Aspire inicia os recursos e passa as informações de conexão aos serviços que fazem referência a eles.

## Como o frontend encontra a API

Imagine um AppHost em C# com referências a dois projetos chamados `Api` e `Web`. O exemplo registra ambos como recursos e informa que o serviço web precisa da API:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var api = builder.AddProject<Projects.Api>("api");
builder.AddProject<Projects.Web>("web").WithReference(api);
builder.Build().Run();
```

`WithReference(api)` fornece ao projeto web os dados do endpoint do recurso `api`. Um cliente configurado para descoberta de serviços pode usar esse nome lógico. O frontend ainda envia a requisição HTTP, e a API a processa. Quando o recurso é um banco de dados, o mesmo padrão pode fornecer uma cadeia de conexão.

## O papel das outras peças

O projeto **ServiceDefaults** do template compartilha a configuração de descoberta de serviços, verificações de integridade e telemetria. Cada serviço participante chama essas extensões. O **dashboard** mostra o estado e os endpoints dos recursos e permite acompanhar requisições pelos logs e rastreamentos distribuídos que os serviços emitem. Por exemplo, um rastreamento pode mostrar se uma página lenta gastou tempo no frontend ou esperando a resposta da API.

**Correção — 2 de novembro de 2026:** o [anúncio da prévia original do .NET 8](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/) usava APIs de hospedagem anteriores. O exemplo descreve o modelo de AppHost em C# do Aspire 13.x. Uma referência de projeto sozinha não configura automaticamente todos os clientes.

[Instale a CLI do Aspire](/pt-br/2023/11/how-to-install-net-aspire/) e depois [crie e execute a aplicação de exemplo](/pt-br/2023/11/getting-started-with-net-aspire/) para ver os endpoints no dashboard.
