---
title: "Como adicionar o Aspire a uma solução ASP.NET Core existente sem reestruturá-la"
description: "Adicione o Aspire 13.4 a uma solução ASP.NET Core legada com dois projetos novos e três linhas por serviço: aspire init, ligação do AppHost com AddProject e WithReference, mantendo seu launchSettings.json e suas connection strings, e as armadilhas de resiliência, endpoints de saúde e proxy que aparecem no primeiro dia."
pubDate: 2026-07-26
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "opentelemetry"
  - "devops"
lang: "pt-br"
translationOf: "2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it"
translatedBy: "claude"
translationDate: 2026-07-26
---

Você adiciona o Aspire a uma solução ASP.NET Core existente acrescentando dois projetos novos ao lado dos que já tem, e não movendo nada. Um projeto `AppHost` orquestra seus serviços em tempo de desenvolvimento, uma biblioteca de classes `ServiceDefaults` carrega a configuração compartilhada de telemetria e resiliência, e cada serviço existente ganha exatamente uma referência de projeto mais duas linhas no `Program.cs`. Sua estrutura de pastas, seus namespaces, seu `launchSettings.json`, suas connection strings, seus Dockerfiles e seu pipeline de CI continuam como estão. Este artigo percorre todo o processo no Aspire 13.4.6 (a versão estável atual, publicada em 2026-06-20) contra .NET 10 e .NET 11 Preview 6.

Duas coisas mudaram desde os guias que você provavelmente encontrou primeiro. O Aspire tirou o ".NET" do nome com o Aspire 13 em novembro de 2025, e o passo `dotnet workload install aspire` desapareceu lá no Aspire 9.0. Tudo chega agora via NuGet e um SDK do MSBuild, então se você ainda tem o workload antigo na máquina, `dotnet workload uninstall aspire` é a primeira coisa a executar. Se quiser o passeio conceitual antes da mecânica, a [visão geral sobre o que é o Aspire](/pt-br/2023/11/what-is-net-aspire/) continua válida.

## O que realmente cai no seu repositório

O inventário honesto, para uma solução com uma API e um worker:

```
MyApp.sln
  src/MyApp.Api/            <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.Worker/         <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.AppHost/        <- new
  src/MyApp.ServiceDefaults/<- new
  aspire.config.json        <- new, points the CLI at the AppHost
```

Nenhum projeto se move. Nenhuma mudança de namespace. Nenhuma mudança em como o `dotnet publish` produz suas imagens de contêiner, porque o AppHost é um orquestrador de tempo de desenvolvimento e não faz parte do que você implanta. Esse último ponto é o que as pessoas entendem errado: o AppHost não roda em produção. Ele inicia seus processos localmente, injeta configuração neles e alimenta o dashboard.

## Passos para adicionar o Aspire a uma solução existente

1. Instale a CLI do Aspire como ferramenta global e confirme que ela enxerga seu SDK.
2. Execute `aspire init` na raiz da solução para que ela detecte o `.sln` e gere um AppHost baseado em projeto.
3. Adicione uma referência de projeto do AppHost para cada serviço que você quer que ele inicie e depois declare esses serviços com `AddProject` no `Program.cs` do AppHost.
4. Referencie o `ServiceDefaults` a partir de cada serviço e chame `AddServiceDefaults()` e `MapDefaultEndpoints()`.
5. Modele sua infraestrutura existente: contêineres para o que você não se importa de rodar localmente, `AddConnectionString` para tudo que precisa continuar externo.
6. Execute `aspire run` e verifique se cada serviço ainda sobe com os endpoints que tinha antes.

O resto deste artigo são esses seis passos com o código e, depois, as partes que quebram.

## Instalando a CLI

Desde o Aspire 13.3 a CLI é distribuída como uma ferramenta global do .NET compilada com NativeAOT, o que significa nenhum workload e nenhuma dependência do Visual Studio:

```bash
dotnet tool install -g Aspire.Cli
aspire doctor
```

O `aspire doctor` chegou no 13.4 e vale a pena executar antes de qualquer coisa. Ele imprime a versão da CLI, os SDKs que consegue enxergar e, o mais importante, se a versão da sua CLI e a do seu `Aspire.AppHost.Sdk` se desalinharam. A divergência de versão entre os dois é a origem mais comum de "funcionava na minha máquina" em um repositório com Aspire.

## Gerando o AppHost

A partir do diretório que contém seu `.sln`:

```bash
aspire init
```

Quando o `aspire init` encontra um arquivo de solução, ele cria um AppHost baseado em projeto e o adiciona à solução. Quando não encontra (um repositório poliglota, por exemplo), ele cria um `apphost.cs` de arquivo único usando diretivas `#:sdk` e `#:package`. Para uma solução ASP.NET Core existente você quer a forma baseada em projeto, porque é ela que dá o namespace `Projects` gerado e a depuração integrada à IDE em todos os serviços de uma vez.

Se você preferir não usar a CLI, os templates fazem o mesmo trabalho:

```bash
dotnet new aspire-apphost -o src/MyApp.AppHost
dotnet new aspire-servicedefaults -o src/MyApp.ServiceDefaults
dotnet sln add src/MyApp.AppHost src/MyApp.ServiceDefaults
```

O arquivo de projeto do AppHost é pequeno e é o único lugar onde o SDK do Aspire aparece:

```xml
<!-- src/MyApp.AppHost/MyApp.AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.4.6" />

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <IsAspireHost>true</IsAspireHost>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="13.4.6" />
  </ItemGroup>
</Project>
```

Repare no `TargetFramework`. O AppHost pode mirar um TFM mais novo do que os serviços que ele inicia, porque ele os inicia como processos separados. Uma solução presa ao `net8.0` para seus serviços ainda pode ter um AppHost em `net10.0`.

## Ligando seus projetos existentes

Adicione as referências do AppHost para os serviços e depois declare-os:

```bash
dotnet add src/MyApp.AppHost reference src/MyApp.Api src/MyApp.Worker
```

```csharp
// src/MyApp.AppHost/Program.cs -- Aspire 13.4.6
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.MyApp_Worker>("worker")
    .WithReference(api)
    .WaitFor(api);

builder.Build().Run();
```

O tipo `Projects.MyApp_Api` é gerado pelo SDK do Aspire a partir dos itens `ProjectReference`, com os pontos substituídos por sublinhados. Você não o escreve e ele não existe até a primeira build.

Aqui está a parte que torna isso não invasivo, e é pouco documentada: o Aspire lê o seu `Properties/launchSettings.json` existente. Quando ele inicia um recurso de projeto, escolhe um perfil por precedência: o argumento `launchProfileName` se você o passou, depois um perfil cujo nome coincida com o próprio `DOTNET_LAUNCH_PROFILE` do AppHost, depois o primeiro perfil do arquivo e, por fim, nenhum perfil. Ele analisa o `applicationUrl` do perfil selecionado e o converte em `ASPNETCORE_URLS`, e aplica as `environmentVariables` desse perfil sem modificação. Seus perfis existentes continuam funcionando. Se um serviço tem um perfil "IIS Express" em primeiro lugar no arquivo e você quer o do Kestrel, nomeie-o:

```csharp
builder.AddProject<Projects.MyApp_Api>("api", launchProfileName: "https");
```

Passar `launchProfileName: null` inicia o projeto sem perfil algum, que é a opção mais limpa para um worker que não tem um `launchSettings.json` significativo.

## As duas linhas por serviço

O `ServiceDefaults` é uma biblioteca de classes comum marcada como `IsAspireSharedProject`. Referencie-a a partir de cada serviço e chame seus métodos:

```csharp
// src/MyApp.Api/Program.cs -- ASP.NET Core on .NET 10 / .NET 11 Preview 6
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();   // <- added

builder.Services.AddControllers();
// ... everything you already had, untouched

var app = builder.Build();

app.MapDefaultEndpoints();      // <- added

app.MapControllers();
app.Run();
```

O `AddServiceDefaults()` faz quatro coisas: configura logging, métricas e tracing do OpenTelemetry (com as requisições de health check filtradas para fora dos traces); registra um health check de liveness; registra a descoberta de serviços; e aplica `ConfigureHttpClientDefaults` para que todo `HttpClient` receba o handler de resiliência padrão e a resolução por descoberta de serviços. O `MapDefaultEndpoints()` mapeia `/health` (todos os checks precisam passar) e `/alive` (apenas os checks marcados com `live`), e o template protege ambos atrás de uma verificação de ambiente de desenvolvimento.

Nada disso é específico do Aspire em runtime. Um serviço que chama `AddServiceDefaults()` roda perfeitamente fora do AppHost, sob `dotnet run`, em um contêiner, na sua implantação existente no Kubernetes. Ele apenas exporta telemetria OTLP para onde quer que `OTEL_EXPORTER_OTLP_ENDPOINT` aponte, que é o dashboard quando o AppHost o iniciou e seu coletor real quando não. Se você ainda não tem um coletor, o [passo a passo de um backend gratuito de OpenTelemetry](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) cobre a outra ponta desse cano.

## Modelando a infraestrutura que você já tem

É aqui que um projeto legado mais diverge dos tutoriais do zero, que sempre começam colocando tudo em contêineres. Normalmente você não pode. O SQL Server de desenvolvimento compartilhado é compartilhado por um motivo, e a fila tem dados dentro.

Para dependências que você não se importa de rodar localmente, adicione a integração e deixe o Aspire ser dono do contêiner:

```bash
aspire add redis
```

```csharp
var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(cache)
    .WaitFor(cache);
```

`WithReference(cache)` injeta `ConnectionStrings__cache` no processo da API. Sua chamada existente a `builder.Configuration.GetConnectionString("cache")` lê esse valor sem modificação, porque variáveis de ambiente têm precedência maior que `appsettings.json` na configuração padrão. Esse é todo o truque: o Aspire não pede que seu código mude como lê a configuração, ele apenas fornece os valores em uma precedência mais alta. A mesma história se você estiver ligando o [HybridCache com Redis como L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/): o recurso de cache alimenta a connection string e o resto da sua configuração não muda.

Para dependências que precisam continuar externas, `AddConnectionString` cria um recurso respaldado pela configuração do próprio AppHost em vez de um contêiner:

```csharp
// Reads ConnectionStrings:orders from the AppHost's appsettings.json or user secrets
var orders = builder.AddConnectionString("orders");

builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(orders);
```

Coloque o valor real nos user secrets do AppHost, não no `appsettings.json`:

```bash
dotnet user-secrets --project src/MyApp.AppHost set "ConnectionStrings:orders" "Server=dev-sql;Database=Orders;..."
```

O serviço enxerga `ConnectionStrings__orders` e nada mais muda. Se um serviço procurar um nome que o AppHost nunca declarou, você terá a familiar falha de inicialização coberta em [nenhuma connection string chamada DefaultConnection](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/); o nome do recurso em `AddConnectionString` precisa bater exatamente com a chave que seu código pede.

Chamadas entre serviços recebem o mesmo tratamento. `WithReference(api)` injeta `services__api__https__0` e `services__api__http__0`, e a descoberta de serviços resolve o nome lógico:

```csharp
builder.Services.AddHttpClient<OrdersClient>(
    c => c.BaseAddress = new("https+http://api"));
```

`https+http://` significa preferir HTTPS, com fallback para HTTP. Isso só resolve em um projeto que registrou a descoberta de serviços, o que o `AddServiceDefaults()` faz por você. Use esse esquema em um projeto que pulou o `AddServiceDefaults()` e você recebe uma `UriFormatException` na primeira requisição, não na inicialização.

## Executando

```bash
aspire run
```

A CLI encontra o AppHost através do `aspire.config.json`, inicia todos os recursos e imprime a URL do dashboard. No Visual Studio ou no Rider, defina o AppHost como projeto de inicialização e pressione F5; configurações de inicialização com múltiplos projetos não são mais necessárias.

Uma coisa que surpreende quem vem dos guias da época de 2023: você não precisa do Docker rodando a menos que tenha de fato declarado um recurso de contêiner. Um AppHost que é só chamadas a `AddProject` sobe tranquilamente sem nenhum runtime de contêiner instalado. Isso torna o primeiro commit seguro: você pode entregar o AppHost com zero recursos de contêiner, ganhar o dashboard e o tracing distribuído, e conteinerizar as dependências depois ou nunca.

## O que quebra no primeiro dia

**O handler de resiliência padrão muda o comportamento do seu HTTP.** O `AddServiceDefaults()` o aplica a todo `HttpClient` do processo, o que significa retentativas, um circuit breaker e um tempo limite total de requisição. Se você tem um cliente que legitimamente leva dois minutos, ou já tem pipelines do Polly feitos à mão, agora você tem duas camadas. Remova as suas, ou limite o escopo dos padrões, mas não deixe as duas coisas no lugar.

**Endpoints de saúde duplicados.** Se você já mapeia `/health` por conta própria, o `MapDefaultEndpoints()` dá um segundo registro na mesma rota. Escolha um. O [passo a passo de health check em minimal API](/pt-br/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) cobre o que manter se você quiser uma saída mais rica que a padrão.

**Registro duplo do OpenTelemetry.** O `ConfigureOpenTelemetry` no `ServiceDefaults` é aditivo sobre tudo que você já registrou. Se o seu `Program.cs` tem o próprio `AddOpenTelemetry().WithTracing(...)`, você vai ter instrumentação duplicada e, com o Serilog na jogada, registros de log duplicados. Apague os seus e personalize a versão do `ServiceDefaults`, que é justamente o propósito do projeto compartilhado.

**Os endpoints passam por proxy por padrão.** O Aspire coloca um proxy reverso na frente de cada endpoint, então a porta que seu navegador acessa não é a porta em que o Kestrel fez bind. Isso é invisível até que algo externo fixe uma porta: uma URI de redirecionamento OIDC registrada no seu provedor de identidade, um webhook de um sandbox de pagamentos, uma URL hardcoded em um cliente mobile. Desative por endpoint:

```csharp
builder.AddProject<Projects.MyApp_Api>("api")
    .WithEndpoint("https", e => e.IsProxied = false);
```

**Seu CI agora compila o AppHost.** O `dotnet build MyApp.sln` pega o projeto novo, que precisa restaurar o `Aspire.AppHost.Sdk` do NuGet. Em um feed restrito com uma lista de pacotes permitidos explícita isso falha, e o erro é um erro de resolução de SDK em vez de um erro de pacote faltando, o que o torna mais lento de diagnosticar do que deveria. Ou você libera o SDK e os pacotes de hosting na lista, ou exclui o AppHost da build de CI com um filtro de solução. Nada no seu pipeline de implantação precisa mudar além disso, porque você continua publicando os mesmos projetos de serviço da mesma forma.

**Usuários de Postgres no 13.4:** a imagem padrão passou de 17.6 para 18.3, e não vai anexar a um volume de dados 17.x existente. Fixe a tag com `WithImageTag` se você tem dados locais que importam.

## Relacionados

- [O que é o .NET Aspire?](/pt-br/2023/11/what-is-net-aspire/) para o modelo conceitual por trás do AppHost e das integrações.
- [Como adicionar um endpoint de health check a uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) se o `MapDefaultEndpoints` colidir com o que você já tem.
- [Como usar o OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) para onde os traces vão depois que você deixa o dashboard para trás.
- [Fix: Nenhuma connection string chamada 'DefaultConnection' foi encontrada](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/) para o modo de falha por nome de recurso divergente.
- [Modo isolado do Aspire 13.2 e instâncias paralelas do AppHost](/pt-br/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/) se dois desenvolvedores, ou dois branches, precisam rodar o mesmo AppHost ao mesmo tempo.

## Fontes

- [Add Aspire to an existing app](https://aspire.dev/get-started/add-aspire-existing-app/), documentação do Aspire.
- [C# service defaults](https://aspire.dev/get-started/csharp-service-defaults/), documentação do Aspire.
- [C# launch profiles in the Aspire AppHost](https://aspire.dev/integrations/dotnet/launch-profiles/), documentação do Aspire.
- [External parameters and secrets in the AppHost](https://aspire.dev/fundamentals/external-parameters/), documentação do Aspire.
- [Service discovery](https://aspire.dev/fundamentals/service-discovery/), documentação do Aspire.
- [What's new in Aspire 13.3](https://aspire.dev/whats-new/aspire-13-3/) e [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), documentação do Aspire.
- [Aspire releases](https://github.com/microsoft/aspire/releases) no GitHub, para a versão 13.4.6 e sua data.
