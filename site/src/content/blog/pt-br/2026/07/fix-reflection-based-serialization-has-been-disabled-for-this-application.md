---
title: "Correção: Reflection-based serialization has been disabled for this application"
description: "Essa InvalidOperationException significa que PublishTrimmed ou PublishAot mudaram JsonSerializerIsReflectionEnabledByDefault para false. Corrija com um JsonSerializerContext gerado."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "trimming"
  - "native-aot"
lang: "pt-br"
translationOf: "2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application"
translatedBy: "claude"
translationDate: 2026-07-29
---

Seu projeto tem `PublishTrimmed` ou `PublishAot` definido como `true`, e o SDK do .NET respondeu definindo `JsonSerializerIsReflectionEnabledByDefault` como `false`. Isso desliga o resolvedor de contratos baseado em reflexão do qual `JsonSerializer.Serialize(obj)` depende silenciosamente. A correção é dar ao serializador uma fonte de contratos: adicione uma `partial class` que deriva de `JsonSerializerContext`, anote-a com `[JsonSerializable(typeof(YourType))]` e passe `MyContext.Default.YourType` (ou defina `options.TypeInfoResolver = MyContext.Default`) em cada ponto de chamada.

```text
System.InvalidOperationException: Reflection-based serialization has been disabled for this application. Either use the source generator APIs or explicitly configure the 'JsonSerializerOptions.TypeInfoResolver' property.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_JsonSerializerIsReflectionDisabled()
   at System.Text.Json.JsonSerializerOptions.ConfigureForJsonSerializer()
   at System.Text.Json.JsonSerializerOptions.GetTypeInfoForRootType(Type type, Boolean fallBackToNearestAncestorType)
   at System.Text.Json.JsonSerializer.Serialize[TValue](TValue value, JsonSerializerOptions options)
   at MyApp.Program.Main(String[] args)
```

O texto exato vem do recurso `JsonSerializerIsReflectionDisabled` do `System.Text.Json`, e está escrito da mesma forma desde o .NET 8. Tudo abaixo tem como alvo o SDK do .NET 11 (`11.0.100`) e C# 14, mas o comportamento é idêntico no `net8.0` e posteriores, porque foi aí que a chave foi introduzida.

## Por que um projeto que você nunca configurou está com a reflexão desligada

O `System.Text.Json` resolve o formato de um tipo de duas maneiras: em tempo de execução com reflexão (`DefaultJsonTypeInfoResolver`), ou em tempo de compilação com o gerador de código-fonte (`JsonSerializerContext`). Quando você chama `JsonSerializer.Serialize(obj)` sem opções, ele recorre ao resolvedor por reflexão.

Reflexão não sobrevive ao trimming. O trimmer remove os membros cuja acessibilidade ele não consegue provar, e getters de propriedade que só são invocados através de `PropertyInfo` são exatamente isso: inacessíveis à análise estática. Antes do .NET 8, um app com trimming serializava tranquilamente e apenas descartava em silêncio as propriedades que o trimmer havia apagado. Perda silenciosa de dados é pior do que uma falha, então o .NET 8 mudou o padrão: definir `PublishTrimmed` como `true` [define automaticamente `JsonSerializerIsReflectionEnabledByDefault` como `false`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed), a menos que você diga o contrário. `PublishAot` implica `PublishTrimmed`, então apps Native AOT herdam o mesmo padrão.

A propriedade do MSBuild não é o mecanismo, apenas a chave. O SDK a transforma em uma opção de configuração do host de runtime:

```xml
<!-- Microsoft.NET.Sdk.targets, .NET 11 SDK -->
<RuntimeHostConfigurationOption Include="System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"
                                Condition="'$(JsonSerializerIsReflectionEnabledByDefault)' != ''"
                                Value="$(JsonSerializerIsReflectionEnabledByDefault)"
                                Trim="true" />
```

Isso vai parar no seu `.runtimeconfig.json` como uma chave de `AppContext`, e `Trim="true"` diz ao ILLink para tratá-la como uma constante de tempo de link, de modo que os caminhos de código com reflexão possam ser removidos por completo. `JsonSerializer.IsReflectionEnabledByDefault` lê essa chave e [assume `true` por padrão quando ela não está definida](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault).

Duas coisas decorrem disso e explicam a maioria dos relatos de bug confusos. Primeiro, a chave é por app, não por biblioteca: um pacote NuGet não pode desligá-la para você, e você não pode ligá-la para um único assembly. Segundo, a exceção acontece no primeiro uso, não na inicialização. `JsonSerializerOptions.Default` é construído com `JsonTypeInfoResolver.Empty` em vez do resolvedor por reflexão, e `ConfigureForJsonSerializer` só lança a exceção quando uma chamada de serialização ou desserialização encontra um resolvedor vazio. Então o caminho de código que roda uma vez por semana é onde você vai descobrir.

## A reprodução mínima

Três linhas de arquivo de projeto e uma linha de C#:

```xml
<!-- MyApp.csproj, .NET 11 SDK 11.0.100 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var json = JsonSerializer.Serialize(new { Value = 42 });
// System.InvalidOperationException: Reflection-based serialization has been disabled...
```

Repare onde `PublishTrimmed` fica. Como a propriedade flui para o `runtimeconfig.json` em tempo de **build**, colocá-la no arquivo de projeto faz com que `dotnet run` em Debug também lance a exceção. Se, em vez disso, você só a passar na linha de comando de publicação (`dotnet publish -p:PublishTrimmed=true`), seu `dotnet run` local continua funcionando e apenas o artefato publicado falha, que é a versão desse bug que chega à produção. A documentação de trimming recomenda o arquivo de projeto [justamente para que a configuração se aplique durante o `dotnet build`](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options).

Para confirmar que você está diante disso e não de outra coisa, verifique a saída do build:

```bash
cat bin/Debug/net11.0/MyApp.runtimeconfig.json
```

```json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false
    }
  }
}
```

Ou verifique pelo código, o que também funciona com Native AOT, onde não há arquivo runtimeconfig para ler:

```csharp
// .NET 11, C# 14
Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault); // False
```

## Correção 1: entregue um JsonSerializerContext e use-o em todo lugar

Esta é a correção que a mensagem de erro está pedindo e a única que deixa você com um app genuinamente seguro para trimming. Declare um contexto parcial, liste cada tipo raiz que você serializa e roteie as chamadas através dele.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0
using System.Text.Json;
using System.Text.Json.Serialization;

public record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WeatherForecast))]
[JsonSerializable(typeof(List<WeatherForecast>))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Depois escolha uma das três formas de chamada suportadas:

```csharp
// .NET 11, C# 14
// 1. Strongly typed, zero options plumbing. Preferred.
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);
WeatherForecast? back = JsonSerializer.Deserialize(json, AppJsonContext.Default.WeatherForecast);

// 2. Through options, when an API forces you to hand it a JsonSerializerOptions.
var options = new JsonSerializerOptions { TypeInfoResolver = AppJsonContext.Default };
json = JsonSerializer.Serialize(forecast, options);

// 3. Non-generic, when the type is only known at runtime.
json = JsonSerializer.Serialize(forecast, typeof(WeatherForecast), AppJsonContext.Default);
```

Defina suas opções em `[JsonSourceGenerationOptions]` em vez de em uma instância de `JsonSerializerOptions` sempre que possível. Assim a propriedade `Default` gerada já sai pré-configurada em tempo de compilação, e você não consegue esquecer de aplicar a política de nomenclatura em um de seis pontos de chamada. Coleções precisam da própria entrada `[JsonSerializable]` (`List<WeatherForecast>` acima), e membros declarados como `object` precisam que você registre cada tipo possível em tempo de execução, porque o gerador não tem mais nada em que se basear.

## Correção 2: conecte o contexto ao ASP.NET Core, ao HttpClient e ao Blazor

A maioria dos apps não chama `JsonSerializer` diretamente. Eles entregam um tipo a um método do framework que faz a chamada por eles, e esses precisam do resolvedor instalado uma única vez na inicialização.

Para minimal APIs, incluindo o template de Native AOT que usa `CreateSlimBuilder`:

```csharp
// .NET 11, ASP.NET Core 11
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});
```

Para controllers de MVC e Web API:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(static options =>
    options.JsonSerializerOptions.TypeInfoResolverChain.Add(AppJsonContext.Default));
```

Para o `HttpClient`, use as sobrecargas que recebem um `JsonTypeInfo<T>` em vez das que o inferem:

```csharp
// .NET 11, C# 14
var forecast = await client.GetFromJsonAsync("/weather", AppJsonContext.Default.WeatherForecast);
await client.PostAsJsonAsync("/weather", forecast, AppJsonContext.Default.WeatherForecast);
```

`TypeInfoResolverChain` vale a pena conhecer por si só: as opções consultam cada resolvedor em ordem e pegam o primeiro resultado não nulo, então você pode compor vários contextos de projetos diferentes com `JsonTypeInfoResolver.Combine(ContextA.Default, ContextB.Default)` ou inserir um à frente do próprio framework.

## Correção 3: reative a reflexão no ponto de chamada, sem mexer no MSBuild

A mensagem de erro oferece uma segunda saída: "explicitly configure the `JsonSerializerOptions.TypeInfoResolver` property". O resolvedor por reflexão continua sendo um tipo público, e construí-lo não verifica a chave:

```csharp
// .NET 11, C# 14. Works in a trimmed app. Does NOT work under Native AOT.
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};
string json = JsonSerializer.Serialize(new { Value = 42 }, options);
```

Entenda o que você está comprando. A exceção some porque você pediu reflexão pelo nome, mas o trimmer já apagou os membros que considerou sem uso. Você fica com uma serialização que roda e emite silenciosamente um objeto incompleto, que é exatamente o modo de falha que a mudança do .NET 8 existia para evitar. Sob Native AOT é pior: `DefaultJsonTypeInfoResolver` é anotado com `[RequiresDynamicCode]`, então você troca `InvalidOperationException` por um `PlatformNotSupportedException` ou uma falha de metadados ausentes em tempo de execução. Trate isso como um passo de diagnóstico (meu payload sobrevive ao trimming?) e não como uma correção.

O padrão que é de fato útil é o resolvedor condicional, que a documentação recomenda para bibliotecas que precisam funcionar nos dois mundos:

```csharp
// .NET 11, C# 14
static JsonSerializerOptions CreateDefaultOptions() => new()
{
    TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
        ? new DefaultJsonTypeInfoResolver()
        : AppJsonContext.Default
};
```

Como `IsReflectionEnabledByDefault` é substituída por uma constante de tempo de link, o ILLink dobra o ramo e nunca enraíza o resolvedor por reflexão em um build AOT.

## Correção 4: ligue a chave de volta, e quando isso se justifica

Você pode restaurar o comportamento do .NET 7 com uma única propriedade:

```xml
<!-- MyApp.csproj, .NET 11 SDK -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Faça isso quando uma dependência de terceiros chama `JsonSerializer.Serialize` sobre os próprios tipos dela, no fundo do próprio código dela, e não entrega nenhum `JsonSerializerContext`. Você não consegue reescrever os pontos de chamada dela, e um gerador de código-fonte no seu assembly não ajuda, porque o resolvedor precisa estar anexado à instância de opções que a biblioteca cria. Vários pacotes bastante usados esbarraram nisso: gerou relatos de bug contra o provedor do Azure App Configuration e contra o endpoint do Swagger UI do ASP.NET Core, entre outros.

Duas ressalvas. Primeiro, isso reintroduz a perda silenciosa de dados: o resolvedor por reflexão vai rodar, mas apenas sobre os membros que sobreviveram ao trimming, então teste o artefato publicado de verdade contra payloads reais em vez de confiar em um `dotnet run` que passa. Segundo, se você está em Native AOT, virar essa propriedade não faz a reflexão funcionar; só remove a proteção que estava te contando a verdade cedo.

## Armadilhas que levam à correção errada

**O próximo erro é `NoMetadataForType`.** Depois de adicionar um contexto, um tipo que você esqueceu de anotar lança `JsonTypeInfo metadata for type 'X' was not provided by TypeInfoResolver of type 'Y'`. Isso é progresso, não uma regressão: ele nomeia o tipo que falta. Adicione um `[JsonSerializable(typeof(X))]` para ele, incluindo os tipos de coleção e cada subtipo que você serializa de forma polimórfica. Se você usa `[JsonDerivedType]`, cada tipo derivado precisa da própria entrada, algo que o guia de [serialização polimórfica com `JsonDerivedType`](/pt-br/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) cobre em detalhe.

**Não há aviso em tempo de compilação.** O pedido óbvio, um analisador que sinalize `JsonSerializer.Serialize(x)` quando a chave está desligada, foi registrado como [dotnet/runtime#107440](https://github.com/dotnet/runtime/issues/107440) e fechado como não planejado. Os avisos de análise de trimming (`IL2026`, `IL3050`) vão apontar para a serialização por reflexão no seu próprio código, então trate um build limpo de análise de trimming como o mais próximo de uma verificação em tempo de compilação. Chegar lá é o assunto de [escrever código seguro para trimming](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**No .NET MAUI isso só reproduz em Release, ou só no dispositivo.** O MAUI define as propriedades de trimming por você: Android e Mac Catalyst usam trimming parcial em builds Release, e o iOS usa em qualquer build para dispositivo independentemente da configuração, enquanto builds para simulador não passam por trimming nenhum. Então "funciona no simulador, falha em um iPhone de verdade" e "funciona em Debug, falha em Release" são o mesmo bug. Não defina `PublishTrimmed` você mesmo em um projeto MAUI; o SDK é dono dela.

**Um `PlatformNotSupportedException` é um erro diferente.** Se o seu stack trace menciona `Reflection.Emit` ou compilação de árvores de expressão em vez de `ConfigureForJsonSerializer`, você está diante da ausência do JIT no AOT, não da chave do JSON. Esse caso é coberto no artigo sobre [`PlatformNotSupportedException` no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/).

**O `JsonStringEnumConverter` não genérico não tem suporte em AOT.** Assim que você estiver com geração de código-fonte, troque-o por `JsonStringEnumConverter<TEnum>` no enum, ou defina `UseStringEnumConverter = true` em `[JsonSourceGenerationOptions]`. A mesma restrição vale para conversores escritos à mão, algo que vale conferir contra as regras para [escrever um `JsonConverter` personalizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

**Ligar isso de propósito é uma escolha válida.** Se você quer esse erro em um app sem trimming para que as incompatibilidades com AOT apareçam no CoreCLR durante o desenvolvimento, defina `JsonSerializerIsReflectionEnabledByDefault` como `false` você mesmo. O comportamento dela é consistente entre CoreCLR e Native AOT, que é exatamente o que faz dela um bom sistema de alerta antecipado. Esse uso isolado da propriedade é coberto na nota mais antiga sobre [desativar a serialização baseada em reflexão](/pt-br/2023/10/system-text-json-disable-reflection-based-serialization/).

## Relacionados

- [O que é código seguro para trimming e como escrevê-lo?](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [O que é Native AOT e quanto ele custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Correção: PlatformNotSupportedException no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [Como serializar uma hierarquia de tipos polimórfica com JsonDerivedType](/pt-br/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Fontes

- [Breaking change: PublishTrimmed projects fail reflection-based serialization](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) - MS Learn
- [How to use source generation in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation), incluindo a seção "Disable reflection defaults" - MS Learn
- [Propriedade JsonSerializer.IsReflectionEnabledByDefault](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault) - MS Learn
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options) - MS Learn
- [Trim a .NET MAUI app](https://learn.microsoft.com/en-us/dotnet/maui/deployment/trimming), pelos padrões de trimming por plataforma - MS Learn
- [System.Text.Json analyzers should warn about using reflection when reflection is disabled](https://github.com/dotnet/runtime/issues/107440) - dotnet/runtime
- [`JsonSerializerOptions.ConfigureForJsonSerializer`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/JsonSerializerOptions.cs) e o recurso de texto `JsonSerializerIsReflectionDisabled` - dotnet/runtime
