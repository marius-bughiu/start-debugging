---
title: "Começando com o .NET Aspire"
description: "Um guia passo a passo para construir sua primeira aplicação .NET Aspire, cobrindo a estrutura do projeto, descoberta de serviços e o dashboard do Aspire."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este artigo vai guiar você na construção da sua primeira aplicação .NET Aspire. Se você quer uma visão geral do .NET Aspire e do que ele oferece, confira nosso artigo [What is .NET Aspire](/pt-br/2023/11/what-is-net-aspire/).

## Prerequisites

Existem algumas coisas que você precisa ter prontas antes de começar com o .NET Aspire:

-   Visual Studio 2022 Preview (versão 17.9 ou superior)
    -   com o workload do .NET Aspire instalado
    -   e .NET 8.0
-   Docker Desktop

Se preferir não usar o Visual Studio, você também pode instalar o .NET Aspire usando a CLI do dotnet com o comando `dotnet workload install aspire`. E então fica livre para usar o IDE que preferir.

Para um guia completo sobre como instalar todos os pré-requisitos do .NET Aspire, confira [How to install .NET Aspire](/pt-br/2023/11/how-to-install-net-aspire/).

## Create new project

No Visual Studio, vá em **File** > **New** > **Project**, selecione **.NET Aspire** no dropdown de tipo de projeto, ou pesquise pela palavra "Aspire". Isso deve mostrar dois templates:

-   **.NET Aspire Application** -- um template de projeto .NET Aspire vazio.
-   **.NET Aspire Starter Application** -- um template de projeto mais completo contendo um frontend Blazor, um serviço backend de API e, opcionalmente, cache usando Redis.

Vamos escolher o template **.NET Aspire Starter Application** para nossa primeira app .NET Aspire.

[![Diálogo de criar novo projeto do Visual Studio mostrando uma lista filtrada de templates de projeto .NET Aspire.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

Dê um nome ao seu projeto e, no diálogo **Additional information**, certifique-se de habilitar a opção **Use Redis for caching**. Isso é totalmente opcional, mas serve como um bom exemplo do que o .NET Aspire pode fazer por você.

[![Diálogo de informações adicionais para o template de projeto .NET Aspire Starter Application com a opção opcional Use Redis for caching (requer Docker).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

### Using dotnet CLI

Você também pode criar apps .NET Aspire usando a CLI do dotnet. Para criar uma app usando o template .NET Aspire Starter Application, use o comando a seguir, substituindo `Foo` pelo nome de solução desejado.

```bash
dotnet new aspire-starter --use-redis-cache --output Foo
```

## Project structure

Com a solução .NET Aspire criada, vamos dar uma olhada em sua estrutura. Você deve ter 4 projetos sob sua solução:

-   **ApiService**: um projeto de API ASP.NET Core usado pelo frontend para recuperar dados.
-   **AppHost**: atua como orquestrador conectando e configurando os diferentes projetos e serviços da sua aplicação .NET Aspire.
-   **ServiceDefaults**: um projeto compartilhado usado para gerenciar configurações relacionadas a resiliência, descoberta de serviços e telemetria.
-   **Web**: uma aplicação Blazor atuando como nosso frontend.

As dependências entre os projetos ficam assim:

[![Um grafo de dependências de projeto para uma .NET Aspire Starter Application mostrando AppHost no topo, dependente de ApiService e Web, ambos dependentes de ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

Vamos começar pelo topo.

## AppHost project

Este é nosso projeto orquestrador da solução .NET Aspire. Sua função é conectar e configurar os diferentes projetos e serviços da nossa aplicação .NET Aspire.

Vamos olhar seu arquivo `.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsAspireHost>true</IsAspireHost>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\Foo.ApiService\Foo.ApiService.csproj" />
    <ProjectReference Include="..\Foo.Web\Foo.Web.csproj" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting" Version="8.0.0-preview.1.23557.2" />
  </ItemGroup>

</Project>
```

Duas coisas se destacam:

-   o elemento `IsAspireHost` que marca explicitamente este projeto como o orquestrador da nossa solução
-   a referência ao pacote `Aspire.Hosting`. Esse pacote contém a API e abstrações principais para o modelo de aplicação .NET Aspire. Como o framework ainda está em preview, os pacotes NuGet do .NET Aspire também são marcados como versões prévias.

Vamos olhar agora para `Program.cs`. Você vai notar um padrão builder bem familiar usado para conectar os diferentes projetos e habilitar o cache.

```cs
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedisContainer("cache");

var apiservice = builder.AddProject<Projects.Foo_ApiService>("apiservice");

builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(apiservice);

builder.Build().Run();
```

O que o código acima essencialmente faz é o seguinte:

-   cria uma instância de `IDistributedApplicationBuilder` usada para construir nossa `DistributedApplication`
-   cria um `RedisContainerResource` que podemos referenciar mais tarde em nossos projetos e serviços
-   adiciona nosso projeto `ApiService` à aplicação e mantém uma instância do `ProjectResource`
-   adiciona nosso projeto `Web` à aplicação, referenciando o cache Redis e o `ApiService`
-   antes de finalmente chamar `Build()` para construir nossa instância de `DistributedApplication`, e `Run()` para executá-la.

## ApiService project

O projeto `ApiService` expõe um endpoint `/weatherforecast` que podemos consumir do nosso projeto `Web`. Para tornar a API disponível para consumo, nós a registramos no nosso projeto `AppHost` e demos a ela o nome `apiservice`.

```cs
builder.AddProject<Projects.Foo_ApiService>("apiservice")
```

## Web project

O projeto `Web` representa nosso frontend Blazor e consome o endpoint `/weatherforecast` exposto pelo nosso `ApiService`. A forma como faz isso é onde a mágica do .NET Aspire realmente começa.

Você vai notar que ele usa um `HttpClient` tipado:

```cs
public class WeatherApiClient(HttpClient httpClient)
{
    public async Task<WeatherForecast[]> GetWeatherAsync()
    {
        return await httpClient.GetFromJsonAsync<WeatherForecast[]>("/weatherforecast") ?? [];
    }
}
```

Agora, se você olhar dentro de `Program.cs` vai notar algo interessante na linha 14:

```cs
builder.Services.AddHttpClient<WeatherApiClient>(client =>
    client.BaseAddress = new("http://apiservice"));
```

Lembra como demos ao nosso projeto `ApiService` o nome `apiservice` ao adicioná-lo como `ProjectResource` na nossa `DistributedApplication`? Agora esta linha configura o `WeatherApiClient` tipado para usar descoberta de serviços e se conectar a um serviço chamado `apiservice`. `http://apiservice` será resolvido automaticamente para o endereço correto do nosso recurso `ApiService` sem qualquer configuração adicional necessária de sua parte.

## ServiceDefaults project

Similar ao projeto `AppHost`, o projeto compartilhado também é diferenciado por uma propriedade de projeto especial:

```xml
<IsAspireSharedProject>true</IsAspireSharedProject>
```

O projeto garante que todos os diferentes projetos e serviços sejam configurados da mesma forma quando se trata de resiliência, descoberta de serviços e telemetria. Ele faz isso expondo um conjunto de métodos de extensão que podem ser chamados pelos projetos e serviços da solução em suas próprias instâncias de `IHostApplicationBuilder`.

## Run the project

Para executar o projeto, certifique-se de ter o `AppHost` configurado como seu projeto de inicialização e pressione run (F5) no Visual Studio. Alternativamente, você pode executar o projeto pela linha de comando, usando `dotnet run --project Foo/Foo.AppHost`, substituindo `Foo` pelo nome do seu projeto.

Após a aplicação iniciar, será apresentado a você o dashboard do .NET Aspire.

[![O dashboard do .NET Aspire executando o template de projeto .NET Aspire Starter Application.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

O dashboard permite que você monitore as várias partes da sua aplicação .NET Aspire: seus projetos, containers e executáveis. Também fornece logs agregados e estruturados para seus serviços, traces de requisição e várias outras métricas úteis.

[![Um trace de requisição dentro do dashboard do .NET Aspire mostrando a requisição em estágios conforme passa pelos diferentes componentes da aplicação.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)

E é isso! Parabéns por construir e executar sua primeiríssima aplicação .NET Aspire!
