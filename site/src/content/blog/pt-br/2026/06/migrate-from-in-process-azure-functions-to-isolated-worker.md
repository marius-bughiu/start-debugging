---
title: "Migrar do Azure Functions in-process para o modelo de worker isolado (.NET 8 / .NET 11)"
description: "Um checklist passo a passo para mover um app Azure Functions in-process em .NET para o modelo de worker isolado antes da aposentadoria de 10 de novembro de 2026, com diffs de csproj, reescritas de assinaturas e um rollout com troca de slots."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "pt-br"
translationOf: "2026/06/migrate-from-in-process-azure-functions-to-isolated-worker"
translatedBy: "claude"
translationDate: 2026-06-05
---

Um app Azure Functions in-process típico em .NET 8 migra para o modelo de worker isolado em cerca de um dia de mudanças de código focadas, mais uma janela de release escalonado. O que quebra é mecânico e previsível: a referência de SDK no seu `.csproj`, seu `Startup.cs`, cada atributo `[FunctionName]`, cada pacote `Microsoft.Azure.WebJobs.Extensions.*` e qualquer função que recebia um parâmetro `ILogger`. Nada disso é difícil, mas tudo é obrigatório, porque o modelo in-process é aposentado em **10 de novembro de 2026**, e a partir dessa data o Azure deixa de fornecer aos apps in-process atualizações de segurança e de recursos. Este guia é o checklist completo: o que mudar, o diff exato de cada mudança, como verificar cada passo e como fazer o rollout da troca de runtime através de um slot de staging para que a produção nunca veja o estado intermediário quebrado.

Isto tem como alvo o host v4 do Azure Functions, migrando um app `dotnet` (in-process) em .NET 6 ou .NET 8 LTS para o modelo de worker isolado `dotnet-isolated` em .NET 8 LTS (o caminho rápido recomendado) ou .NET 11. As versões de pacote referenciadas são as últimas estáveis em junho de 2026: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x e a família `Microsoft.Azure.Functions.Worker.Extensions.*`. Se seu app ainda está no host v1, v2 ou v3, faça primeiro a [atualização de host da versão 3.x para a 4.x](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-version-3-version-4); esse guia integra a mudança para o worker isolado no mesmo passo.

Se você ainda está decidindo se migra ou não, leia primeiro [worker isolado vs in-process no .NET 11](/pt-br/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/). Este post assume que você já decidiu e quer a receita mecânica.

## Por que esta migração não é opcional

- **O modelo in-process é aposentado em 10 de novembro de 2026.** É o mesmo dia em que o .NET 8 LTS sai de suporte. A partir dessa data, os apps in-process continuam rodando mas não recebem patches de segurança nem atualizações de recursos da Microsoft, e você não pode implantar um novo app in-process. A Microsoft publicou [o aviso de aposentadoria](https://aka.ms/azure-functions-retirements/in-process-model) desde o início de 2024.
- **O worker isolado desbloqueia .NET 9, 10 e 11.** O host in-process está fixado no .NET 8 e nunca avança além disso. No momento em que você quer construtores primários, a palavra-chave `field`, o tipo `System.Threading.Lock`, expressões de coleção ou Native AOT, você precisa do worker isolado, onde você traz seu próprio runtime.
- **Você ganha um pipeline de middleware real e DI completa.** O worker isolado expõe `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` e o contêiner padrão `Microsoft.Extensions.DependencyInjection` sem limites na superfície de override. IDs de correlação, atalhos de autenticação para sondas de warmup e validação de requisições viram middleware em vez de código copiado e colado no início de cada função.
- **O cold start pode acabar menor, não maior.** O worker isolado com JIT puro é cerca de 150 ms mais lento no cold start que in-process, mas Native AOT no worker isolado inicia mais rápido do que in-process jamais iniciou. Se o cold start é o motivo de você ter ficado em in-process, a resposta moderna é isolado mais AOT.

## O que quebra

| Área                       | Mudança                                                                                                  | Severidade |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Referência de SDK          | `Microsoft.NET.Sdk.Functions` removido; substituir por `Microsoft.Azure.Functions.Worker` + `.Worker.Sdk` | alta     |
| Tipo de saída              | o `.csproj` precisa de `<OutputType>Exe</OutputType>`; o worker agora é um processo de console real      | alta     |
| Startup                    | `FunctionsStartup` / `Startup.cs` substituído por `Program.cs` com um `HostBuilder`                      | alta     |
| Atributo de função         | `[FunctionName("X")]` vira `[Function("X")]`                                                             | alta     |
| Pacotes de binding         | cada `Microsoft.Azure.WebJobs.Extensions.*` muda para `Microsoft.Azure.Functions.Worker.Extensions.*`   | alta     |
| Parâmetro `ILogger`        | o `ILogger log` injetado por método vira `ILogger<T>` injetado por construtor                            | média    |
| Tipo de retorno HTTP       | `IActionResult` só continua funcionando se você ativar a integração com ASP.NET Core; senão, `HttpResponseData` | média    |
| Bindings de entrada / saída | bindings de entrada ganham o sufixo `Input`, os de saída ganham o sufixo `Output`, as saídas deixam a lista de parâmetros | média    |
| `IBinder` / `IAsyncCollector<T>` | `IBinder` removido; `IAsyncCollector<T>` vira um retorno `T[]` ou um cliente injetado                | média    |
| `FUNCTIONS_WORKER_RUNTIME` | o valor muda de `dotnet` para `dotnet-isolated` localmente e na configuração do app no Azure              | alta     |
| Filtragem de logs          | host.json não filtra mais os logs do seu código; a filtragem move para `Program.cs`                      | baixa    |

## Checklist de preparação

Antes de tocar em uma linha de código:

- Confirme que o app está no **host v4**. Rode `func --version` (Core Tools 4.x) e verifique o ajuste de versão do runtime de Functions no portal. Se você está no v3 ou anterior, atualize o host primeiro.
- Instale o **SDK do .NET 8** (ou o SDK do .NET 11 se você visa isso) e as **Azure Functions Core Tools v4** localmente para poder rodar `func start` contra o projeto migrado.
- Inventarie seus **pacotes de trigger e binding**. Faça grep no `.csproj` por `Microsoft.Azure.WebJobs.Extensions` e anote cada um; você vai precisar da substituição `Microsoft.Azure.Functions.Worker.Extensions.*` correspondente.
- Inventarie as funções que recebem um **parâmetro de método `ILogger`** e as que usam **`IBinder` ou `IAsyncCollector<T>`**. Essas precisam de edições manuais que as ferramentas de atualização não conseguem automatizar por completo.
- Garanta que você tem um **slot de implantação de staging** disponível, ou que pode criar um. A troca de runtime não deve acontecer no lugar sobre a produção.
- Pegue a rede de segurança de sempre: um branch limpo, uma build verde e uma suíte de testes passando na versão in-process para ter uma linha de base conhecida-boa contra a qual fazer diff.
- Opcional mas recomendado: instale o **.NET Upgrade Assistant** (`dotnet tool install -g upgrade-assistant`). Ele automatiza as mudanças de `.csproj`, `Program.cs`, atributos e muitas assinaturas; depois você corrige à mão os bindings que ele não conseguiu inferir.

## Passos de migração

Cada passo abaixo é uma mudança discreta com uma linha de verificação. Faça-os em ordem; o projeto não vai compilar de forma limpa até o último estar feito, o que é esperado.

1. **Converta o SDK e os pacotes do `.csproj`.** Remova a referência a `Microsoft.NET.Sdk.Functions`, adicione os pacotes do worker e adicione `<OutputType>Exe</OutputType>`. O antes e o depois:

   ```xml
   <!-- BEFORE: in-process, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.NET.Sdk.Functions" Version="4.5.0" />
     </ItemGroup>
   </Project>
   ```

   ```xml
   <!-- AFTER: isolated worker, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
       <OutputType>Exe</OutputType>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
     </PropertyGroup>
     <ItemGroup>
       <FrameworkReference Include="Microsoft.AspNetCore.App" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.0.0" />
       <PackageReference Include="Microsoft.ApplicationInsights.WorkerService" Version="2.23.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.ApplicationInsights" Version="2.0.0" />
     </ItemGroup>
   </Project>
   ```

   Para visar o .NET 11 em vez disso, defina `<TargetFramework>net11.0</TargetFramework>`. O `FrameworkReference` para `Microsoft.AspNetCore.App` é o que permite que os triggers HTTP continuem retornando `IActionResult`; mantenha-o mesmo se você não tiver triggers HTTP, porque ele melhora o início do worker. **Verifique:** `dotnet restore` tem sucesso e baixa os pacotes do worker. A build ainda vai falhar no código, o que está ok.

2. **Substitua cada pacote de extensão de binding.** Para cada `Microsoft.Azure.WebJobs.Extensions.*` que você inventariou, troque pelo equivalente do worker. Os comuns:

   ```text
   Microsoft.Azure.WebJobs.Extensions.Storage.Blobs
     -> Microsoft.Azure.Functions.Worker.Extensions.Storage.Blobs
   Microsoft.Azure.WebJobs.Extensions.ServiceBus
     -> Microsoft.Azure.Functions.Worker.Extensions.ServiceBus
   Microsoft.Azure.WebJobs.Extensions.CosmosDB
     -> Microsoft.Azure.Functions.Worker.Extensions.CosmosDB
   Microsoft.Azure.WebJobs.Extensions.EventHubs
     -> Microsoft.Azure.Functions.Worker.Extensions.EventHubs
   Microsoft.Azure.WebJobs.Extensions.DurableTask
     -> Microsoft.Azure.Functions.Worker.Extensions.DurableTask
   ```

   Um trigger de timer precisa que `Microsoft.Azure.Functions.Worker.Extensions.Timer` seja adicionado explicitamente. Remova `Microsoft.Azure.Functions.Extensions` por completo; o worker isolado fornece o startup de DI nativamente. **Verifique:** não resta nenhuma referência a nenhum pacote `Microsoft.Azure.WebJobs.*`. `dotnet list package | Select-String WebJobs` (PowerShell) não deveria imprimir nada.

3. **Adicione `Program.cs` e exclua `Startup.cs`.** O worker isolado é um app de console e precisa de um ponto de entrada. Mova tudo do seu `FunctionsStartup.Configure` para `ConfigureServices`:

   ```csharp
   // Program.cs -- .NET 8 / .NET 11, Microsoft.Azure.Functions.Worker 2.0.x
   using Microsoft.Azure.Functions.Worker;
   using Microsoft.Extensions.DependencyInjection;
   using Microsoft.Extensions.Hosting;

   var builder = FunctionsApplication.CreateBuilder(args);

   // ConfigureFunctionsWebApplication() opts into ASP.NET Core integration so HTTP
   // triggers can keep using HttpRequest / IActionResult. Use
   // ConfigureFunctionsWorkerDefaults() instead if you have no HTTP triggers.
   builder.ConfigureFunctionsWebApplication();

   builder.Services
       .AddApplicationInsightsTelemetryWorkerService()
       .ConfigureFunctionsApplicationInsights();

   // Everything that used to be in Startup.Configure goes here:
   builder.Services.AddHttpClient();
   builder.Services.AddSingleton<IOrderStore, OrderStore>();

   builder.Build().Run();
   ```

   Depois exclua a classe que carregava o atributo `[assembly: FunctionsStartup(typeof(Startup))]`. **Verifique:** o arquivo compila isoladamente e não resta nenhum atributo `FunctionsStartup` em lugar nenhum (`Select-String FunctionsStartup -Path **/*.cs`).

4. **Renomeie os atributos de função.** `[FunctionName("X")]` vira `[Function("X")]`. A assinatura é idêntica, então é uma substituição de strings segura em todo o projeto. **Verifique:** `Select-String "FunctionName" -Path **/*.cs` não retorna nada.

5. **Mova o `ILogger` do parâmetro para o construtor.** In-process deixava você receber um parâmetro `ILogger log` no método da função. O worker isolado usa injeção por construtor. Converta cada classe de função afetada para um construtor primário:

   ```csharp
   // BEFORE (in-process)
   public static class HttpTriggerCSharp
   {
       [FunctionName("HttpTriggerCSharp")]
       public static IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req,
           ILogger log)
       {
           log.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   ```csharp
   // AFTER (isolated worker, .NET 8 / .NET 11, C# 12+ primary constructor)
   public class HttpTriggerCSharp(ILogger<HttpTriggerCSharp> logger)
   {
       [Function("HttpTriggerCSharp")]
       public IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
       {
           logger.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   Note que a função não é mais `static`, a classe não é mais `static`, e o `ILogger` saiu da assinatura do método. **Verifique:** a classe de função compila e nenhum método de função ainda tem um parâmetro `ILogger`.

6. **Corrija os usings e os nomes de atributos de triggers e bindings.** Remova `using Microsoft.Azure.WebJobs;`, adicione `using Microsoft.Azure.Functions.Worker;`. Os triggers normalmente mantêm seu nome (`QueueTrigger` continua `QueueTrigger`), os bindings de entrada ganham um sufixo `Input` (`CosmosDB` vira `CosmosDBInput`), e os bindings de saída ganham um sufixo `Output` (`Queue` vira `QueueOutput`, `Blob` vira `BlobOutput`). Os bindings de saída também deixam a lista de parâmetros: uma única saída vai no tipo de retorno, e múltiplas saídas vão em propriedades de uma pequena classe de resultado. Substitua `IAsyncCollector<T>` por um retorno `T[]`, e remova qualquer parâmetro `IBinder` em favor de um cliente injetado. **Verifique:** `dotnet build` agora tem sucesso com zero erros.

7. **Atualize o `local.settings.json`.** Mude o valor do runtime do worker:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated"
     }
   }
   ```

   Nenhuma mudança no `host.json` é necessária. **Verifique:** `func start` inicia o app localmente e suas funções aparecem no banner de inicialização com suas rotas.

## Verificação

Depois que a build estiver verde, rode este smoke test antes de chegar perto do Azure:

- `dotnet build` retorna zero erros e zero referências a `Microsoft.Azure.WebJobs.*`.
- `func start` inicia e lista cada função com o trigger e a rota corretos.
- Acione cada trigger HTTP localmente (`curl` ou seu cliente de testes) e confirme o mesmo código de status e corpo que a versão in-process retornava.
- Dispare cada trigger não-HTTP: solte um blob, enfileire uma mensagem, deixe o timer disparar. Confirme que a função roda e escreve suas saídas.
- `dotnet test` passa. Fique atento especificamente aos testes que afirmavam sobre a saída de logs ou sobre o comportamento do serializador, já que ambos podem mudar (ver gotchas).
- Compare um trace capturado do Application Insights de antes e depois. Confirme que suas categorias de log ainda aparecem nos níveis que você espera; se sumiram, está faltando a filtragem de logs no seu `Program.cs`.

## Rollout no Azure, e rollback

O lado do Azure são duas mudanças que precisam acontecer juntas: definir `FUNCTIONS_WORKER_RUNTIME` como `dotnet-isolated` e implantar o payload isolado. Se só uma chega, o app fica em um estado de erro porque o código implantado não corresponde ao runtime configurado. Nunca faça isso no lugar sobre a produção. Em vez disso:

1. Crie ou reutilize um **slot de implantação de staging**.
2. No slot de staging, defina o ajuste de app `FUNCTIONS_WORKER_RUNTIME` como `dotnet-isolated`. **Não** o marque como ajuste de slot. Se você também mudou a versão do .NET, atualize a configuração de stack no slot também.
3. Publique o projeto migrado no slot de staging. Você verá erros transitórios nos logs do slot durante o intervalo; espere eles pararem.
4. Faça smoke test do slot de staging contra dependências reais do Azure. Confirme que os erros se limparam e que o comportamento corresponde à produção.
5. **Troque** (swap) o slot de staging para a produção. O swap é uma atualização atômica única, então a produção nunca vê o estado intermediário quebrado.
6. Confirme que a produção está saudável.

**Rollback:** isto é totalmente reversível enquanto você mantiver a build in-process. Para reverter, troque os slots de volta: o payload de produção anterior (ainda in-process) retorna ao slot de produção em uma única operação. Como o swap é atômico, o rollback é o mesmo movimento de um clique que o rollout. Mantenha o branch in-process e seu último artefato bom até o novo modelo ter rodado sob tráfego real por pelo menos alguns dias. A migração só vira de mão única no momento em que você exclui aquele artefato in-process, então não o exclua no primeiro dia.

## Gotchas que encontramos

**Os logs somem silenciosamente do Application Insights.** No modelo in-process, o `host.json` controlava a filtragem de logs para tudo, incluindo seu código. No worker isolado, o `host.json` só filtra o runtime do host de Functions; os logs da sua aplicação são filtrados pela configuração de logging no `Program.cs`. Se você migra e seus logs `Information` somem, adicione filtragem explícita no `Program.cs` em vez de esperar que o `host.json` os cubra.

**As respostas HTTP mudam de forma se você dependia de Newtonsoft.** Os triggers HTTP in-process que retornavam `IActionResult` serializavam através dos formatadores MVC do host, que muitos apps tinham configurado com um contract resolver do Newtonsoft. O worker isolado usa `System.Text.Json` por padrão. Se seu JSON de repente usa outro casing ou perde um conversor personalizado, registre seu serializador no worker. Se você está pesando se mantém o Newtonsoft afinal, leia [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

**Orquestradores de Durable Functions que injetavam serviços começam a fazer replay de forma não determinística.** A DI do host in-process era indulgente o suficiente para que chamar um serviço com escopo de instância dentro de um orquestrador às vezes funcionasse por acidente. No worker isolado esse mesmo código pode causar deadlock ou fazer replay de forma não determinística. A correção é a regra padrão do Durable que o modelo in-process deixava você dobrar: orquestradores chamam apenas funções de atividade, e efeitos colaterais vivem em atividades, não em serviços injetados.

**O app fica vermelho no Azure durante o deploy, e isso é normal.** A primeira vez que você empurra o payload isolado para um slot cujo `FUNCTIONS_WORKER_RUNTIME` ainda é `dotnet` (ou vice-versa), o slot reporta um estado de erro. Essa é a incompatibilidade intermediária que a documentação alerta. É exatamente por isso que o rollout passa por um slot de staging, e ela se limpa assim que tanto o ajuste quanto o payload concordam.

**Bindings de saída na lista de parâmetros não vão compilar.** O erro de build mais comum após a troca de pacotes é um binding de saída ainda como um parâmetro `out` ou `IAsyncCollector<T>`. Mova-o para o tipo de retorno (saída única) ou uma classe de resultado (múltiplas saídas). O erro do compilador aponta para o parâmetro, mas a correção é estrutural, não um cast de tipo.

## Relacionados

- [Azure Functions worker isolado vs in-process no .NET 11](/pt-br/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) é o companheiro focado-em-decisão deste checklist, com a matriz completa de recursos e o benchmark de cold start.
- [Migrar do .NET 8 para o .NET 11: o checklist completo](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) é o passo natural seguinte uma vez que você está no worker isolado e quer mover o runtime para frente.
- [Como usar Native AOT com APIs mínimas do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) cobre os ajustes de publish e os avisos de trim que você vai encontrar quando ativar AOT para o worker migrado.
- [Native AOT vs ReadyToRun vs JIT puro](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) tem os números por trás da afirmação "isolado mais AOT ganha de in-process no cold start".
- [Como reduzir o tempo de cold-start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) compartilha a maior parte do conselho de cold-start com AOT se você também roda funções fora do Azure.

## Fontes

- Microsoft Learn, [Migrar apps C# do modelo in-process para o modelo de worker isolado](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-dotnet-to-isolated-model).
- Microsoft Learn, [Diferenças entre o modelo in-process e o modelo de worker isolado](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Microsoft Learn, [Guia para executar Azure Functions C# em um processo de worker isolado](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Azure updates, [O suporte para o modelo in-process termina em 10 de novembro de 2026](https://aka.ms/azure-functions-retirements/in-process-model).
- Microsoft Learn, [Migrar Durable Functions de in-process para o modelo de worker isolado](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-migrate).
- `Microsoft.Azure.Functions.Worker` no [NuGet](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
