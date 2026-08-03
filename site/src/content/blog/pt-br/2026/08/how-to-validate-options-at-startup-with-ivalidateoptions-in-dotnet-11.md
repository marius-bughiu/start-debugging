---
title: "Como validar opções na inicialização com IValidateOptions<T> no .NET 11"
description: "Implemente IValidateOptions<T>, registre na DI e encadeie ValidateOnStart para que um appsettings.json ruim derrube o processo em vez da primeira requisição que tocar nele. Cobre a sobrecarga Validate<TValidator>() do .NET 11, validação assíncrona com IAsyncValidateOptions<T> e os três lugares onde ValidateOnStart silenciosamente não faz nada."
pubDate: 2026-08-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "configuration"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Para fazer um aplicativo falhar na inicialização diante de configuração ruim, escreva uma classe que implemente `IValidateOptions<TOptions>`, registre-a na DI como singleton e encadeie `.ValidateOnStart()` no `OptionsBuilder<TOptions>` daquele tipo. Sem `ValidateOnStart`, os validadores rodam de forma preguiçosa no primeiro acesso a `.Value`, o que normalmente significa a primeira requisição que toca a configuração, em produção, às 3 da manhã. Com ele, `Host.StartAsync` força cada tipo de opções registrado a fazer bind e validar antes de um único serviço hospedado iniciar, e uma falha lança `OptionsValidationException` para fora de `host.RunAsync()`. Tudo abaixo tem como alvo o .NET 11 com `Microsoft.Extensions.Options` 11.0.0 e C# 14. O núcleo de `IValidateOptions<T>` e `ValidateOnStart` se comporta assim desde que a API saiu de `Microsoft.Extensions.Hosting.dll` para `Microsoft.Extensions.Options.dll`, então roda sem mudanças do .NET 8 ao .NET 10; a sobrecarga `Validate<TValidator>()` e o pipeline assíncrono são novidades do .NET 11 e estão explicitamente marcados.

## Validação preguiçosa é validação que você descobre por um cliente

`ValidateDataAnnotations()` e `Validate(delegate)` penduram validadores no pipeline de opções, mas o pipeline é preguiçoso por design. `IOptions<T>` é um singleton cujo `.Value` é calculado na primeira vez que alguém o lê. O que significa que este registro:

```csharp
// .NET 11, C# 14
builder.Services
    .AddOptions<PaymentOptions>()
    .Bind(builder.Configuration.GetSection("Payments"))
    .ValidateDataAnnotations();
```

produz um aplicativo que sobe limpo com uma seção `Payments` vazia, passa no health check, atende tráfego e então lança `OptionsValidationException` na primeira vez que uma requisição chega ao endpoint de checkout. Sua implantação teve sucesso. Seu canary estava verde. A falha apareceu como um 500 no cartão de um cliente.

O objetivo da validação na inicialização é converter isso em uma quebra no boot, algo que orquestradores já sabem tratar: o contêiner sai com código diferente de zero, o rollout para e a revisão anterior continua atendendo. É uma falha muito melhor do que um processo parcialmente quebrado.

## Passos para a validação na inicialização realmente disparar

1. **Defina a classe de opções com um nome de seção.** Somente propriedades públicas de leitura e escrita, não abstrata, com construtor público sem parâmetros. Campos não sofrem bind.
2. **Escreva o validador como uma classe que implemente `IValidateOptions<TOptions>`**, retornando `ValidateOptionsResult.Fail` com todas as falhas em vez da primeira.
3. **Registre o validador na DI.** Use `TryAddEnumerable` com um `ServiceDescriptor` singleton, porque o pipeline resolve `IEnumerable<IValidateOptions<TOptions>>` e um simples `AddSingleton` chamado duas vezes deixa o validador duplicado.
4. **Encadeie `.ValidateOnStart()`** no builder, ou comece por `AddOptionsWithValidateOnStart<TOptions>()` para não conseguir esquecer.
5. **Execute o host.** `ValidateOnStart` não faz nada até `Host.StartAsync` executar. Construir o host não basta.

Aqui está tudo de ponta a ponta.

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class PaymentOptions
{
    public const string SectionName = "Payments";

    [Required]
    public required string ApiKey { get; set; }

    [Required]
    [Url]
    public required string Endpoint { get; set; }

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [Range(0, 10)]
    public int MaxRetries { get; set; } = 3;
}
```

O validador. Repare que ele coleta falhas em vez de retornar na primeira, de modo que quem estiver consertando um `appsettings.json` quebrado recebe a lista completa em um único boot em vez de um erro por reinício:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
    public ValidateOptionsResult Validate(string? name, PaymentOptions options)
    {
        var builder = new ValidateOptionsResultBuilder();

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            builder.AddError("ApiKey is missing.", nameof(PaymentOptions.ApiKey));
        }
        else if (!options.ApiKey.StartsWith("pk_", StringComparison.Ordinal))
        {
            builder.AddError(
                "ApiKey must start with 'pk_'. A secret key was probably pasted by mistake.",
                nameof(PaymentOptions.ApiKey));
        }

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out Uri? endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps)
        {
            builder.AddError(
                "Endpoint must be an absolute https URI.",
                nameof(PaymentOptions.Endpoint));
        }

        // Cross-property rule: nothing in DataAnnotations can express this.
        if (options.TimeoutSeconds * (options.MaxRetries + 1) > 300)
        {
            builder.AddError(
                $"TimeoutSeconds ({options.TimeoutSeconds}) times MaxRetries + 1 "
                + $"({options.MaxRetries + 1}) exceeds the 300s gateway budget.");
        }

        return builder.Build();
    }
}
```

`ValidateOptionsResultBuilder` mora em `Microsoft.Extensions.Options` e existe justamente para você não montar um `StringBuilder` na mão. `Build()` retorna `ValidateOptionsResult.Success` quando nada foi adicionado, então não há dança de nulos no final. `AddError` aceita um nome de propriedade opcional que é prefixado na mensagem, e também existem `AddResult(ValidationResult)` e `AddResults(IEnumerable<ValidationResult>)` para levar a saída do DataAnnotations para o mesmo saco.

Registro:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection.Extensions;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptionsWithValidateOnStart<PaymentOptions>()
    .Bind(builder.Configuration.GetSection(PaymentOptions.SectionName))
    .ValidateDataAnnotations();

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<PaymentOptions>, ValidatePaymentOptions>());

var app = builder.Build();
await app.RunAsync();
```

`AddOptionsWithValidateOnStart<TOptions>()` é apenas `AddOptions<TOptions>().ValidateOnStart()` com a ordem tornada inesquecível. Existe também uma sobrecarga com dois genéricos, `AddOptionsWithValidateOnStart<TOptions, TValidateOptions>()`, que registra o validador para você e reduz os dois registros acima a uma única chamada.

`ValidateDataAnnotations()` e um `IValidateOptions<T>` escrito à mão não são excludentes. Os atributos tratam do formato de cada propriedade individual; a classe trata de regras que atravessam propriedades ou que precisam de um serviço. Todos os validadores registrados rodam, e todas as falhas deles são coletadas.

## O que ValidateOnStart de fato registra

`ValidateOnStart` não executa nada no momento do registro. Leia o [código-fonte do runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) do .NET 11 e verá que ele faz três coisas:

```csharp
optionsBuilder.Services.TryAddTransient<IStartupValidator, StartupValidator>();
optionsBuilder.Services.TryAddTransient<IAsyncStartupValidator, StartupValidator>();
optionsBuilder.Services.AddOptions<StartupValidatorOptions>()
    .Configure<IOptionsMonitor<TOptions>>((vo, options) =>
    {
        // This adds an action that resolves the options value to force evaluation
        // We don't care about the result as duplicates are not important
        vo._validators[(typeof(TOptions), optionsBuilder.Name)] = () => options.Get(optionsBuilder.Name);
    });
```

Ele adiciona um thunk a um dicionário interno em `StartupValidatorOptions`, indexado por `(Type, name)`. O thunk chama `IOptionsMonitor<TOptions>.Get(name)`, que é o que força `OptionsFactory<TOptions>.Create` a rodar a cadeia de `IConfigureOptions<T>`, depois a de `IPostConfigureOptions<T>` e depois cada `IValidateOptions<T>`. A validação é um efeito colateral de forçar o bind.

O `TryAdd` importa. Em versões anteriores isso era `AddTransient`, então chamar `ValidateOnStart` em dez tipos de opções colocava dez cópias de `StartupValidator` no contêiner. A chave do dicionário também explica uma aresta antiga: indexar por `(Type, name)` é o que faz cada instância nomeada ter sua própria entrada em vez de a última sobrescrever as demais.

O gatilho está em `Host.StartAsync`, depois de `IHostLifetime.WaitForStartAsync` e antes de qualquer serviço hospedado iniciar:

```csharp
IStartupValidator? validator = Services.GetService<IStartupValidator>();
validator?.Validate();

IAsyncStartupValidator? asyncValidator = Services.GetService<IAsyncStartupValidator>();
if (asyncValidator is not null)
{
    await asyncValidator.ValidateAsync(cancellationToken).ConfigureAwait(false);
}
```

Duas consequências que vale internalizar. Primeira, a validação roda antes de `IHostedLifecycleService.StartingAsync`, então um `BackgroundService` nunca observa uma configuração meio válida. Segunda, se mais de um tipo de opções falhar, `StartupValidator` coleta as exceções e as relança como uma `AggregateException`, então você vê todas as seções quebradas em uma única linha de log em vez de jogar whack-a-mole entre reinícios.

## A sobrecarga Validate<TValidator>() do .NET 11

Antes do .NET 11, ligar um validador significava duas instruções que precisavam concordar entre si: um `AddSingleton` para o validador e uma cadeia `AddOptions` separada. O .NET 11 adiciona uma sobrecarga genérica [`OptionsBuilder<TOptions>.Validate<TValidator>()`](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries#options-builder-validation-improvements) que recebe um parâmetro de tipo em vez de um delegate:

```csharp
// .NET 11 only
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

O tipo do validador precisa implementar `IValidateOptions<TOptions>` e já estar registrado no contêiner, e esse é justamente o ponto: o validador é resolvido pela DI, então pode receber dependências no construtor como `IHostEnvironment`, um `TimeProvider` ou um `HttpClient`. Isso antes era desconfortável porque as sobrecargas com delegate de `Validate` só dão a instância de opções, enquanto até cinco serviços injetados só estavam disponíveis do lado do `Configure`.

Não pule o `AddSingleton`. A sobrecarga resolve o tipo; ela não o registra.

## Validação assíncrona com IAsyncValidateOptions<T>

A adição interessante do .NET 11 é que a validação na inicialização agora pode fazer E/S. Certa configuração só está errada de formas que você não enxerga sem perguntar a alguém: uma string de conexão que faz parse mas aponta para um banco de dados inexistente, uma autoridade OIDC cujo documento de discovery retorna 404, um contêiner de blobs que a identidade gerenciada não consegue ler. Antes do .NET 11 as únicas opções honestas eram bloquear uma thread dentro de `Validate` ou desistir e checar no primeiro uso.

`IAsyncValidateOptions<TOptions>` é o gêmeo assíncrono de `IValidateOptions<TOptions>`:

```csharp
namespace Microsoft.Extensions.Options;

public interface IAsyncValidateOptions<in TOptions> where TOptions : class
{
    Task<ValidateOptionsResult> ValidateAsync(
        string? name, TOptions options, CancellationToken cancellationToken = default);
}
```

Uma implementação que prova que o endpoint de pagamento está de fato acessível:

```csharp
// .NET 11 only
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentEndpointAsync(IHttpClientFactory httpClientFactory)
    : IAsyncValidateOptions<PaymentOptions>
{
    public async Task<ValidateOptionsResult> ValidateAsync(
        string? name, PaymentOptions options, CancellationToken cancellationToken = default)
    {
        using HttpClient client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                new Uri(new Uri(options.Endpoint), "/.well-known/health"), cancellationToken);

            return response.IsSuccessStatusCode
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Payment endpoint {options.Endpoint} returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return ValidateOptionsResult.Fail(
                $"Payment endpoint {options.Endpoint} is unreachable: {ex.Message}");
        }
    }
}
```

Registre do mesmo jeito que o síncrono, com `TryAddEnumerable` contra `IAsyncValidateOptions<PaymentOptions>`, e mantenha a chamada a `ValidateOnStart()`. O registro em `OptionsBuilderExtensions` materializa qualquer `IAsyncValidateOptions<TOptions>` registrado em um segundo dicionário, `_asyncValidators`, e só instala o delegate assíncrono se existir pelo menos um. Se nenhum estiver registrado, nada muda e não há custo assíncrono.

Dois comportamentos para planejar. Validadores assíncronos só rodam na inicialização: o pipeline assíncrono pende de `IAsyncStartupValidator`, não de `IOptionsFactory`, então um acesso preguiçoso posterior a `.Value` nunca os dispara. E o estágio 2 só roda se o estágio 1 tiver passado, o que é deliberado. Não faz sentido gastar cinco segundos em sondagens de rede quando a URL do endpoint já falhou no atributo `[Url]`.

O trabalho correspondente no DataAnnotations chegou junto: `AsyncValidationAttribute` com um `IsValidAsync` sobrescrevível, `IAsyncValidatableObject` no modelo, e `Validator.ValidateObjectAsync` / `TryValidateObjectAsync` / `ValidatePropertyAsync` / `ValidateValueAsync`. Use esses se quiser a regra expressa como atributo na propriedade em vez de como classe separada.

## Pule o validador escrito à mão com [OptionsValidator]

Se todas as suas regras são atributos do DataAnnotations, não escreva o método `Validate`. O gerador de código-fonte de validação de opções escreve uma implementação de `IValidateOptions<T>` para você em tempo de compilação:

```csharp
// .NET 8 and later
using Microsoft.Extensions.Options;

[OptionsValidator]
public sealed partial class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
}
```

Uma classe parcial vazia mais o atributo, e o gerador emite um `Validate(string?, PaymentOptions)` que chama `Validator.TryValidateValue` por propriedade com instâncias estáticas de atributos pré-alocadas, coletando em um `ValidateOptionsResultBuilder`. Sem reflexão sobre o tipo de opções em runtime, e é por isso que esse é o formato certo para Native AOT. O gerador está ativo por padrão sempre que o projeto referencia `Microsoft.Extensions.Options` 8.0 ou posterior, e `ValidateDataAnnotations()` se torna redundante assim que você o usa. Ele também substitui `RangeAttribute`, `MinLengthAttribute`, `MaxLengthAttribute` e `LengthAttribute` por equivalentes sem reflexão no código gerado. Se quiser mais contexto sobre o que um gerador faz com seu build, veja o passo a passo sobre [o que é um gerador de código-fonte e quando você precisa de um](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/), e as notas sobre [código seguro para trimming](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) para entender por que validar sem reflexão importa.

Por padrão a validação do DataAnnotations não é recursiva. Um objeto de opções aninhado ou uma `List<T>` de subopções não é validado a menos que você diga, com `[ValidateObjectMembers]` e `[ValidateEnumeratedItems]` respectivamente. Ambos funcionam com o gerador.

## Onde ValidateOnStart silenciosamente não faz nada

O modo de falha que ninguém pega em revisão é `ValidateOnStart` estar registrado mas nunca rodar. Três casos:

**Você nunca inicia o host.** Um teste ou ferramenta que chama `builder.Build()` e resolve serviços de `host.Services` sem `StartAsync` pula a validação inteira. Se quiser uma checagem em um teste de integração, resolva as opções explicitamente com `GetRequiredService<IOptions<T>>().Value` dentro de um `try`, ou chame diretamente `host.Services.GetService<IStartupValidator>()?.Validate()`.

**O host não é o do `Microsoft.Extensions.Hosting`.** O ponto de chamada citado acima mora em `Host.StartAsync`. Runtimes que constroem o próprio host, o mais famoso sendo o modelo in-process do Azure Functions, nunca chegam lá, que é exatamente o [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034). O modelo de worker isolado é um host genérico normal e funciona. Em qualquer coisa incomum, verifique com uma seção quebrada de propósito em vez de supor.

**Você registrou o validador mas não o builder.** `services.Configure<T>(section)` mais um registro de validador dá apenas validação preguiçosa. `Configure<T>` não cria um `OptionsBuilder<T>`, então não há nada em que encadear `ValidateOnStart`. Você precisa de `AddOptions<T>().Bind(section)` ou `AddOptionsWithValidateOnStart<T>().Bind(section)`.

Mais um que não é silencioso mas é fácil de ler errado: validadores rodam por instância nomeada. Se você tem três `PaymentOptions` nomeadas e só chama `AddOptions<PaymentOptions>("primary").ValidateOnStart()`, as outras duas são validadas de forma preguiçosa. Cada nome precisa da própria cadeia. Quando você monta várias variantes da mesma classe de configuração, isso combina naturalmente com [serviços com chave na DI do .NET 11](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) para os consumidores.

## O que fazer com a exceção

`OptionsValidationException` carrega `OptionsType`, `OptionsName` e `Failures` como um `IEnumerable<string>`. Sua `Message` são as falhas unidas por `;`, o que é aceitável no log de um contêiner e ilegível em um terminal. Se o aplicativo é uma CLI ou um serviço voltado a pessoas desenvolvedoras, capturá-la no topo de `Main` e escrever uma falha por linha é uma pequena gentileza:

```csharp
// .NET 11, C# 14
try
{
    await app.RunAsync();
}
catch (OptionsValidationException ex)
{
    Console.Error.WriteLine($"Invalid configuration for {ex.OptionsType.Name}:");
    foreach (string failure in ex.Failures)
    {
        Console.Error.WriteLine($"  - {failure}");
    }
    return 78; // EX_CONFIG
}
```

Envolva isso também em um `catch (AggregateException agg)` se você valida mais de um tipo de opções, já que é assim que `StartupValidator` expõe múltiplas falhas.

Validação na inicialização é o trabalho de confiabilidade mais barato disponível em um aplicativo .NET. É uma chamada de método em um builder que você já tem, e converte uma categoria inteira de incidente de produção, a implantação mal configurada, em uma falha de boot que seu processo de rollout já sabe tratar.

## Relacionados

- [IOptions&lt;T&gt; vs IOptionsSnapshot&lt;T&gt; vs IOptionsMonitor&lt;T&gt; no .NET 11](/pt-br/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) escolhe o acessor certo antes de você validá-lo.
- [Fix: Cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) cobre o erro de dependência cativa que você vai encontrar se um validador receber uma dependência scoped.
- [Fix: No connection string named 'DefaultConnection' could be found](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/) é a falha clássica de configuração preguiçosa que a validação na inicialização evita.
- [O que é um gerador de código-fonte e quando eu preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explica o que `[OptionsValidator]` faz em tempo de compilação.
- [O que é o contrato IHostedService e quando eu uso?](/pt-br/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) mostra o que roda logo depois de a validação passar.

## Fontes

- [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options) no MS Learn, para `ValidateOnStart`, `AddOptionsWithValidateOnStart` e os atributos de validação recursiva.
- [Compile-time options validation source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/options-validation-generator) para `[OptionsValidator]` e a saída gerada.
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries) para a sobrecarga `Validate<TValidator>()` e a validação assíncrona com DataAnnotations.
- [`OptionsBuilderExtensions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) e [`IAsyncValidateOptions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/IAsyncValidateOptions.cs) no dotnet/runtime.
- [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034), `ValidateOnStart()` does not work in Azure Functions.
