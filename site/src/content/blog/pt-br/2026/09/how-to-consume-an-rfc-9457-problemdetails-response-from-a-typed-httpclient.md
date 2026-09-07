---
title: "Como consumir uma resposta ProblemDetails do RFC 9457 a partir de um HttpClient tipado sem referenciar o ASP.NET Core"
description: "A BCL não tem um tipo ProblemDetails, e adicionar um FrameworkReference para Microsoft.AspNetCore.App faz seu cliente se recusar a iniciar em um contêiner que só traz o runtime. Aqui está o modelo de 20 linhas que resolve, o DelegatingHandler que transforma problem+json em uma exceção tipada, e o mito do content-type que quase toda resposta ainda repete."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "httpclient"
  - "system-text-json"
  - "aspnetcore-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient"
translatedBy: "claude"
translationDate: 2026-09-07
---

Resposta curta: não referencie o ASP.NET Core. Declare uma classe com cinco propriedades e um dicionário `[JsonExtensionData]` para os membros de extensão, e desserialize com `HttpContent.ReadFromJsonAsync<T>` de `System.Net.Http.Json`. O tipo de mídia `application/problem+json` é parseado sem problema porque `ReadFromJsonAsync` não verifica tipos de conteúdo desde o .NET 5, e tudo isso funciona em um aplicativo de console, uma biblioteca de classes, Blazor WebAssembly, MAUI e um cliente com Native AOT.

Este artigo cobre por que `Microsoft.AspNetCore.Mvc.ProblemDetails` é o tipo errado para usar no cliente, a falha exata que você recebe se usar mesmo assim, o modelo que faz round-trip de uma resposta de problema real do ASP.NET Core incluindo `errors` e `traceId`, como ligá-lo a um `HttpClient` tipado para que um 4xx vire uma exceção tipada, e o punhado de regras do RFC 9457 que vão te morder se você tratar `status` como confiável.

Uma nota sobre versões. .NET 11 e ASP.NET Core 11 estão em versão prévia em setembro de 2026 e chegam à disponibilidade geral em 2026-11-10, conforme as [notas de versão do .NET 11](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md). Nada nesta área muda no .NET 11, e a proposta de API que resolveria isso de verdade tem como alvo o .NET 12 (mais sobre isso no final). Toda a saída abaixo foi produzida nesta máquina com o SDK do .NET 10.0.302 e os runtimes 10.0.10, contra uma minimal API usando `AddProblemDetails()`.

## Por que o cliente não pode simplesmente usar o tipo do servidor

`ProblemDetails` é uma classe de dados simples com cinco propriedades anuláveis e um dicionário. Não tem comportamento nem dependências de servidor. Ainda assim, ela vive em `Microsoft.AspNetCore.Http.Abstractions.dll`, que é distribuída apenas como parte do framework compartilhado `Microsoft.AspNetCore.App`, então a única forma suportada de alcançá-la é uma referência de framework:

```xml
<!-- Contracts.csproj, .NET 10 / .NET 11 -->
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

Isso compila. E também se propaga. Adicione essa biblioteca de classes a um aplicativo de console comum e veja o que o SDK escreve em `Cli.runtimeconfig.json`:

```json
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}
```

O aplicativo de console agora exige de forma rígida o framework compartilhado do ASP.NET Core na inicialização. Em uma máquina que o tem, tudo parece bem, que é exatamente por que isso chega a produção. Execute o mesmo binário contra uma instalação do .NET que só traz o runtime, que é o que `mcr.microsoft.com/dotnet/runtime:10.0` te dá, e o host recusa antes que uma única linha do seu código execute:

```
You must install or update .NET to run this application.

App: /app/Cli.dll
Architecture: arm64
Framework: 'Microsoft.AspNetCore.App', version '10.0.0' (arm64)

No frameworks were found.
```

Eu produzi isso copiando apenas `shared/Microsoft.NETCore.App` para um `DOTNET_ROOT` temporário e iniciando o aplicativo lá. É a mensagem idêntica que você recebe da imagem base errada, e a correção que as pessoas normalmente aplicam é trocar para a imagem `aspnet`, que adiciona cerca de 20 MB de framework de servidor a um cliente que nunca vai abrir um socket em modo de escuta. Se você está dimensionando imagens, os trade-offs estão em [Dependente de framework vs autocontido vs Native AOT para uma imagem de contêiner do .NET 11](/pt-br/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).

Os outros alvos falham mais cedo e com mais força. `FrameworkReference` para `Microsoft.AspNetCore.App` não está disponível para uma biblioteca `netstandard2.0` de jeito nenhum, e um cliente Blazor WebAssembly ou MAUI não tem por que arrastar Kestrel, MVC e metadados de roteamento para o grafo de trimming só para ler cinco strings JSON. A issue do `dotnet/aspnetcore` pedindo a realocação do tipo, [#58551 "Move ProblemDetails outside of Asp.Net Core"](https://github.com/dotnet/aspnetcore/issues/58551), está parada no backlog sem responsável desde que foi aberta.

## O modelo, em quatro passos

1. **Declare os cinco membros do RFC 9457 como propriedades anuláveis.** Cada membro na [seção 3.1 do RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457#section-3.1) é opcional. `status` é um número JSON, então é `int?`; os outros quatro são strings.
2. **Adicione um dicionário `[JsonExtensionData]`.** A seção 3.2 do RFC 9457 permite que um tipo de problema adicione membros no mesmo namespace plano dos membros padrão, e o ASP.NET Core escreve seu dicionário `Extensions` exatamente assim. Sem isso, você perde silenciosamente `errors`, `traceId` e todos os campos específicos do domínio que a API adicionou.
3. **Desserialize com `ReadFromJsonAsync<T>` sobre o `HttpContent`,** não com `GetFromJsonAsync`. Os helpers no nível do `HttpClient` chamam `EnsureSuccessStatusCode` por você, que é o oposto do que você quer aqui.
4. **Verifique o tipo de mídia você mesmo,** porque nada mais vai verificar.

O tipo é curto o bastante para colar em qualquer projeto cliente:

```csharp
// .NET 10 / .NET 11, C# 14. Only needs System.Net.Http.Json + System.Text.Json.
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ProblemDetails
{
    public string? Type { get; set; }
    public string? Title { get; set; }
    public int? Status { get; set; }
    public string? Detail { get; set; }
    public string? Instance { get; set; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Extensions { get; set; }
}
```

Nenhum atributo `[JsonPropertyName]` é necessário. `ReadFromJsonAsync` usa por padrão `JsonSerializerOptions.Web`, que define `PropertyNamingPolicy` como camelCase e `PropertyNameCaseInsensitive` como `true`, então `title` liga a `Title` sozinho. Contra uma resposta real do ASP.NET Core, o modelo captura tudo:

```
type=https://example.com/probs/insufficient-funds
title=Insufficient funds
status=402
detail=Account 12345 has a balance of 4.20 EUR.
instance=/accounts/12345/withdraw
extensions: balance=4.20, accounts=["/account/12345","/account/67890"], traceId=00-5bf0...-00
```

Esse `traceId` não é algo que o endpoint definiu. O `DefaultProblemDetailsWriter` do ASP.NET Core o adiciona a partir de `Activity.Current?.Id`, com fallback para `HttpContext.TraceIdentifier`, em toda resposta de problema escrita através de `AddProblemDetails()`. É o campo mais útil do payload quando você está correlacionando uma falha do lado do cliente com um log do servidor, e ele só sobrevive se você manteve o dicionário de extensões.

## Erros de validação são um membro de extensão, não uma propriedade

Uma falha de validação do ASP.NET Core aparece assim na rede:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The Sku field is required."],
    "Quantity": ["The field Quantity must be between 1 and 100."]
  },
  "traceId": "00-8246...-00"
}
```

`errors` é um irmão de nível superior de `title`, então ele cai em `Extensions` com um `ValueKind` igual a `Object`. Lê-lo de volta é um helper pequeno, e ele precisa ser defensivo: a seção 3.1 do RFC 9457 diz que um membro cujo tipo de valor não corresponde ao esperado DEVE ser ignorado, e o próprio exemplo do RFC na seção 3 usa um **array** `errors` de objetos `{detail, pointer}` em vez do mapa por membro do ASP.NET Core. Se você chamar uma API que não é .NET, vai encontrar o outro formato.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections.ObjectModel;

public IReadOnlyDictionary<string, string[]> GetValidationErrors()
{
    if (Extensions is null ||
        !Extensions.TryGetValue("errors", out var errors) ||
        errors.ValueKind is not JsonValueKind.Object)
    {
        return ReadOnlyDictionary<string, string[]>.Empty;
    }

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var member in errors.EnumerateObject())
    {
        if (member.Value.ValueKind is not JsonValueKind.Array) continue;
        result[member.Name] = member.Value.EnumerateArray()
            .Where(e => e.ValueKind is JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToArray();
    }
    return result;
}
```

Saída verificada contra o payload acima:

```
Sku: The Sku field is required.
Quantity: The field Quantity must be between 1 and 100.
```

Todo ramo que desiste retorna um dicionário vazio em vez de lançar, que é o comportamento que a seção 3.2 pede aos consumidores: ignore as extensões que você não reconhece. Se você também é dono do servidor, o formato do que ele emite está sob seu controle através de [IProblemDetailsService e as respostas de validação de minimal APIs](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## A verificação de content-type que não existe mais

Metade das respostas sobre este assunto avisa que `ReadFromJsonAsync` lança `NotSupportedException: The provided ContentType is not supported` a menos que a resposta seja `application/json`. Isso era verdade na versão prévia do `System.Net.Http.Json` para .NET Core 3.1 e está errado desde o .NET 5: [dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594) removeu a validação por completo para resolver a [#38713](https://github.com/dotnet/runtime/issues/38713), e não existe nenhum `ValidateContent` no código-fonte atual de `HttpContentJsonExtensions`.

Medido no 10.0.10, em uma matriz de tipos de conteúdo com o mesmo corpo problem+json:

| Content-Type | Corpo | Resultado |
| --- | --- | --- |
| `application/problem+json` | JSON de problema | parseado |
| `application/problem+json; charset=utf-8` | JSON de problema | parseado |
| `text/html` | JSON de problema | **parseado** |
| `text/plain` | JSON de problema | parseado |
| (nenhum) | JSON de problema | parseado |
| `text/html` | `<html/>` | `JsonException: '<' is an invalid start of a value` |
| `application/problem+json` | vazio | `JsonException: The input does not contain any JSON tokens` |
| `application/problem+json` | `null` | retorna `null` |

Duas coisas decorrem disso. Primeiro, você não precisa de contorno nenhum para ler `application/problem+json`, e nunca precisou no .NET 5 ou posterior. Segundo, a rede de segurança que você supunha existir não existe: se um gateway devolver uma página HTML de erro 502, `ReadFromJsonAsync` vai tentar parseá-la alegremente e te entregar uma `JsonException` em vez de um sinal limpo de "isto não é um documento de problema". É por isso que o passo 4 acima diz para verificar o tipo de mídia você mesmo, e por isso a verificação pertence a `Content.Headers.ContentType?.MediaType` e não ao cabeçalho cru, que carrega o parâmetro `charset`.

Já que estamos aqui: `JsonSerializerOptions.Web` também define `NumberHandling` como `AllowReadingFromString`, então um servidor que escreve `"status": "402"` como string ainda liga a `int?`. Essa joga a seu favor.

## Transformando um 4xx em uma exceção tipada

O lugar natural para isso é um `DelegatingHandler` sobre um cliente tipado, para que cada ponto de chamada receba o comportamento sem um `if` por método. A exceção deriva de `HttpRequestException` para que blocos `catch` existentes e políticas de retentativa continuem funcionando:

```csharp
// .NET 10 / .NET 11, C# 14
public sealed class ProblemDetailsException(ProblemDetails problem, HttpStatusCode status)
    : HttpRequestException(
        problem.Detail ?? problem.Title ?? "The server returned a problem response.",
        inner: null,
        statusCode: status)
{
    public ProblemDetails ProblemDetails { get; } = problem;
}

public sealed class ProblemDetailsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = await base.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
            return response;

        var json = await response.Content.ReadAsStringAsync(ct);
        var problem = JsonSerializer.Deserialize<ProblemDetails>(json, JsonSerializerOptions.Web);
        if (problem is null) return response;

        throw new ProblemDetailsException(problem, response.StatusCode);
    }
}
```

O registro é `IHttpClientFactory` comum:

```csharp
services.AddTransient<ProblemDetailsHandler>();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://api.example.com"))
        .AddHttpMessageHandler<ProblemDetailsHandler>();
```

E o ponto de chamada recebe o payload inteiro, em um 404 que antes era um código de status pelado:

```
ProblemDetailsException: No order with id abc.
  StatusCode=NotFound  type=https://api.example.com/probs/order-not-found
  orderId extension = abc
  is HttpRequestException: True
```

Repare no `ReadAsStringAsync` dentro do handler em vez de `ReadFromJsonAsync`. Isso não é questão de estilo. No 10.0.10, chamar `ReadFromJsonAsync` sobre um `HttpContent` descarta o stream em buffer, então uma segunda chamada sobre a mesma resposta lança `ObjectDisposedException: Cannot access a closed Stream`. Em um handler que às vezes retorna a resposta em vez de lançar, isso significa que você destruiu o corpo para quem chamou. `ReadAsStringAsync` é repetível, e `ReadAsStringAsync` seguido de `ReadFromJsonAsync` também funciona; só `ReadFromJsonAsync` duas vezes falha. Se você usa `HttpCompletionOption.ResponseHeadersRead` em algum ponto da cadeia, chame `LoadIntoBufferAsync()` antes de espiar o corpo.

Testar o handler é o exercício padrão do `HttpMessageHandler` falso coberto em [Como fazer testes unitários de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/). Se você ainda está decidindo o formato do cliente em si, [HttpClient vs HttpClientFactory vs Refit](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/) cobre onde um handler como este se encaixa em cada opção.

## Quatro regras do RFC que vão te morder

**`status` é apenas indicativo.** A seção 3.1.2 é explícita: "The 'status' member, if present, is only advisory". Ele também é opcional. Um servidor atrás de um proxy que reescreve o status deixa você com um corpo alegando 409 em uma resposta HTTP 502. Sempre ramifique por `response.StatusCode`, e trate `ProblemDetails.Status` como um campo de diagnóstico que você registra em log, não um sobre o qual você faz switch.

**Ramifique por `type`, não por `title` nem pelo status.** `type` é o identificador estável; `title` tem permissão explícita para ser localizado, e a seção 3.1 diz que ele "SHOULD NOT change from occurrence to occurrence" apenas para um dado tipo. Quando `type` está ausente, a seção 3.1.1 diz que se assume o valor `about:blank`, o que, pela seção 4.2.1, significa "nenhuma informação além do código de status" e implica que `title` é apenas a frase do status. Normalize um `type` ausente ou vazio para `about:blank` antes de comparar.

**`type` e `instance` são *referências* URI, então podem ser relativos.** O RFC permite e alerta que "using relative URIs can cause confusion, and they might not be handled correctly by all implementations". Se você compara `type` com uma constante, resolva primeiro: `new Uri(response.RequestMessage!.RequestUri!, pd.Type ?? "about:blank")`.

**Não desreferencie `type`, e não mostre `detail` para usuários finais.** A seção 5 diz aos consumidores que eles "SHOULD NOT automatically dereference the type URI" fora de ferramentas para desenvolvedores, e o sentido inteiro de `detail` é ser texto do servidor específico daquela ocorrência, que frequentemente vaza detalhes internos. Registre em log, correlacione pelo `traceId` e renderize sua própria mensagem.

Duas menores. Cabeçalhos continuam importando: um documento de problema com 429 não carrega o atraso de retentativa no corpo, ele carrega em `Retry-After`, então leia o cabeçalho. E uma resposta de problema não é garantida para toda falha. Na minha matriz, um 429 voltou sem tipo de conteúdo e com um corpo de comprimento zero, que é exatamente o caso que a verificação de tipo de mídia do handler acima deixa passar intacto.

## Native AOT e trimming

O modelo funciona com o gerador de código-fonte do `System.Text.Json`, `[JsonExtensionData]` incluso, desde que o dicionário seja um de `IDictionary<string, JsonElement>`, `IDictionary<string, object>`, `IDictionary<string, JsonNode>` ou `JsonNode`. Qualquer outra coisa é `SYSLIB1036` em tempo de compilação.

```csharp
// .NET 10 / .NET 11, C# 14
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
public partial class ProblemJsonContext : JsonSerializerContext;

// ...
var problem = await response.Content.ReadFromJsonAsync(ProblemJsonContext.Default.ProblemDetails, ct);
```

Verificado no 10.0.10: o caminho gerado por código-fonte parseia o mesmo payload e preserva `4.20` como um decimal exato no dicionário de extensões, porque `JsonElement` mantém o texto cru. Lê-lo com `GetDecimal()` te dá `4.20`, não um artefato de ponto flutuante. Isso importa para campos monetários, e é mais uma razão para manter as extensões como `JsonElement` em vez de `object`. Se você precisa remodelar o que o gerador emite, [um modificador de type info resolver](/pt-br/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/) é o ponto de extensão.

## O que o .NET 12 pode mudar

Existe uma proposta de API aberta, [dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046), para colocar tudo isso na BCL: um modelo `ProblemDetails` em `System.Net.Http.Json`, `HttpResponseMessage.IsProblemJson()`, `ReadProblemJsonAsync()`, `ThrowIfProblemJsonAsync()` e uma `ProblemDetailsException` derivando de `HttpRequestException`. O raciocínio da proposta é o mesmo com que este artigo abre: referenciar o framework de servidor "pulls ASP.NET Core into console apps, MAUI apps, Blazor WASM clients, and class libraries that have no business depending on a server framework". Ela está marcada como `api-suggestion` no marco 12.0.0, o que significa que não está no .NET 11 e também não está garantida para o .NET 12.

Até isso chegar, as vinte linhas acima são a resposta completa, e são compatíveis com o futuro: o tipo proposto para a BCL tem as mesmas cinco propriedades e um dicionário de extensões, então trocar para ele depois é uma mudança de namespace e uma exclusão.

## Relacionados

- [Como personalizar respostas de erro de validação de minimal APIs com IProblemDetailsService no ASP.NET Core 11](/pt-br/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [HttpClient vs HttpClientFactory vs Refit: qual usar no .NET 11?](/pt-br/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Como fazer testes unitários de código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Como personalizar a serialização do System.Text.Json gerada por código-fonte com um modificador de type info resolver](/pt-br/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)
- [Dependente de framework vs autocontido vs Native AOT para uma imagem de contêiner do .NET 11](/pt-br/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)

## Fontes

- [RFC 9457, Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [Proposta de API: suporte a Problem Details (RFC 9457) em System.Net.Http.Json, dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046)
- [Move ProblemDetails outside of Asp.Net Core, dotnet/aspnetcore#58551](https://github.com/dotnet/aspnetcore/issues/58551)
- [Remover a verificação de tipo de conteúdo de ReadFromJsonAsync, dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594)
- [Referência da classe ProblemDetails no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.problemdetails)
- [Código-fonte de DefaultProblemDetailsWriter em dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Extensions/src/DefaultProblemDetailsWriter.cs)
- [SYSLIB1036: requisitos de tipo para JsonExtensionData](https://learn.microsoft.com/en-US/dotnet/fundamentals/syslib-diagnostics/syslib1036)
