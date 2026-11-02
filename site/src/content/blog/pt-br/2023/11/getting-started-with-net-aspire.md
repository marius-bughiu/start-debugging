---
title: "Crie e execute seu primeiro aplicativo com o Aspire"
description: "Crie um aplicativo Aspire em C# com API e frontend Blazor, abra o dashboard e compare o projeto e as capturas da prévia original do .NET 8."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Prepare [a CLI do Aspire e os pré-requisitos para C#](/pt-br/2023/11/how-to-install-net-aspire/). Em uma solução **nova**, o template `aspire-starter` fornece um serviço de API, um frontend Blazor e um AppHost que conecta os dois. Se já existe uma solução, siga o [guia do Aspire 13.4 para adicionar um AppHost aos projetos existentes](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Crie o aplicativo e abra o dashboard

Execute os comandos no diretório onde deseja criar a solução:

```sh
aspire new aspire-starter -n HelloAspire -o HelloAspire
cd HelloAspire
aspire run
```

Responda às perguntas do template, se aparecerem. O primeiro comando cria a solução em `HelloAspire`. O último executa o AppHost. Abra a URL do dashboard exibida no terminal e depois o endpoint do frontend na lista de recursos. Visite a página de previsão do tempo para enviar uma requisição do frontend à API. No dashboard, examine os logs dos serviços e o rastreamento dessa requisição. Para encerrar a aplicação, pressione `Ctrl+C` no terminal.

No template, `ApiService` fornece os dados, `Web` os consome e `ServiceDefaults` contém a configuração comum. O AppHost registra os projetos e conecta o frontend às dependências. O [guia de início rápido em C#](https://aspire.dev/get-started/first-app/?lang=csharp) mostra a estrutura do template e a [introdução ao Aspire](/pt-br/2023/11/what-is-net-aspire/) explica as referências a recursos.

## Arquivo: a prévia do .NET 8 de novembro de 2023

**Correção — 2 de novembro de 2026:** os passos acima usam a CLI do Aspire 13.x. As capturas, a opção de Redis e a API `AddRedisContainer` abaixo pertencem à [prévia de 2023](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). O AppHost tinha como destino `net8.0` e referenciava [Aspire.Hosting 8.0.0-preview.1.23557.2](https://www.nuget.org/packages/Aspire.Hosting/8.0.0-preview.1.23557.2).

No Visual Studio 2022 Preview, o tutorial original selecionava **.NET Aspire Starter Application** e habilitava **Use Redis for caching**. O comando equivalente era:

```sh
dotnet new aspire-starter --use-redis-cache --output Foo
```

[![Diálogo de criar novo projeto do Visual Studio mostrando uma lista filtrada de templates de projeto .NET Aspire.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

[![Diálogo de informações adicionais para o template de projeto .NET Aspire Starter Application com a opção opcional Use Redis for caching (requer Docker).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

O AppHost referenciava `ApiService` e `Web`. Os dois projetos compartilhavam `ServiceDefaults`, como mostra o diagrama original de dependências:

[![Um grafo de dependências de projeto para uma .NET Aspire Starter Application mostrando AppHost no topo, dependente de ApiService e Web, ambos dependentes de ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

O AppHost da prévia registrava Redis como `cache` e a API como `apiservice`. O frontend referenciava ambos. A API da época tinha esta forma:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var cache = builder.AddRedisContainer("cache");
var api = builder.AddProject<Projects.Foo_ApiService>("apiservice");
builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(api);
builder.Build().Run();
```

O dashboard original exibia os projetos e o contêiner juntos. Abrir o rastreamento de uma requisição de previsão do tempo mostrava as chamadas individuais aos serviços:

[![O dashboard do .NET Aspire executando o template de projeto .NET Aspire Starter Application.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

[![Um trace de requisição dentro do dashboard do .NET Aspire mostrando a requisição em estágios conforme passa pelos diferentes componentes da aplicação.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)
