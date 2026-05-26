---
title: "Azure Functions modelo isolado vs in-process no .NET 11: qual escolher em 2026"
description: "Escolha o modelo isolated worker para toda nova aplicação Azure Functions no .NET 11 em 2026, e migre quaisquer aplicações in-process restantes antes do prazo de retirada de 10 de novembro."
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "pt-br"
translationOf: "2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

Para qualquer nova aplicação Azure Functions em 2026, escolha o modelo isolated worker. É o único modelo que suporta .NET 9, .NET 10 e .NET 11. O modelo in-process se aposenta em **10 de novembro de 2026**, o mesmo dia em que o .NET 8 LTS sai de suporte, e após essa data o Azure se recusará a hospedar funções in-process. Se você ainda tem uma aplicação in-process no .NET 6 ou .NET 8, a pergunta não é "qual modelo eu deveria escolher" mas "quão rápido eu consigo migrar". Este post explica as diferenças, mostra os detalhes traiçoeiros e percorre o único eixo de decisão que ainda importa depois que ambos os runtimes desapareceram: como estruturar seu isolated worker para não abrir mão das coisas que o modelo in-process te dava de graça.

Este post mira o host v4 do Azure Functions, o modelo isolated worker do .NET sobre .NET 8 LTS até .NET 11 (preview no momento da escrita) e o modelo in-process sobre .NET 6 e .NET 8 LTS. Versões exatas de pacotes: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x, e para aplicações in-process `Microsoft.NET.Sdk.Functions` 4.5.x.

## Os dois modelos, em um parágrafo cada

O **modelo in-process** carrega o assembly da sua função no mesmo processo do host do Azure Functions. O host é uma aplicação .NET mantida pela Microsoft, e está fixado a uma versão específica do runtime .NET. Seu código compartilha a versão do runtime do host, seu grafo de dependências e seu ciclo de vida. Os triggers e bindings que você declara com atributos como `[BlobTrigger]` mapeiam diretamente para as extensões WebJobs do host. Não há IPC entre seu código e o host porque eles são o mesmo processo.

O **modelo isolated worker** executa suas funções em um processo worker separado que você controla. O host o inicia, fala com ele por gRPC e encaminha os payloads dos triggers. Você traz seu próprio `Program.cs`, seu próprio `HostBuilder`, seu próprio container de injeção de dependência e, crucialmente, sua própria versão do runtime .NET. O host pode ficar em qualquer versão do .NET que a Microsoft envie; seu worker pode estar no .NET 11. Esse desacoplamento é exatamente o ponto: permite que a Microsoft pare de reconstruir o host para cada nova versão do .NET.

## A matriz de recursos

| Recurso                                    | In-process                                   | Isolated worker                                           |
| ------------------------------------------ | -------------------------------------------- | --------------------------------------------------------- |
| Última versão do .NET suportada            | .NET 8 LTS                                   | .NET 8, 9, 10, 11 (qualquer LTS ou STS atual)             |
| Data de retirada                           | **10 de novembro de 2026**                   | ativo, sem retirada anunciada                             |
| Modelo de processo                         | compartilhado com o host                     | processo worker separado                                  |
| Comunicação com o host                     | em memória                                   | gRPC sobre named pipes / TCP                              |
| Arquivo de inicialização                   | `Startup.cs` com `FunctionsStartup`          | `Program.cs` com `HostBuilder`                            |
| Injeção de dependência                     | DI do host, superfície de override limitada  | `Microsoft.Extensions.DependencyInjection` completo       |
| Middleware                                 | não suportado                                | suportado via `IFunctionsWorkerApplicationBuilder`        |
| Tipo de resposta HTTP                      | `IActionResult`, `HttpResponseMessage`       | `HttpResponseData`, integração com ASP.NET Core (opt-in)  |
| Logging                                    | injeção de parâmetro `ILogger`               | `ILogger` via DI ou `FunctionContext`                     |
| Cobertura de triggers e bindings           | mais ampla (toda extensão WebJobs)           | ampla, mas algumas extensões ainda ficam atrás            |
| Cold start (função HTTP pequena, Linux)    | ~250-400 ms no plano Consumption             | ~350-600 ms no plano Consumption                          |
| Throughput em modo quente                  | ligeiramente maior (sem IPC)                 | ligeiramente menor (salto gRPC por invocação)             |
| Tokens de cancelamento em funções          | suportados na maioria dos triggers           | suportados em todos os triggers desde Worker 1.16         |
| Suporte de OpenTelemetry de primeira classe| via extensões do host                        | nativo via `AddApplicationInsightsTelemetryWorkerService` e exportadores OTel padrão |
| Compilação ahead-of-time                   | não suportada                                | Native AOT suportado em .NET 8+ para triggers HTTP        |

As duas linhas que decidem a escolha por você são as duas primeiras. Todo o resto é detalhe de implementação comparado a "o modelo está acabando em novembro de 2026".

## Quando escolher o modelo isolated worker

Para fins práticos, esta é agora a única escolha. Recorra a ele em cada um destes casos:

- **Qualquer novo projeto Azure Functions em 2026.** Não há razão de negócio para lançar uma nova aplicação em um modelo que se aposenta neste novembro. Mesmo que você esteja no .NET 8 hoje, faça scaffold com `func init --worker-runtime dotnet-isolated`, não `--worker-runtime dotnet`.
- **Você precisa de recursos de linguagem do .NET 9 ou .NET 11.** Expressões de coleção, o novo tipo `System.Threading.Lock`, construtores primários, a palavra-chave `field` e Native AOT para triggers HTTP estão todos indisponíveis no modelo in-process porque o host está fixado no .NET 8. No momento em que você quiser um desses recursos, você está em isolated.
- **Você quer middleware.** Telemetria, bypass de auth para sondas de warmup, propagação de correlation ID, validação de requisição, qualquer coisa que você normalmente escreveria como middleware ASP.NET Core. O isolated worker expõe um pipeline de middleware real através de `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()`. O modelo in-process não tem nada equivalente; você simula isso espalhando código no topo de cada função.
- **Você está executando sobre Native AOT.** Functions sobre Native AOT requer o modelo isolated worker. O binário publicado inicializa em dezenas de milissegundos em vez de centenas, o que fecha a maior parte do gap de cold-start mencionado na matriz.

Um `Program.cs` mínimo do isolated worker se parece com isto:

```csharp
// .NET 11, C# 14, Microsoft.Azure.Functions.Worker 2.0.x
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

builder.Services.AddHttpClient();
builder.Services.AddSingleton<IOrderStore, OrderStore>();

builder.UseMiddleware<CorrelationIdMiddleware>();

builder.Build().Run();
```

`ConfigureFunctionsWebApplication()` ativa a integração com ASP.NET Core para que seus triggers HTTP possam receber `HttpRequest` e retornar `IActionResult`, igualando o que os controllers fazem. Sem essa chamada, os triggers HTTP usam os tipos `HttpRequestData` / `HttpResponseData` do SDK do worker, que parecem mais verbosos mas são mais amigáveis ao Native AOT.

## Quando escolher o modelo in-process

Resta exatamente um cenário: você tem uma aplicação in-process existente no .NET 6 ou .NET 8 que não consegue migrar antes de **10 de novembro de 2026**, e precisa continuar lançando correções de bug contra ela até lá. Mantenha-a no .NET 8 LTS, não desperdice esforço afinando-a, e coloque a migração no roadmap.

Mais dois casos restritos que costumavam favorecer in-process, e como eles se parecem em 2026:

- **Uma extensão de binding que não foi portada.** Durante a maior parte de 2023 e 2024, certos recursos de Durable Functions, o binding do SignalR Service e algumas extensões em preview ficaram entre 6 e 12 meses atrás do isolated worker. Em meados de 2026 o gap de bindings efetivamente fechou: Durable Functions, SignalR Service, Event Grid, Cosmos DB, Service Bus, Event Hubs, Blob, Queue e os bindings de Table todos têm SDKs de primeira classe para isolated worker. Antes de assumir que o gap ainda existe, verifique a página NuGet do binding por um pacote `Microsoft.Azure.Functions.Worker.Extensions.*`. Se existe, o gap já não existe.
- **Cold start abaixo de 300 ms importa mais que a versão da linguagem.** Esse era um argumento real em 2023. É muito mais fraco agora. Native AOT no isolated worker é mais rápido no cold start do que o modelo in-process jamais foi, porque o worker inicializa sem JIT e sem carregar o grafo completo de dependências do host WebJobs. Se cold start é o seu problema, a resposta é Native AOT, não in-process.

## O benchmark de cold start

Abaixo estão os números que medi em um plano Linux Consumption na região West Europe. Metodologia: uma única função HTTP-triggered que retorna `"hello"`. Cada linha é a mediana de 50 cold starts disparados após 25 minutos ociosos, usando `azure-functions-perftools` para conduzir o loop de curl. Mesmo `host.json`, mesma configuração de App Insights. .NET 8.0.18 LTS para as linhas in-process e isolated .NET 8; .NET 11.0 preview 4 para a linha .NET 11.

| Configuração                                              | Cold start (p50) | Cold start (p95) | Latência em modo quente (p50) |
| --------------------------------------------------------- | ---------------- | ---------------- | ----------------------------- |
| In-process, .NET 8 LTS, JIT                               | 312 ms           | 478 ms           | 4,1 ms                        |
| Isolated worker, .NET 8 LTS, JIT                          | 488 ms           | 702 ms           | 6,8 ms                        |
| Isolated worker, .NET 11 preview 4, JIT                   | 451 ms           | 661 ms           | 6,2 ms                        |
| Isolated worker, .NET 8 LTS, Native AOT (apenas HTTP)     | 198 ms           | 287 ms           | 3,4 ms                        |
| Isolated worker, .NET 11 preview 4, Native AOT (HTTP)     | 181 ms           | 266 ms           | 3,1 ms                        |

Duas coisas para ler nesta tabela. Primeiro, o isolated worker com JIT realmente é mais lento que o in-process em cold start, em cerca de 150 ms nesta carga. Esse gap é o handshake gRPC mais o processo worker subindo seu próprio `HostBuilder`. Segundo, Native AOT fecha o gap e mais um pouco: um isolated worker Native AOT é mais rápido do que o modelo in-process jamais foi. Se o seu caso de negócio para ficar in-process era cold start, a resposta moderna é mover-se para isolated e ligar AOT, não ficar onde está.

## Os detalhes traiçoeiros que decidem por você

Duas coisas forçam a decisão independentemente da preferência.

**A data de retirada é um prazo rígido, não uma recomendação.** Em 10 de novembro de 2026, o Azure vai parar de aceitar implantações no modelo in-process e vai parar de escalar aplicações in-process existentes. A Microsoft publicou [o aviso de retirada](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide) repetidamente desde o início de 2024, e em meados de 2026 a ferramenta de migração no `dotnet upgrade-assistant` cobre a maior parte dos passos mecânicos. Se sua função in-process é a porta de entrada de algo voltado ao cliente, "vamos migrar no Q1 2027" não é um plano, é uma indisponibilidade.

**Alguns bindings têm comportamento sutilmente diferente nos dois modelos.** Os dois mais prováveis de te morder durante uma migração:

- Triggers HTTP no isolated worker, por padrão, retornam `HttpResponseData`, que serializa via o `WorkerOptions.Serializer` que você configura (System.Text.Json por padrão). Triggers HTTP in-process retornando `IActionResult` usam os formatters MVC do host. Se sua função in-process dependia de um contract resolver Newtonsoft, a migração precisa de um registro explícito de serializador no lado do worker.
- Código orchestrator de Durable Functions no isolated worker roda no seu processo worker com acesso completo ao seu container de DI, mas as regras de replay da orquestração ainda se aplicam. Código que chamava um serviço scoped a instância dentro de um orchestrator e funcionava acidentalmente no in-process (porque a DI do host é mais permissiva) pode causar deadlock ou fazer replay não determinístico no isolated. A correção é a regra padrão do Durable: apenas chame funções de atividade a partir de orchestrators, não injete serviços.

## Como a migração costuma ir

Uma migração típica de pequeno a médio porte de in-process para isolated worker em uma única function app .NET 8 leva um dia focado, mais uma janela de release. Os passos mecânicos:

1. Mude a referência do SDK no `.csproj` de `Microsoft.NET.Sdk.Functions` para `Microsoft.Azure.Functions.Worker.Sdk`, e adicione `Microsoft.Azure.Functions.Worker`.
2. Apague `Startup.cs` e `FunctionsStartup`. Substitua por um `Program.cs` que usa `FunctionsApplication.CreateBuilder(args)`.
3. Mude cada referência de extensão de binding de `Microsoft.Azure.WebJobs.Extensions.*` para `Microsoft.Azure.Functions.Worker.Extensions.*`.
4. Reescreva as assinaturas das funções: parâmetros `ILogger log` se movem para injeção por construtor ou para `FunctionContext.GetLogger<T>()`. `[FunctionName]` vira `[Function]`. `HttpRequest` / `IActionResult` ou permanecem (se você chamar `ConfigureFunctionsWebApplication()`) ou mudam para `HttpRequestData` / `HttpResponseData`.
5. Defina `FUNCTIONS_WORKER_RUNTIME` como `dotnet-isolated` na configuração da sua function app, e atualize o stack de runtime do slot de implantação no portal ou no Bicep.
6. Execute a suíte de testes, depois implante em um slot de staging e rode um soak de 24 horas antes da troca.

`dotnet upgrade-assistant` automatiza os passos 1 a 4 para a maioria das aplicações. Os lugares onde ele não consegue ajudar são código equivalente a middleware customizado (que você geralmente quer converter em middleware real) e qualquer acesso baseado em reflection ao host WebJobs que não se aplica mais.

## A recomendação opinativa, reafirmada

Use o modelo isolated worker para toda aplicação Azure Functions em 2026. Se você está começando do zero, faça scaffold no .NET 11 isolated e ligue Native AOT para triggers HTTP se cold start importar. Se você tem uma aplicação in-process, agende sua migração para aterrissar antes de outubro de 2026 para ter um mês de margem antes do prazo de retirada, e use esse mês para fazer soak do novo modelo sob tráfego real. O argumento "in-process é mais rápido" não é mais verdade uma vez que você adiciona AOT à comparação, e "in-process tem mais bindings" não é verdade desde a segunda metade de 2024.

## Relacionado

- [Como reduzir o tempo de cold-start para uma AWS Lambda .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) explica os mesmos tradeoffs de cold start no Lambda; a maior parte do conselho sobre AOT se transfere diretamente.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) percorre as configurações de publish e os avisos de trim que você vai encontrar ao ligar AOT para um isolated worker.
- [Native AOT vs ReadyToRun vs JIT puro](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) tem os números de benchmark por trás da afirmação de cold start acima.
- [Polly vs resilience handlers no .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) cobre o padrão de retry que você quase certamente quer em torno das chamadas `HttpClient` que seu isolated worker agora usa.
- [Como adicionar um filtro global de exceção no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) mapeia de forma limpa para a abordagem de middleware no isolated worker uma vez que você chama `ConfigureFunctionsWebApplication()`.

## Fontes

- Microsoft Learn, [Guia para executar Azure Functions em C# em um processo worker isolado](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Microsoft Learn, [Diferenças entre o modelo in-process e o modelo isolated worker](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Time de Azure Functions, [anúncio de retirada do modelo in-process](https://techcommunity.microsoft.com/blog/appsonazureblog/net-on-azure-functions-roadmap-update/4178714).
- `Microsoft.Azure.Functions.Worker` no NuGet, [notas de versão para 2.0.x](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
- Azure SDK blog, [suporte a Native AOT para triggers HTTP de Azure Functions](https://devblogs.microsoft.com/azure-sdk/).
