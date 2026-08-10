---
title: "Como sobrescrever o manipulador de resiliência padrão que o Aspire registra"
description: "O AddServiceDefaults do Aspire aplica um manipulador de resiliência padrão a todo HttpClient. Chamar AddStandardResilienceHandler de novo empilha um segundo manipulador em vez de substituí-lo. Aqui estão os três caminhos reais de sobrescrita, o nome de opções -standard que ninguém documenta e o timeout infinito que você herda se apenas removê-lo."
pubDate: 2026-08-10
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "resilience"
  - "polly"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers"
translatedBy: "claude"
translationDate: 2026-08-10
---

O `AddServiceDefaults()` do Aspire chama `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, o que coloca retentativas, um circuit breaker, um limitador de taxa e um timeout total de requisição de 30 segundos na frente de todo `HttpClient` do processo. Chamar `AddStandardResilienceHandler()` de novo em um cliente não substitui isso. Empilha um segundo manipulador em cima do primeiro, então uma única requisição lógica pode se transformar em dezesseis requisições físicas. Existem exatamente três formas de realmente sobrescrever o padrão: editar `ServiceDefaults/Extensions.cs` se ele for seu, chamar `RemoveAllResilienceHandlers()` no `IHttpClientBuilder` específico antes de adicionar o seu, ou reconfigurar a instância de opções nomeada que o manipulador padrão lê, que se chama literalmente `-standard`.

Todo comportamento descrito abaixo foi verificado executando, não lendo a documentação. O teste tem como alvo `net10.0` no SDK 10.0.201 com `Microsoft.Extensions.Http.Resilience` 10.8.0, que é o pacote que o template ServiceDefaults do Aspire 13.4.6 traz. O comportamento de resiliência vive nesse pacote, não no Aspire em si, então as mesmas regras valem para qualquer aplicação com `IHttpClientFactory` que use `ConfigureHttpClientDefaults`.

## O que o AddServiceDefaults realmente coloca na frente do seu HttpClient

O `ServiceDefaults/Extensions.cs` gerado contém isto:

```csharp
// Aspire 13.4.6 ServiceDefaults template
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();
    builder.AddDefaultHealthChecks();
    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        // Turn on resilience by default
        http.AddStandardResilienceHandler();

        // Turn on service discovery by default
        http.AddServiceDiscovery();
    });

    return builder;
}
```

`AddStandardResilienceHandler()` compõe cinco estratégias do Polly v8, da mais externa para a mais interna: um limitador de taxa (1000 permissões, fila 0), um timeout total de requisição de 30 segundos, uma estratégia de retentativa (3 retentativas, backoff exponencial com jitter, atraso base de 2 segundos), um circuit breaker (taxa de falha de 10 por cento, throughput mínimo 100, janela de amostragem de 30 segundos, abertura de 5 segundos) e um timeout por tentativa de 10 segundos. Retentativa e abertura de circuito disparam com HTTP 5xx, 408, 429, `HttpRequestException` e a `TimeoutRejectedException` do Polly.

Há mais uma linha nesse método que importa mais do que qualquer um dos padrões das estratégias:

```csharp
// ResilienceHttpClientBuilderExtensions.StandardResilience.cs, dotnet/extensions
// Disable the HttpClient timeout to allow the timeout strategies to control the timeout.
_ = builder.ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

Adicionar o manipulador padrão desliga completamente o `HttpClient.Timeout` e entrega o controle do timeout às estratégias do Polly. Guarde isso, porque sobrevive à remoção do manipulador. Volto ao assunto nas pegadinhas.

## Por que adicionar um segundo manipulador não substitui o primeiro

A intuição de que um registro por cliente sobrescreve um registro de padrões está errada aqui. `ConfigureHttpClientDefaults` e `AddHttpClient(name)` empurram para a mesma lista ordenada `HttpClientFactoryOptions.HttpMessageHandlerBuilderActions`, e `AddStandardResilienceHandler` acaba chamando `AddHttpMessageHandler`, que anexa ao fim. Nada faz deduplicação.

Registrei o bloco de padrões e depois um manipulador por cliente, e então percorri a cadeia de manipuladores construída com `IHttpMessageHandlerFactory.CreateHandler`:

```text
A stacked: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
           -> ResilienceHandler -> ResilienceHandler
           -> LoggingHttpMessageHandler -> SocketsHttpHandler
```

Duas instâncias de `ResilienceHandler`. Isso não é uma duplicata cosmética. A estratégia de retentativa externa emite até 4 tentativas, e cada uma delas passa pela estratégia de retentativa interna, que emite até 4 próprias, então uma chamada do seu código pode virar 16 requisições contra a dependência que você tentava proteger. Os dois limitadores de taxa cobram uma permissão cada, e os dois circuit breakers observam fatias diferentes do mesmo tráfego. O timeout total externo de 30 segundos é a única coisa que mantém tudo limitado, o que significa que você recebe uma requisição que falha em 30 segundos depois de martelar o serviço dependente, em vez do comportamento ajustado que você achava ter configurado.

O mesmo acontece se você chamar `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` no `Program.cs` em cima do `AddServiceDefaults()`. Eu verifiquei, e a cadeia mostra dois manipuladores em todo cliente do processo.

## Passos para sobrescrever o padrão sem empilhar manipuladores

1. **Decida o escopo.** Se a nova configuração deve valer para toda chamada de saída do serviço, altere o `ServiceDefaults/Extensions.cs`. Se apenas uma dependência é lenta ou não idempotente, faça por cliente e deixe o padrão em paz.
2. **Remova antes de adicionar.** No `IHttpClientBuilder` que você quer alterar, chame `RemoveAllResilienceHandlers()` primeiro e depois `AddStandardResilienceHandler(...)`. A ordem de registro dentro de um mesmo builder é o que decide o resultado.
3. **Suprima o `EXTEXP0001`.** `RemoveAllResilienceHandlers` está anotado com `[Experimental]`, e o diagnóstico é um erro, não um aviso, então o build falha sem um `#pragma warning disable` ou uma entrada `NoWarn`.
4. **Mantenha os timeouts coerentes entre si.** `TotalRequestTimeout` precisa ser maior que `AttemptTimeout`, e `CircuitBreaker.SamplingDuration` precisa ser pelo menos o dobro de `AttemptTimeout`, ou o host lança exceção na inicialização.
5. **Verifique a cadeia, não a intenção.** Resolva `IHttpMessageHandlerFactory` em um teste e conte as instâncias de `ResilienceHandler` no pipeline construído.

## Alterando para o serviço inteiro no ServiceDefaults

Se o `ServiceDefaults` é seu, editar o bloco é a correção honesta. A Microsoft entrega exatamente esse formato no template de chat do `Microsoft.Extensions.AI`, onde o endpoint do Ollama costuma levar minutos para responder e o timeout por tentativa de 10 segundos mataria toda requisição:

```csharp
// Microsoft.Extensions.Http.Resilience 10.8.0, .NET 10
public static IServiceCollection AddOllamaResilienceHandler(this IServiceCollection services)
{
    services.ConfigureHttpClientDefaults(http =>
    {
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers is experimental
        http.RemoveAllResilienceHandlers();
#pragma warning restore EXTEXP0001

        http.AddStandardResilienceHandler(config =>
        {
            config.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);

            // Must be at least double the AttemptTimeout to pass options validation
            config.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
            config.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        });
    });

    return services;
}
```

Repare que este é um segundo bloco `ConfigureHttpClientDefaults`, chamado depois do `AddServiceDefaults()`. A remoção roda antes da readição porque as ações executam na ordem de registro, então o efeito líquido é um manipulador com a sua configuração. O template também readiciona `AddServiceDiscovery()` dentro desse bloco, o que é desnecessário: `RemoveAllResilienceHandlers` só retira manipuladores do tipo `ResilienceHandler`, e readicionar o service discovery deixa você com dois manipuladores de service discovery.

## Sobrescrevendo um único cliente sem tocar no ServiceDefaults

Este é o caso que realmente aparece: uma dependência é lenta, ou um endpoint é um `POST` que você nunca pode repetir, e o resto do serviço deve manter os padrões do Aspire.

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.8.0
builder.AddServiceDefaults();

builder.Services.AddHttpClient("reports", client =>
    {
        client.BaseAddress = new Uri("https+http://reporting");
    })
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(o =>
    {
        o.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);
        o.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        o.Retry.DisableForUnsafeHttpMethods();
    });
```

Duas coisas sobre isso que não são óbvias.

Primeira, a ordem de chamada entre `AddServiceDefaults()` e `AddHttpClient(...)` não importa. `ConfigureHttpClientDefaults` insere seus registros em uma posição rastreada da coleção de serviços para que os padrões sempre rodem antes da configuração de clientes nomeados. Registrei o cliente nomeado primeiro e o bloco de padrões depois, e o cliente `reports` ainda assim terminou com exatamente um `ResilienceHandler` usando o timeout por tentativa de três minutos, enquanto um cliente não relacionado manteve o padrão de 10 segundos. A ordem importa, sim, dentro de uma mesma cadeia de builder: coloque `RemoveAllResilienceHandlers()` depois de `AddStandardResilienceHandler()` no mesmo cliente e você fica com um cliente sem resiliência nenhuma.

Segunda, `DisableForUnsafeHttpMethods()` desliga as retentativas para `POST`, `PATCH`, `PUT`, `DELETE` e `CONNECT`. O manipulador padrão repete todos os métodos por padrão, o que é um bug de duplicação de dados esperando para acontecer em um endpoint não idempotente. `DisableFor(HttpMethod.Post, HttpMethod.Delete)` dá a versão mais restrita.

## O nome de opções que ninguém documenta: `-standard`

`AddStandardResilienceHandler` não usa a instância de opções padrão. Ele calcula um nome de opções como `$"{httpClientName}-{pipelineIdentifier}"` com o identificador `standard` e depois lê essa instância nomeada através de `IOptionsMonitor<HttpStandardResilienceOptions>`. Para um cliente chamado `slow`, o nome de opções é `slow-standard`. Dentro de `ConfigureHttpClientDefaults` o `Name` do builder é null, então a interpolação de string produz `-standard`, com um hífen inicial e nada antes.

Isso tem uma aresta cortante. A chamada de `Configure<HttpStandardResilienceOptions>` que parece correta não faz nada:

```csharp
builder.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
builder.Services.Configure<HttpStandardResilienceOptions>(o => o.Retry.MaxRetryAttempts = 9);
```

```text
options[''].MaxRetryAttempts          = 9
options['-standard'].MaxRetryAttempts = 3
```

Seu valor cai na instância sem nome, que nenhum manipulador jamais lê, e o manipulador mantém o padrão 3. Sem exceção, sem entrada de log. Se você já "configurou" resiliência e viu efeito zero, é quase certamente por isso. Isso também explica por que o manipulador padrão é imune a um `Configure` simples mesmo que `HttpStandardResilienceOptions` seja uma classe de opções comum. A [diferença entre as interfaces de acesso a opções](/pt-br/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) não é o problema aqui; o nome é.

Conhecer o nome dá um terceiro caminho de sobrescrita, útil quando você não pode editar o `ServiceDefaults` (um pacote compartilhado, um template que não é seu) e não quer enumerar cada cliente:

```csharp
// Retunes the handler that AddServiceDefaults already registered.
builder.Services.Configure<HttpStandardResilienceOptions>("-standard", o =>
{
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(20);
    o.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
    o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90);
});
```

Isso resolve para `attempt=00:00:20 total=00:01:30` na inicialização, com um único manipulador na cadeia. É um literal de string acoplado a um detalhe de implementação, então deixe um comentário ao lado, mas funciona e não empilha.

Para configurações por cliente que pertencem à configuração e não ao código, faça bind de uma seção. `AddStandardResilienceHandler(IConfigurationSection)` é uma sobrecarga real que encaminha para `.Configure(section)` na instância de opções com o nome correto:

```json
{
  "Resilience": {
    "Slow": {
      "AttemptTimeout": { "Timeout": "00:03:00" },
      "TotalRequestTimeout": { "Timeout": "00:10:00" },
      "CircuitBreaker": { "SamplingDuration": "00:10:00" },
      "Retry": { "MaxRetryAttempts": 2 }
    }
  }
}
```

```csharp
builder.Services.AddHttpClient("slow")
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(builder.Configuration.GetSection("Resilience:Slow"));
```

Os valores vinculados chegam exatamente como escritos e, como o manipulador padrão chama `context.EnableReloads`, editar esses valores no `appsettings.json` reconstrói o pipeline sem reiniciar.

## As pegadinhas que mordem

**Timeouts inválidos falham na inicialização, não na primeira requisição.** Ambos os validadores são registrados com `AddOptionsWithValidateOnStart`, então uma incoerência lança exceção quando o host inicia. Definir só o `AttemptTimeout` em 3 minutos e deixar o resto como está produz isto:

```text
Microsoft.Extensions.Options.OptionsValidationException: Total request timeout resilience
strategy must have a greater timeout than the attempt resilience strategy. Total Request
Timeout: 30s, Attempt Timeout: 180s; The sampling duration of circuit breaker strategy needs
to be at least double of an attempt timeout strategy’s timeout interval, in order to be
effective. Sampling Duration: 30s,Attempt Timeout: 180s
```

A regra do dobro é um multiplicador 2 fixo no código do `HttpStandardResilienceOptionsCustomValidator`. Aumentar o `AttemptTimeout` sempre significa aumentar também `TotalRequestTimeout` e `CircuitBreaker.SamplingDuration`. Se você quer esse tipo de checagem nas suas próprias configurações, a mesma maquinaria está disponível via [validação na inicialização com `IValidateOptions<T>`](/pt-br/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/).

**Remover o manipulador deixa você sem timeout algum.** Esta é a pior. `RemoveAllResilienceHandlers()` retira as instâncias de `ResilienceHandler`, mas não desfaz o `ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan)` que o `AddStandardResilienceHandler` registrou. Um cliente construído com `AddHttpClient("bare").RemoveAllResilienceHandlers()` e nada readicionado dá:

```text
bare client chain:   LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
                     -> LoggingHttpMessageHandler -> SocketsHttpHandler
HttpClient('bare').Timeout = -00:00:00.0010000
```

Esse milissegundo negativo é `Timeout.InfiniteTimeSpan`. Sem manipulador de resiliência, sem o padrão de 100 segundos do `HttpClient`, sem timeout de espécie alguma. Uma dependência travada agora trava o thread pool das suas requisições até que dispare o token de cancelamento que, com sorte, você passou. Se você remover o manipulador e não adicionar outro, defina `client.Timeout` explicitamente. O modo de falha relacionado em que um timeout de fato dispara está coberto em [por que o HttpClient lança TaskCanceledException](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

**A remoção é por tipo, não por cadeia.** A implementação percorre os manipuladores adicionais de trás para frente e remove apenas os que satisfazem `is ResilienceHandler`. Tipos `DelegatingHandler` próprios, manipuladores de autenticação e o manipulador de service discovery sobrevivem. Confirmei com um manipulador marcador registrado no bloco de padrões: depois de `RemoveAllResilienceHandlers()` em um cliente nomeado, o marcador continua lá. Então não readicione o service discovery depois de uma remoção.

**Clientes gRPC precisam do `Grpc.Net.ClientFactory` 2.64.0 ou posterior.** Combinar o manipulador padrão com um `AddGrpcClient` mais antigo lança `System.InvalidOperationException: The ConfigureHttpClient method isn't supported when creating gRPC clients`. Existe uma checagem em tempo de build para isso, suprimível com `<SuppressCheckGrpcNetClientFactoryVersion>`.

**`RemoveAllResilienceHandlers` é experimental.** O `EXTEXP0001` é emitido como erro pelo analisador do `Microsoft.Extensions.Http.Resilience` 10.8.0, então o pragma é obrigatório, não um capricho de organização. A API está estável na forma desde a 9.0, mas a anotação significa que o time reserva o direito de mudá-la.

A regra que cobre tudo isso: um manipulador de resiliência é um manipulador de mensagens, e manipuladores de mensagens compõem em vez de substituir. Depois que você internaliza isso, "como sobrescrevo o padrão do Aspire" deixa de ser um quebra-cabeça e vira "remova, depois adicione, nessa ordem, no builder certo".

## Relacionados

- [Polly vs manipuladores de resiliência no .NET 11](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica em qual camada configurar resiliência antes de tudo.
- [Adicionando o Aspire a uma solução ASP.NET Core existente](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) cobre o que mais o `AddServiceDefaults()` liga.
- [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/) para entender como a cadeia de manipuladores é construída.
- [IOptions vs IOptionsSnapshot vs IOptionsMonitor no .NET 11](/pt-br/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) para o monitor pelo qual o manipulador padrão lê suas opções nomeadas.
- [Aspire vs Docker Compose para desenvolvimento local multisserviço](/pt-br/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/) se você ainda está decidindo se adota o Aspire.

## Fontes

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) no MS Learn, pela tabela de padrões do manipulador padrão e pelos problemas conhecidos.
- [`ResilienceHttpClientBuilderExtensions.StandardResilience.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHttpClientBuilderExtensions.StandardResilience.cs) no dotnet/extensions, pelo nome de opções e pelo timeout infinito do cliente.
- [`HttpStandardResilienceOptionsCustomValidator.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/Internal/Validators/HttpStandardResilienceOptionsCustomValidator.cs), pelas regras de validação exatas e suas mensagens.
- [`OllamaResilienceHandlerExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/ProjectTemplates/Microsoft.Extensions.AI.Templates/templates/AIChatWeb-CSharp/AIChatWeb-CSharp.Web/OllamaResilienceHandlerExtensions.cs), a própria sobrescrita da Microsoft do padrão do Aspire.
- [Aspire service defaults](https://aspire.dev/get-started/csharp-service-defaults/), pelo código-fonte gerado do `AddServiceDefaults`.
