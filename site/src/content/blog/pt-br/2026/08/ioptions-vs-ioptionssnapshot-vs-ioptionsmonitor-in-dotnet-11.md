---
title: "IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> no .NET 11"
description: "Use IOptions<T> por padrão. Use IOptionsMonitor<T> quando um singleton precisa enxergar recargas de configuração, e IOptionsSnapshot<T> apenas quando um consumidor scoped precisa de um valor estável durante uma requisição. O eixo que decide é o tempo de vida do consumidor, não o formato das configurações."
pubDate: 2026-08-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-01
---

Injete `IOptions<T>` a menos que você tenha um motivo concreto para não fazer isso. Ele é um singleton, faz o bind da sua classe de configurações exatamente uma vez durante toda a vida do processo e é o mais barato dos três para resolver. Recorra a `IOptionsMonitor<T>` quando um serviço de vida longa precisa observar mudanças de configuração sem reiniciar, e a `IOptionsSnapshot<T>` em um caso bem estreito: um consumidor scoped ou transient que quer um valor estável durante uma única requisição, mas que pode diferir entre requisições. O eixo que decide isso é o tempo de vida da classe que faz a injeção, não o formato das configurações injetadas. Tudo abaixo tem como alvo o .NET 11 (testado contra o Preview 6, SDK `11.0.100-preview.6.26359.118`) e C# 14, com `Microsoft.Extensions.Options` 11.0.0. As três interfaces se comportam assim desde o .NET Core 2.0, então tudo isso roda sem alterações no .NET 10 GA; a única coisa realmente nova é o trabalho de validação do .NET 11 no final.

## A matriz de recursos

| Recurso | `IOptions<T>` | `IOptionsSnapshot<T>` | `IOptionsMonitor<T>` |
| --- | --- | --- | --- |
| Implementação concreta | `UnnamedOptionsManager<T>` | `OptionsManager<T>` | `OptionsMonitor<T>` |
| Tempo de vida na DI | Singleton | **Scoped** | Singleton |
| Injetável em um singleton | Sim | Não, dependência cativa | Sim |
| Enxerga uma recarga de configuração | Nunca | Sim, no próximo escopo | Sim, imediatamente |
| Opções nomeadas | Não | Sim, `Get(name)` | Sim, `Get(name)` |
| Callbacks de mudança | Não | Não | Sim, `OnChange` |
| Acesso ao valor | `.Value` | `.Value`, `.Get(name)` | `.CurrentValue`, `.Get(name)` |
| Frequência com que o binder roda | Uma vez por processo | Uma vez por escopo, por nome | Uma vez por mudança, por nome |
| Onde a instância fica em cache | Campo do singleton | `OptionsCache<T>` dentro do manager scoped | `IOptionsMonitorCache<T>` singleton |

Duas linhas carregam quase todo o peso. A linha do tempo de vida é a que produz exceções na inicialização, e a linha "frequência com que o binder roda" é a que produz CPU inesperada em um caminho quente. Todo o resto decorre dessas duas.

As três são registradas por `AddOptions()`, que o host chama por você. De [OptionsServiceCollectionExtensions](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs):

```csharp
// Microsoft.Extensions.Options 11.0.0 -- what AddOptions() actually registers
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptions<>), typeof(UnnamedOptionsManager<>)));
services.TryAdd(ServiceDescriptor.Scoped(typeof(IOptionsSnapshot<>), typeof(OptionsManager<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitor<>), typeof(OptionsMonitor<>)));
services.TryAdd(ServiceDescriptor.Transient(typeof(IOptionsFactory<>), typeof(OptionsFactory<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitorCache<>), typeof(OptionsCache<>)));
```

Repare que `IOptionsFactory<T>` é transient e faz o trabalho de verdade: ele executa cada `IConfigureOptions<T>` registrado em ordem, depois cada `IPostConfigureOptions<T>` e então a validação. As três interfaces de acesso se diferenciam apenas em quão agressivamente colocam a saída da fábrica em cache. Essa é a história inteira, e é por isso que a escolha é sobre tempo de vida.

A classe de configurações e o registro são idênticos para as três:

```csharp
// .NET 11, C# 14
public sealed class PaymentOptions
{
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
}

// Program.cs
builder.Services.Configure<PaymentOptions>(
    builder.Configuration.GetSection("Payment"));
```

## Quando escolher IOptions

Faça dele o padrão. Você abre mão do suporte a recarga, e na maioria dos serviços isso não é uma perda real.

- **Qualquer coisa lida na inicialização.** Strings de conexão, uma URL base, o nome de uma fila, um feature flag que você mudaria com um novo deploy. `IOptions<T>` é um singleton, então injetá-lo em um singleton, em um serviço scoped ou em um transient funciona igual. Se você recebe um erro `Cannot consume scoped service` ao ligar suas configurações, `IOptions<T>` costuma ser a correção e não a causa. Veja [por que essa exceção acontece e como desfazê-la](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Caminhos quentes.** `UnnamedOptionsManager<T>` guarda a instância vinculada em um campo. Depois do primeiro acesso, `.Value` é uma leitura de campo. Não há busca em dicionário, nem comparação de nomes, nem alocação.
- **Capturar no construtor é seguro.** Como o valor nunca pode mudar, `options.Value` em um construtor é correto e não um bug latente.

```csharp
// .NET 11, C# 14
public sealed class PaymentClient(IOptions<PaymentOptions> options)
{
    // Safe: the value is fixed for the life of the process.
    private readonly PaymentOptions _settings = options.Value;

    public TimeSpan Timeout => TimeSpan.FromSeconds(_settings.TimeoutSeconds);
}
```

O custo de `IOptions<T>` é exatamente um: ele não suporta opções nomeadas, então `Configure<Features>("Personalize", ...)` é invisível para ele. Se você precisa de duas configurações da mesma classe, já descartou `IOptions<T>`. Esse também é o momento de verificar se [serviços com chave na injeção de dependência do .NET 11](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) se encaixam melhor do que opções nomeadas para aquilo que você está realmente modelando.

## Quando escolher IOptionsSnapshot

Recorra a ele quando um consumidor **scoped** precisa de um valor que permaneça consistente durante uma unidade de trabalho, mas que possa mudar entre unidades de trabalho.

- **Um valor por requisição que não pode mudar no meio do caminho.** Um controller e três serviços que ele chama resolvem a mesma instância scoped de `OptionsManager<T>`, então os quatro veem a mesma instância de `PaymentOptions` mesmo se `appsettings.json` for reescrito na metade da requisição. `IOptionsMonitor<T>` não dá essa garantia: duas leituras de `CurrentValue` na mesma requisição podem retornar duas instâncias diferentes.
- **Opções nomeadas em um consumidor scoped.** `Get(name)` é suportado, e a `OptionsCache<T>` por escopo faz com que o segundo `Get("Personalize")` da requisição seja um acerto de cache.

```csharp
// .NET 11, C# 14 -- scoped service, values stable for this request
public sealed class CheckoutService(IOptionsSnapshot<PaymentOptions> snapshot)
{
    private readonly PaymentOptions _settings = snapshot.Value;

    public string Key => _settings.ApiKey;
}
```

Dois limites duros. Primeiro, `IOptionsSnapshot<T>` é registrado como `Scoped`, então injetá-lo em um singleton falha, inclusive dentro de um `IHostedService` ou `BackgroundService`, que são singletons. O host liga `ValidateScopes` e `ValidateOnBuild` no ambiente Development, então lá você recebe um `Cannot consume scoped service` claro na inicialização; fora do Development essas verificações vêm desligadas por padrão, e o mesmo código resolve uma dependência cativa que silenciosamente nunca se atualiza. Ligue a validação de escopo em todos os ambientes se você quer que a falha seja barulhenta. A alternativa é [criar um escopo dentro do BackgroundService](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) e resolver a partir dali, mas se tudo o que você queria eram valores atualizados, `IOptionsMonitor<T>` é a resposta mais simples. Segundo, em um aplicativo de console ou em um `IHost` puro não existe escopo ambiente a menos que você crie um, então `IOptionsSnapshot<T>` fora de um host web quase sempre significa que você na verdade queria `IOptionsMonitor<T>`.

## Quando escolher IOptionsMonitor

Recorra a ele quando um **singleton** precisa enxergar mudanças, ou quando você precisa de um callback.

- **Um singleton que não pode ser reiniciado para pegar um valor novo.** Um limitador de taxa, uma política de cache, uma porcentagem de amostragem, um nível de log.
- **Você precisa reagir, não apenas ler.** `OnChange` é a única notificação push das três.
- **Invalidação seletiva.** `IOptionsMonitorCache<T>.TryRemove(name)` força uma única instância nomeada a ser reconstruída no próximo acesso, o que é útil quando é o seu próprio código, e não um observador de arquivos, que sabe que o valor ficou obsoleto.

`OptionsMonitor<T>` se inscreve em cada `IOptionsChangeTokenSource<T>` registrado. Quando um deles dispara, `InvokeChanged` executa `_cache.TryRemove(name)`, reconstrói imediatamente com `TOptions options = Get(name)` e então invoca os ouvintes com a nova instância. `CurrentValue` é um invólucro fino sobre `Get(Options.DefaultName)`, que é `_cache.GetOrAdd(localName, () => localFactory.Create(localName))`.

```csharp
// .NET 11, C# 14 -- singleton, always current
public sealed class RateLimiter : IDisposable
{
    private readonly IDisposable? _subscription;
    private volatile PaymentOptions _current;

    public RateLimiter(IOptionsMonitor<PaymentOptions> monitor)
    {
        _current = monitor.CurrentValue;
        _subscription = monitor.OnChange(updated => _current = updated);
    }

    public int TimeoutSeconds => _current.TimeoutSeconds;

    public void Dispose() => _subscription?.Dispose();
}
```

Esse `IDisposable` importa. `OnChange` retorna um `ChangeTrackerDisposable` cujo `Dispose` executa `_monitor._onChange -= OnChange`. Registre um callback a partir de um serviço scoped ou transient e jogue fora o valor retornado, e cada requisição adiciona um ouvinte ao delegate multicast de um singleton que nunca sai. O resultado é um vazamento de memória lento somado a uma tempestade de callbacks, e é uma das formas mais comuns de um `IOptionsMonitor<T>` dar errado.

Notificações de mudança só existem para provedores de configuração baseados em sistema de arquivos, como `Microsoft.Extensions.Configuration.Json`, `.Ini`, `.Xml`, `.KeyPerFile` e `.UserSecrets`, e apenas quando o provedor foi adicionado com `reloadOnChange: true`. Um provedor de variáveis de ambiente ou de linha de comando nunca dispara, então sobre essas fontes `IOptionsMonitor<T>` degrada silenciosamente para um `IOptions<T>` um pouco mais caro.

## A medição que importa é uma contagem, não um número em nanossegundos

Deliberadamente não publico números de ns/op aqui, porque o custo de resolução dos três é dominado pelo que os seus próprios delegates `IConfigureOptions<T>` e validadores fazem, o que significa que os números da minha máquina não diriam nada sobre a sua. O número que é portável é **quantas vezes o seu binder roda**, e você consegue medir isso em cerca de quinze linhas.

```csharp
// .NET 11 Preview 6, C# 14 -- counts how often the options are actually built
public sealed class CountingConfigure : IConfigureOptions<PaymentOptions>
{
    public static int Count;
    public void Configure(PaymentOptions options) => Interlocked.Increment(ref Count);
}

builder.Services.AddSingleton<IConfigureOptions<PaymentOptions>, CountingConfigure>();

app.MapGet("/probe", (
    IOptions<PaymentOptions> o,
    IOptionsSnapshot<PaymentOptions> s,
    IOptionsMonitor<PaymentOptions> m) =>
{
    _ = o.Value; _ = s.Value; _ = m.CurrentValue;
    return CountingConfigure.Count;
});
```

Acesse `/probe` repetidamente e o contador sobe exatamente um por requisição, e esse um é o `IOptionsSnapshot<T>`. `IOptions<T>` contribui somente na primeira requisição, `IOptionsMonitor<T>` contribui na primeira requisição e depois uma vez por recarga, e `IOptionsSnapshot<T>` contribui em toda requisição porque um escopo novo significa um `OptionsManager<T>` novo com uma `OptionsCache<T>` vazia. Adicione `.ValidateDataAnnotations()` a esse registro e os validadores também rodam de novo em cada requisição. Em um endpoint fazendo 5.000 requisições por segundo, isso são 5.000 rebinds e 5.000 passagens de validação por segundo para um valor que quase nunca muda. Esta é a razão concreta pela qual `IOptionsSnapshot<T>` não deveria ser o seu padrão, e é uma afirmação que você pode verificar no seu próprio aplicativo em vez de aceitar de um gráfico.

## As pegadinhas que decidem por você

**`OnChange` dispara para configuração que você não se importa.** Os callbacks são ligados ao change token da raiz da configuração, não à sua seção. Qualquer escrita em qualquer parte de `IConfiguration` invoca todos os ouvintes de `IOptionsMonitor<T>` do aplicativo. O time do .NET registrou isso como [dotnet/runtime#109445](https://github.com/dotnet/runtime/issues/109445) e fechou como não planejado, então o comportamento é permanente: enquanto qualquer parte da configuração mudar, todas as instâncias de `IOptionsMonitor` podem disparar seus callbacks. Se o seu callback reconstrói um recurso caro, guarde o valor anterior em cache e compare antes de agir.

**`OnChange` também dispara mais de uma vez por gravação.** Editores escrevem arquivos em várias operações, e o `IFileProvider.Watch` subjacente reporta cada uma delas, então um único `Ctrl+S` comumente produz dois callbacks e às vezes mais. Isso é [dotnet/aspnetcore#2542](https://github.com/dotnet/aspnetcore/issues/2542), e é um artefato do observador de arquivos, não um bug da pilha de opções. Torne o seu callback idempotente ou aplique um debounce.

**O monitoramento de arquivos não é confiável em volumes Docker e compartilhamentos de rede.** Defina `DOTNET_USE_POLLING_FILE_WATCHER=1` para fazer polling. O intervalo de polling é de quatro segundos e não é configurável, o que é uma restrição real se você contava com uma propagação mais rápida.

**`IOptions<T>` realmente significa para sempre.** O valor é vinculado na primeira vez que `.Value` é lido e fica em cache por toda a vida do processo. Se o modelo mental do seu time é "o objeto de configurações se atualiza", `IOptions<T>` vai parecer quebrado durante um incidente quando um push de configuração não fizer nada. Decida isso por classe de configurações e deixe registrado.

**Configurar opções com serviços scoped é uma armadilha independentemente do acessor.** `IConfigureOptions<T>` é resolvido através do provider raiz para `IOptions<T>`, então uma dependência scoped injetada no seu delegate de configuração vira uma dependência cativa. Resolva um `IServiceProvider` e crie um escopo dentro de `Configure`, e lembre que esse escopo não é o escopo da requisição.

## O que o .NET 11 acrescenta

Duas coisas que valem a pena conhecer, ambas na camada de validação e não na de acesso.

`OptionsBuilder<TOptions>` ganha uma sobrecarga genérica de `Validate` que recebe um parâmetro de tipo em vez de um delegate. O tipo precisa implementar `IValidateOptions<TOptions>` e estar registrado na DI, o que alinha a validação de opções com o padrão normal de DI:

```csharp
// .NET 11, C# 14
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

`System.ComponentModel.DataAnnotations` também aprendeu validação assíncrona no .NET 11, via `AsyncValidationAttribute`, `IAsyncValidatableObject` e `Validator.ValidateObjectAsync`. `Microsoft.Extensions.Options` acompanha isso por meio de um novo `IAsyncStartupValidator`, então uma opção cuja validade depende de uma chamada de rede pode derrubar o aplicativo na inicialização em vez de no primeiro uso. Nenhuma das duas mudanças altera qual acessor você deve injetar; ambas tornam `ValidateOnStart` um padrão mais forte do que era no .NET 10.

## A recomendação, de novo

Comece toda classe de configurações com `IOptions<T>`. Passe para `IOptionsMonitor<T>` quando um singleton específico tiver uma necessidade documentada de observar mudanças, e descarte a assinatura de `OnChange`. Use `IOptionsSnapshot<T>` apenas quando um consumidor scoped precisar de estabilidade por requisição de um valor que de fato muda, e aceite que você está pagando um rebind completo mais uma revalidação em cada requisição para conseguir isso. Se você se pegar recorrendo a `IOptionsSnapshot<T>` porque um erro de compilação sumiu, você resolveu um problema de tempo de vida com um problema de desempenho.

## Relacionados

- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Como usar serviços scoped dentro de um BackgroundService no ASP.NET Core 11](/pt-br/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Como registrar e resolver serviços com chave na injeção de dependência do .NET 11](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [Fix: No connection string named 'DefaultConnection' could be found](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/)
- [Como escrever testes de integração com WebApplicationFactory no ASP.NET Core 11](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)

## Fontes

- [Padrão de opções no .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options), Microsoft Learn
- [Novidades das bibliotecas do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), Microsoft Learn
- [OptionsServiceCollectionExtensions.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs), dotnet/runtime
- [OptionsMonitor.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsMonitor.cs), dotnet/runtime
- [IOptionsMonitor OnChange dispara sempre que qualquer coisa muda em IConfiguration](https://github.com/dotnet/runtime/issues/109445), issue 109445 do dotnet/runtime
- [ChangeToken.OnChange dispara duas vezes ao escutar mudanças de configuração](https://github.com/dotnet/aspnetcore/issues/2542), issue 2542 do dotnet/aspnetcore
- [Os perigos e pegadinhas de usar serviços scoped ao configurar opções](https://andrewlock.net/the-dangers-and-gotchas-of-using-scoped-services-when-configuring-options-in-asp-net-core/), Andrew Lock
