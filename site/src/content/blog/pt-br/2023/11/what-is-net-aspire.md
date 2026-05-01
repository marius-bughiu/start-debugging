---
title: "O que é o .NET Aspire?"
description: "Uma visão geral do .NET Aspire, o framework orientado para a nuvem para construir aplicações distribuídas escaláveis, abordando orquestração, componentes e ferramentas."
pubDate: 2023-11-14
updatedDate: 2023-11-16
tags:
  - "aspire"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET Aspire é um framework abrangente, orientado para a nuvem, projetado para criar aplicações distribuídas escaláveis, observáveis e de nível de produção. Foi introduzido em preview como parte do release do .NET 8.

O framework é fornecido por meio de um conjunto de pacotes NuGet, cada um abordando aspectos diferentes do desenvolvimento de aplicações cloud-native, que normalmente são estruturadas como uma rede de microserviços em vez de uma única base de código grande, e dependem fortemente de uma variedade de serviços como bancos de dados, sistemas de mensageria e soluções de cache.

## Orchestration

A orquestração no contexto de aplicações cloud-native envolve a sincronização e administração de vários componentes. O .NET Aspire melhora esse processo simplificando a configuração e integração de diferentes segmentos de uma aplicação cloud-native. Ele oferece abstrações de alto nível para lidar de forma eficaz com aspectos como descoberta de serviços, variáveis de ambiente e configurações para containers, eliminando assim a necessidade de código intrincado de baixo nível. Essas abstrações garantem procedimentos de configuração uniformes em aplicações compostas por múltiplos componentes e serviços.

Com o .NET Aspire, a orquestração aborda áreas-chave como:

-   **Composição da aplicação:** isso envolve definir os projetos .NET, containers, arquivos executáveis e recursos baseados em nuvem que constituem a aplicação.
-   **Descoberta de serviços e gerenciamento de strings de conexão:** o host da aplicação é responsável por incorporar de forma fluida strings de conexão precisas e detalhes de descoberta de serviços, melhorando assim o processo de desenvolvimento.

Por exemplo, o .NET Aspire permite a criação de um recurso local de container Redis e a configuração da string de conexão correspondente em um projeto "frontend" com o mínimo de código, utilizando apenas alguns métodos auxiliares.

```cs
// Create a distributed application builder given the command line arguments.
var builder = DistributedApplication.CreateBuilder(args);

// Add a Redis container to the application.
var cache = builder.AddRedisContainer("cache");

// Add the frontend project to the application and configure it to use the 
// Redis container, defined as a referenced dependency.
builder.AddProject<Projects.MyFrontend>("frontend")
       .WithReference(cache);
```

## Components

Os componentes do .NET Aspire, disponíveis como pacotes NuGet, são desenvolvidos para otimizar a integração com serviços e plataformas amplamente utilizados como Redis e PostgreSQL. Esses componentes abordam vários aspectos do desenvolvimento de aplicações cloud-native oferecendo configurações uniformes, incluindo a implementação de health checks e recursos de telemetria.

Cada um desses componentes foi projetado para se integrar perfeitamente ao framework de orquestração do .NET Aspire. Eles têm a capacidade de propagar automaticamente suas configurações pelas dependências, com base nas relações definidas nas referências de projeto e pacote .NET. Isso significa que se um componente, digamos Example.ServiceFoo, depende de outro, Example.ServiceBar, então Example.ServiceFoo adota automaticamente as configurações necessárias do Example.ServiceBar para facilitar sua intercomunicação.

Para ilustrar, vamos considerar o uso do componente Service Bus do .NET Aspire em um cenário de programação.

```cs
builder.AddAzureServiceBus("servicebus");
```

O método `AddAzureServiceBus` no .NET Aspire aborda várias funções-chave:

1.  Estabelece um `ServiceBusClient` como singleton dentro do container de injeção de dependência (DI), possibilitando a conexão com o Azure Service Bus.
2.  Esse método permite a configuração do `ServiceBusClient`, que pode ser feita diretamente no código ou por meio de configurações externas.
3.  Adicionalmente, ativa health checks, logging e recursos de telemetria relevantes especificamente adaptados para o Azure Service Bus, garantindo monitoramento e manutenção eficientes.

## Tooling

Aplicações desenvolvidas com o .NET Aspire seguem uma estrutura uniforme, estabelecida pelos templates de projeto padrão do .NET Aspire. Tipicamente, uma aplicação .NET Aspire é composta por pelo menos três projetos distintos:

1.  **Foo**: esta é a aplicação inicial, que pode ser um projeto .NET padrão como Blazor UI ou Minimal API. À medida que a aplicação cresce, mais projetos podem ser adicionados, e sua orquestração é gerenciada pelos projetos Foo.AppHost e Foo.ServiceDefaults.
2.  **Foo.AppHost**: o projeto AppHost supervisiona a orquestração de alto nível da aplicação. Isso inclui montar diferentes componentes como APIs, containers de serviços e executáveis, e configurar sua interconectividade e comunicação.
3.  **Foo.ServiceDefaults**: este projeto abriga as configurações padrão para uma aplicação .NET Aspire. Essas configurações, que incluem aspectos como health checks e configurações do OpenTelemetry, podem ser ajustadas e expandidas conforme necessário.

Para ajudar a começar com essa estrutura, são oferecidos dois templates iniciais principais do .NET Aspire:

-   **.NET Aspire Application**: um template inicial fundamental, inclui apenas os projetos Foo.AppHost e Foo.ServiceDefaults, fornecendo a estrutura básica sobre a qual construir.
-   **.NET Aspire Starter Application**: um template mais abrangente, contém não apenas os projetos Foo.AppHost e Foo.ServiceDefaults mas também já vem com projetos UI e API pré-configurados. Esses projetos adicionais vêm pré-configurados com descoberta de serviços e outras funcionalidades padrão do .NET Aspire.

### Read next:

-   [How to install .NET Aspire](/pt-br/2023/11/how-to-install-net-aspire/)
-   [Build your first .NET Aspire application](/pt-br/2023/11/getting-started-with-net-aspire/)
