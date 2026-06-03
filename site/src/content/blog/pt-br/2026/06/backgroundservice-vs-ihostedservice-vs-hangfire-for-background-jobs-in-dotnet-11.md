---
title: "BackgroundService vs IHostedService vs Hangfire para tarefas em segundo plano no .NET 11"
description: "Escolha BackgroundService para loops em processo, IHostedService puro quando precisar de controle fino do ciclo de vida, e Hangfire quando as tarefas precisarem sobreviver a um reinício. Uma matriz de decisão com código e o detalhe que decide por você."
pubDate: 2026-06-03
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-03
---

Para trabalho em segundo plano em uma aplicação .NET 11, a resposta curta é: use `BackgroundService` para loops contínuos em processo e consumidores de fila, desça para um `IHostedService` puro apenas quando precisar de inicialização ou desligamento ordenado e explícito, e recorra ao Hangfire no momento em que uma tarefa precisar sobreviver a um reinício do processo ou tiver que ser agendada para "a próxima terça-feira às 2h da manhã". Os dois primeiros são a mesma primitiva de hosting em altitudes diferentes e não custam nada a mais. O Hangfire é uma dependência separada com um banco de dados por trás, e esse banco de dados é exatamente o que você está pagando. Este post constrói a matriz de decisão, mostra o código mínimo de cada opção e aponta o único requisito (a durabilidade) que normalmente decide por você.

Todos os exemplos têm como alvo .NET 11 e C# 14. Os exemplos do Hangfire usam Hangfire 1.8.x (`Hangfire.AspNetCore` mais `Hangfire.SqlServer`).

## A matriz de recursos

Esta é a tabela que você veio ver. Leia primeiro a linha "Sobrevive a um reinício"; é a que divide o campo.

| Recurso                          | IHostedService          | BackgroundService        | Hangfire                       |
| -------------------------------- | ----------------------- | ------------------------ | ------------------------------ |
| Integrado ao .NET 11             | sim                     | sim                      | não (NuGet + armazenamento)    |
| Infraestrutura extra             | nenhuma                 | nenhuma                  | SQL Server / Redis / Postgres  |
| Superfície de ciclo de vida      | `StartAsync`/`StopAsync`| um `ExecuteAsync`        | nenhuma (você enfileira)       |
| Melhor para                      | passos de início/parada | loops de longa duração   | tarefas pontuais e agendadas   |
| Sobrevive a um reinício          | não                     | não                      | sim                            |
| Tentativas em caso de falha      | você escreve            | você escreve             | automáticas, configuráveis     |
| Agendamento (cron, atraso)       | você escreve            | você escreve             | embutido                       |
| Roda em várias instâncias        | roda em cada instância  | roda em cada instância   | um worker pega cada tarefa     |
| Painel / visibilidade            | nenhum                  | nenhum                   | painel web embutido            |
| Custo                            | gratuito                | gratuito                 | núcleo OSS; licença Pro às vezes |

`BackgroundService` não é uma alternativa ao `IHostedService`; é uma classe abstrata que o implementa. Então a escolha real tem duas vias: um serviço de hosting em processo (em uma de suas duas formas) versus um sistema de tarefas durável externo. Vamos em ordem.

## IHostedService: o contrato de ciclo de vida puro

`IHostedService` é a interface de baixo nível que o host genérico do .NET chama durante a inicialização e o desligamento. Ela tem exatamente dois métodos:

```csharp
// .NET 11, C# 14
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

O host aguarda (com `await`) o `StartAsync` de cada serviço registrado na ordem de registro antes de atender à primeira requisição, e aguarda o `StopAsync` (até `HostOptions.ShutdownTimeout`, 30 segundos por padrão) antes de o processo encerrar. Essa garantia de ordem é a razão para usar a interface pura: é o lugar certo para trabalho que precisa ser concluído antes de o tráfego chegar (aquecer um cache, executar uma verificação única de migração, abrir uma conexão de vida longa).

```csharp
// .NET 11, C# 14
public sealed class CacheWarmer(IMemoryCache cache, IProductRepository repo) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // Runs to completion BEFORE the app starts serving requests.
        var hot = await repo.GetHotProductsAsync(ct);
        cache.Set("hot-products", hot);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

A armadilha com o `IHostedService` puro é fazer trabalho de longa duração dentro do `StartAsync`. Se você iniciar um loop infinito ali e o aguardar com `await`, o host nunca termina de iniciar. Você precisa disparar o loop sem aguardá-lo e rastrear o `Task` por conta própria, para depois cancelá-lo e aguardá-lo no `StopAsync`. Essa contabilidade é exatamente o que o `BackgroundService` existe para eliminar.

Se você precisar de um controle ainda mais fino (um gancho que rode *depois que cada* serviço de hosting tiver iniciado, ou logo antes de o desligamento começar), o .NET 8 adicionou `IHostedLifecycleService`, que estende `IHostedService` com `StartingAsync`/`StartedAsync` e `StoppingAsync`/`StoppedAsync`. Ele continua atual no .NET 11 e é o lugar documentado para uma validação entre serviços do tipo "agora tudo está no ar", como descreve o [tutorial da interface de Steve Gordon](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8).

## BackgroundService: o loop que você realmente quer

`BackgroundService` é a classe base abstrata que implementa `IHostedService` por você usando o padrão template-method. Você sobrescreve um único método:

```csharp
// .NET 11, C# 14
public sealed class QueuePump(IServiceScopeFactory scopeFactory, ILogger<QueuePump> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
                await processor.DrainOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // normal shutdown
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Order pump iteration failed; retrying");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
```

O framework chama `ExecuteAsync` de dentro do seu próprio `StartAsync`, sinaliza o `stoppingToken` quando o host para e aguarda com `await` o `Task` que você retorna durante o desligamento. Dois detalhes mordem as pessoas com frequência suficiente para serem destacados:

- **Um `BackgroundService` é um singleton.** Você não pode injetar um serviço com escopo como um `DbContext` diretamente; você recebe `IServiceScopeFactory` e abre um escopo por unidade de trabalho, exatamente como acima. Escrevi um tutorial dedicado sobre [usar serviços com escopo dentro de um BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **Uma exceção não tratada no `ExecuteAsync` para o serviço silenciosamente** (e desde o .NET 6, por padrão, para todo o host por meio de `BackgroundServiceExceptionBehavior.StopHost`). Envolva o corpo do loop em try/catch se uma única iteração ruim não deve matar o serviço, como mostrado.

Registre qualquer uma das formas da mesma maneira:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHostedService<QueuePump>();      // BackgroundService
builder.Services.AddHostedService<CacheWarmer>();    // raw IHostedService
```

Um `BackgroundService` combinado com um `System.Threading.Channel` limitado é a fila de tarefas em processo canônica: produtores escrevem itens de trabalho, o serviço os drena. Se você já recorreu a `Task.Run` a partir de um controller, esse é o padrão que você realmente queria: veja [executar trabalho fire-and-forget com segurança usando um BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) e o argumento mais amplo a favor dos [Channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Quando escolher as opções em processo

**Escolha `BackgroundService` quando:**

- Você tem um loop contínuo: um consumidor de fila, um poller, um heartbeat, um flush de métricas. Este é o território dele.
- É aceitável perder o trabalho no desligamento, ou você drena os itens em andamento na breve janela do `StopAsync`. Novas tentativas de e-mail que serão reprocessadas de uma fila de qualquer forma, atualizações de cache, envio de logs.
- Você quer zero infraestrutura nova. Ele vem em `Microsoft.Extensions.Hosting`; não há nada a instalar ou provisionar.

**Escolha `IHostedService` puro (ou `IHostedLifecycleService`) quando:**

- Você precisa que o trabalho termine *antes* de a primeira requisição ser atendida (aquecer cache, verificar esquema, prefetch de feature flags).
- Você precisa de início ou desligamento ordenado entre vários serviços, ou de um gancho de validação "tudo verde" após a inicialização.
- O trabalho é um passo discreto de início/parada, não um loop perpétuo, então o formato de um único `ExecuteAsync` do `BackgroundService` não encaixa.

Ambos rodam em *cada* instância da sua aplicação. Se você escalar para três réplicas, seu `BackgroundService` roda três vezes, em paralelo, sem coordenação. Para um poller sem estado, tudo bem. Para "enviar o e-mail noturno de faturas uma vez", é um bug.

## Quando escolher o Hangfire

**Escolha o Hangfire quando qualquer uma destas for verdadeira:**

- **Uma tarefa precisa sobreviver a um reinício ou crash.** O Hangfire grava a tarefa no armazenamento (SQL Server, Redis ou PostgreSQL) antes de executá-la, de modo que um deploy no meio de uma tarefa não a perde. A tarefa é retomada. Esse é o recurso principal.
- **Você precisa de agendamento.** "Executar em 10 minutos", "todo dia útil às 6h" (cron), "neste exato instante UTC". Embutido, sem matemática de timers.
- **Você precisa de novas tentativas automáticas com recuo.** O Hangfire tenta novamente as tarefas falhas um número configurável de vezes por padrão, com o histórico de tentativas visível em seu painel.
- **Você precisa de uma única execução em N instâncias.** Os servidores do Hangfire competem pelas tarefas do armazenamento compartilhado, então cada tarefa roda uma vez independentemente de quantas instâncias da aplicação estejam no ar. Isso resolve de forma limpa o problema do "e-mail noturno três vezes".
- **Você quer visibilidade operacional.** O painel incluído mostra tarefas enfileiradas, em processamento, bem-sucedidas e falhas com stack traces, algo que de outra forma você teria que construir.

Configuração mínima no .NET 11:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString("HangfireDb")));

builder.Services.AddHangfireServer();

var app = builder.Build();
app.UseHangfireDashboard("/jobs");  // lock this down in production

// Fire-and-forget, durable:
BackgroundJob.Enqueue<IInvoiceService>(s => s.SendAsync(orderId, CancellationToken.None));

// Recurring (cron):
RecurringJob.AddOrUpdate<IReportService>(
    "nightly-report",
    s => s.BuildAsync(CancellationToken.None),
    Cron.Daily(2));
```

Repare no que acabou de mudar: agora você é dono de um conjunto de tabelas de banco de dados que o Hangfire gerencia, uma string de conexão, migrações desse esquema entre atualizações do Hangfire e um endpoint de painel que você precisa autorizar. Isso é peso operacional real. Você o assume deliberadamente, em troca de durabilidade e agendamento que de outra forma você improvisaria mal.

## O panorama de throughput, com números reais

Desempenho raramente é o eixo decisivo aqui, mas vale a pena ser honesto sobre o custo da durabilidade. Um `BackgroundService` em processo drenando um `Channel` não faz E/S por item além do seu próprio trabalho; a sobrecarga de despacho é, na prática, uma chamada de método e não é mensurável diante do trabalho em si. O Hangfire, em contraste, faz pelo menos uma ida e volta ao armazenamento para desenfileirar e outra para marcar a conclusão por tarefa.

A própria documentação do Hangfire quantifica a escolha de armazenamento: mudar de SQL Server para Redis rende **mais de 4 vezes o throughput** em tarefas vazias, conforme o [guia do Redis](https://docs.hangfire.io/en/latest/configuration/using-redis.html). Os números absolutos dependem da latência do seu armazenamento, mas o formato é fixo: o piso do Hangfire é "idas e voltas a um banco de dados", e o piso de uma fila em processo é "nada". Se você processa dezenas de milhares de itens triviais por segundo, essa diferença importa e uma fila em processo com `Channel` ganha de longe. Se você processa milhares de tarefas por minuto que cada uma faz trabalho real (chamar uma API, renderizar um PDF), o custo de armazenamento por tarefa desaparece no ruído e a durabilidade é gratuita na prática.

A regra que se conclui: não coloque trabalho de alta frequência e tolerante a perdas no Hangfire só porque ele está ali. Um poller que verifica uma fila a cada segundo é um `BackgroundService`, não 86.400 tarefas do Hangfire por dia.

## O detalhe que decide por você

Dois requisitos encerram o debate antes de a preferência entrar:

1. **"Isto não pode ser perdido se a aplicação reiniciar."** Se uma tarefa é descartada em um deploy e isso é um bug real (a captura de um pagamento, um e-mail de confirmação, a entrega de um webhook), você precisa de armazenamento durável, e isso significa Hangfire (ou um message broker de verdade). Nenhuma quantidade de drenagem no `StopAsync` faz um `BackgroundService` sobreviver a um `kill -9` ou a uma falha de nó. As opções em processo mantêm o trabalho na memória; a memória morre com o processo.

2. **"Isto deve rodar exatamente uma vez nas minhas réplicas."** Um `BackgroundService` roda em cada instância. Se você escalar horizontalmente e a tarefa não for idempotente, você obtém trabalho duplicado. O modelo de worker com armazenamento compartilhado do Hangfire dá uma única execução de graça. O equivalente em processo é um lock distribuído que você precisa construir e acertar.

Se nenhum dos dois requisitos se aplica (o trabalho é em processo, tolerante a perdas e ou roda uma vez porque você executa uma instância ou é naturalmente idempotente), então adicionar o Hangfire é pagar um imposto de banco de dados por nada. Use `BackgroundService`.

Um híbrido comum e correto: mantenha o *agendamento e as novas tentativas* duráveis no Hangfire, mas deixe o corpo da tarefa recorrente apenas enfileirar em um `Channel` em processo que um `BackgroundService` drena. O Hangfire garante que a tarefa dispare uma vez e sobreviva a reinícios; o `Channel` dá um throughput em processo rápido e consciente de contrapressão. Você obtém as duas propriedades sem forçar cada item a passar pelo armazenamento.

## A recomendação, repetida

Por padrão, use `BackgroundService` para qualquer coisa que faça loops em processo. Recorra ao `IHostedService` puro ou ao `IHostedLifecycleService` apenas quando precisar especificamente de ordem de inicialização ou ganchos de pré/pós-desligamento. Adote o Hangfire no momento em que uma tarefa precisar sobreviver a um reinício, rodar em um agendamento, repetir automaticamente ou executar exatamente uma vez em várias instâncias, e aceite o banco de dados que ele traz como o preço dessas garantias. O instinto de recorrer ao Hangfire "por segurança" costuma estar invertido: comece em processo e deixe um requisito concreto de durabilidade ou agendamento puxá-lo para a ferramenta mais pesada. Quando você rodar sobre as primitivas embutidas, [monitore essas tarefas em segundo plano com health checks e métricas](/pt-br/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) para não voar às cegas, e garanta que seus loops [cancelem de forma limpa sem deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) no desligamento.

## Fontes

- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) -- Microsoft Learn
- [Implement background tasks with IHostedService and BackgroundService](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/multi-container-microservice-net-applications/background-tasks-with-ihostedservice) -- Microsoft Learn
- [Introducing the new IHostedLifecycleService interface in .NET 8](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) -- Steve Gordon
- [Hangfire overview and supported storage](https://www.hangfire.io/) -- Hangfire
- [Using Redis storage (throughput note)](https://docs.hangfire.io/en/latest/configuration/using-redis.html) -- Hangfire Documentation
- [Using SQL Server storage](https://docs.hangfire.io/en/latest/configuration/using-sql-server.html) -- Hangfire Documentation
