---
title: "Correção: [FromForm] Dictionary<string, string> é sempre null em uma minimal API"
description: "Um Dictionary com [FromForm] em uma minimal API faz binding com prefixo vazio: as chaves do formulário precisam ser [key], não metadata[key]. Envolva em uma classe para manter nomes legíveis."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "pt-br"
translationOf: "2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-08-20
---

Um parâmetro `[FromForm] Dictionary<string, string>` em uma minimal API não usa o nome do parâmetro como prefixo das chaves do formulário. O mapeador de formulário começa na raiz do formulário, então ele procura por `[author]` e `[env]`, não por `metadata[author]` nem `metadata.author`. Envie chaves entre colchetes sem prefixo ou, melhor ainda, envolva o dicionário em uma classe e envie `Metadata[author]` para que o formato transmitido continue legível. Nada é registrado em log e nenhum `400` é retornado quando as chaves não batem: o parâmetro simplesmente chega como `null`.

Tudo abaixo foi medido no ASP.NET Core 10.0.5 com o SDK 10.0.201. O código de binding relevante é idêntico no branch `release/11.0`, então o comportamento continua no .NET 11.

## O erro em contexto

Não há exceção nenhuma para pesquisar, e é exatamente por isso que esse problema queima uma tarde inteira. O handler executa, o arquivo faz binding e o dicionário é `null`:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/broken", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/broken \
  -F "metadata[author]=marius" -F "metadata[env]=prod" -F "file=@a.txt"
```

```text
metadata=null, file=a.txt
```

O mesmo `null` volta com `metadata.author=marius`, com um simples `author=marius` e com uma requisição que omite as chaves por completo. O código de status é `200` em todos os casos.

Você só vê uma exceção quando as chaves ficam próximas o bastante para o mapeador começar a lê-las. Com um `Dictionary<string, int>` e um valor que não pode ser convertido:

```text
Microsoft.AspNetCore.Http.BadHttpRequestException: The value 'notanint' is not valid for 'b'.
 ---> Microsoft.AspNetCore.Components.Endpoints.FormMapping.FormDataMappingException
   at Microsoft.AspNetCore.Components.Endpoints.FormMapping.DictionaryConverter`5.TryRead(...)
```

Esse stack trace é a pista. O tipo que faz o trabalho fica em `Microsoft.AspNetCore.Components.Endpoints.FormMapping`, a mesma camada de mapeamento de formulário que o Blazor usa, e as convenções de chave dela não são as que o MVC te ensinou.

## Por que isso acontece

O binding de formulário em minimal APIs tem dois caminhos de código completamente separados, e qual deles um parâmetro segue é decidido por um único predicado em `RequestDelegateFactory`:

```csharp
// dotnet/aspnetcore, src/Http/Http.Extensions/src/RequestDelegateFactory.cs, release/10.0
var useSimpleBinding = parameter.ParameterType == typeof(string) ||
    parameter.ParameterType == typeof(StringValues) ||
    parameter.ParameterType == typeof(StringValues?) ||
    ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType) ||
    (parameter.ParameterType.IsArray && ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType.GetElementType()!));
hasTryParse = useSimpleBinding;
return useSimpleBinding
    ? BindParameterFromFormItem(parameter, formAttribute.Name ?? parameter.Name, factoryContext)
    : BindComplexParameterFromFormItem(parameter, string.IsNullOrEmpty(formAttribute.Name) ? parameter.Name : formAttribute.Name, factoryContext);
```

O binding simples lê `HttpContext.Request.Form[key]` onde `key` é o nome do parâmetro. Esse é o comportamento que todo mundo espera, e é o que você obtém para `string`, `int`, `Guid`, `DateOnly` e qualquer outro tipo com um `TryParse`.

`Dictionary<string, string>` não tem `TryParse`, então cai em `BindComplexParameterFromFormItem`, que entrega o formulário inteiro ao mapeador compartilhado:

```csharp
// FormDataMapper.Map<Dictionary<string, string>>(name_reader, FormDataMapperOptions);
var invokeMapMethodExpr = Expression.Call(
    FormDataMapperMapMethod.MakeGenericMethod(parameter.ParameterType),
    formReader,
    Expression.Constant(formDataMapperOptions));
```

Olhe os argumentos: o leitor e as opções. Não há prefixo. A `key` calculada na linha acima só é usada como chave de dicionário em `factoryContext.TrackedParameters`, nunca é empilhada na pilha de prefixos do leitor. Por isso o mapeador lê o dicionário a partir da raiz do formulário, e uma entrada de dicionário na raiz se escreve `[author]`.

É esse o problema inteiro: o parâmetro se chama `metadata`, mas ninguém contou esse nome ao mapeador de formulário.

Isso também explica por que o comportamento parece uma regressão quando você move um endpoint de controllers. O model binder do MVC tenta o nome do parâmetro como prefixo e depois recorre ao prefixo vazio, então uma action de controller aceita as duas grafias:

```csharp
// .NET 10.0.201, controller action, both curl shapes below return the same result
[HttpPost("dict")]
public IActionResult Dict([FromForm] Dictionary<string, string> metadata, IFormFile file)
    => Content($"count={metadata?.Count}");
```

```text
curl -F "metadata[author]=marius" -F "file=@a.txt"   ->  count=1
curl -F "[author]=marius"         -F "file=@a.txt"   ->  count=1
```

As minimal APIs aceitam apenas a segunda. Se você está avaliando os dois modelos de forma mais ampla, [minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) cobre os outros pontos em que a semântica de binding deles diverge.

## Repro mínima

Uma aplicação completa, mais os formatos de requisição que funcionam e os que não funcionam:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();
app.UseAntiforgery();

app.MapPost("/dict", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();

app.MapPost("/list", ([FromForm] List<string> tags, IFormFile file) =>
    Results.Text($"tags={(tags is null ? "null" : JsonSerializer.Serialize(tags))}"))
   .DisableAntiforgery();

app.Run();
```

Resultados medidos contra essa aplicação:

| Requisição | Resultado |
| --- | --- |
| `-F "metadata[author]=marius"` | `metadata=null` |
| `-F "metadata.author=marius"` | `metadata=null` |
| `-F "author=marius"` | `metadata=null` |
| `-F "[author]=marius" -F "[env]=prod"` | `metadata={"author":"marius","env":"prod"}` |
| `-F "tags=a" -F "tags=b"` | `tags=null` |
| `-F "tags[0]=a" -F "tags[1]=b"` | `tags=null` |
| `-F "[0]=a" -F "[1]=b"` | `tags=["a","b"]` |

O padrão é consistente: um parâmetro de coleção `[FromForm]` de nível superior é endereçado com prefixo vazio, então dicionários usam `[key]` e listas usam `[0]`, `[1]`, e assim por diante. O nome do parâmetro é peso morto.

## A correção, em detalhe

Quatro opções, na ordem em que eu recorreria a elas.

### 1. Envolva o dicionário em uma classe

Essa é a correção que vale a pena colocar em produção. Uma propriedade de uma classe recebe prefixo, sim, porque o mapeador empilha o nome da propriedade na pilha de prefixos enquanto desce, então o formato transmitido volta a ser algo que uma pessoa consegue ler e que uma biblioteca cliente consegue gerar.

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadRequest request, IFormFile file) =>
    Results.Text($"request={JsonSerializer.Serialize(request)}, file={file?.FileName}"))
   .DisableAntiforgery();

public class UploadRequest
{
    public Dictionary<string, string> Metadata { get; set; } = new();
}
```

```bash
curl -X POST http://localhost:5222/upload \
  -F "Metadata[author]=marius" -F "Metadata[env]=prod" -F "file=@a.txt"
```

```text
request={"Metadata":{"author":"marius","env":"prod"}}, file=a.txt
```

A comparação de chaves não diferencia maiúsculas de minúsculas, então `metadata[author]` também faz binding na propriedade `Metadata`. O dicionário aninhado pode ficar ainda mais fundo: `Meta.Tags[a]=1` faz binding normalmente se `Meta` for, por sua vez, uma propriedade.

Você pode puxar o arquivo para dentro da mesma classe, o que deixa a assinatura do endpoint com um único parâmetro:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadWithFile request) =>
    Results.Text($"metadata={JsonSerializer.Serialize(request.Metadata)}, file={request.File?.FileName}"))
   .DisableAntiforgery();

public class UploadWithFile
{
    public Dictionary<string, string> Metadata { get; set; } = new();
    public IFormFile? File { get; set; }
}
```

Enviar `-F "Metadata[author]=marius" -F "File=@a.txt"` faz binding nos dois. A propriedade do arquivo é casada pelo nome da propriedade, a mesma regra que vale para um parâmetro `IFormFile` de nível superior.

### 2. Mantenha o parâmetro dicionário e ajuste o cliente

Se o cliente é seu e a assinatura do endpoint está fixa, basta enviar chaves entre colchetes na raiz:

```bash
curl -X POST http://localhost:5222/dict \
  -F "[author]=marius" -F "[env]=prod" -F "file=@a.txt"
```

Funciona, e é um caractere de mudança por chave. Também é o formato que ninguém vai adivinhar ao ler o handler daqui a seis meses, e ele não sobrevive a um segundo parâmetro dicionário (veja as pegadinhas). Trate como paliativo.

### 3. Leia o formulário você mesmo

A opção mais explícita, e a única que sobrevive ao Request Delegate Generator. `IFormCollection` faz binding como parâmetro de formulário inteiro, sem nenhuma camada de mapeamento envolvida, então a convenção de chaves é sua:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", (IFormCollection form) =>
{
    var metadata = form
        .Where(kv => kv.Key.StartsWith("metadata[", StringComparison.Ordinal) && kv.Key.EndsWith(']'))
        .ToDictionary(kv => kv.Key[9..^1], kv => kv.Value.ToString());

    return Results.Text($"metadata={JsonSerializer.Serialize(metadata)}, files={form.Files.Count}");
}).DisableAntiforgery();
```

```text
metadata={"author":"marius","env":"prod"}, files=1
```

É verboso, mas aceita `metadata[author]` diretamente e te dá um caminho de erro real quando uma chave está malformada, em vez de um `null` silencioso.

### 4. Envie os metadados como um único campo JSON

Se os metadados são realmente abertos, pare de modelá-los como chaves de formulário. Um único campo de formulário contendo um documento JSON faz binding pelo caminho simples, porque `string` curto-circuita o predicado acima:

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] string metadata, IFormFile file) =>
{
    var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata);
    return Results.Text($"metadata={JsonSerializer.Serialize(parsed)}, file={file?.FileName}");
}).DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/upload \
  -F 'metadata={"author":"marius","env":"prod"}' -F "file=@a.txt"
```

É a única opção que te dá valores aninhados, arrays e tipos que não sejam string sem brigar com a sintaxe de chaves, e funciona igual sob AOT.

## Pegadinhas e variantes

- **`null` não é uma falha de validação.** O tipo do parâmetro é `Dictionary<string, string>` não anulável e mesmo assim o handler recebe `null`, com resposta `200` e nada nos logs. O mapeador retorna `default(T)` quando não encontra nenhuma chave correspondente, e um parâmetro complexo vinculado a formulário nunca é tratado como obrigatório. Cheque o `null`, ou torne o parâmetro anulável para o compilador te lembrar. Um inicializador de propriedade como `= new()` também não te salva: o próprio objeto invólucro volta como `null` quando nenhuma chave casa com o prefixo dele.

- **`[FromForm(Name = "metadata")]` não define o prefixo.** Parece a correção e não é. O nome é usado para consultar parâmetros rastreados e então descartado antes de o mapeador rodar. `[FromForm(Name = "metadata")] Dictionary<string, string> metadata` continua fazendo binding a partir de `[author]`, não de `metadata[author]`.

- **Dois parâmetros complexos de formulário colidem.** Como ambos fazem binding com prefixo vazio, eles leem as mesmas chaves. Um endpoint que recebe `[FromForm] Dictionary<string, string> first, [FromForm] Dictionary<string, string> second` com `[a]=1&[b]=2` retorna `first={"a":"1","b":"2"} second={"a":"1","b":"2"}`. Não há aviso nenhum. Só isso já é motivo para preferir a classe invólucro.

- **Arrays e listas se comportam de forma diferente entre si.** `List<string> tags` é um tipo complexo e precisa de `[0]`, `[1]`. `int[] ids` tem um tipo de elemento com `TryParse`, então segue o caminho simples e faz binding a partir de `ids=1&ids=2` repetido. E `[FromForm] string[] tags` quebra na inicialização no .NET 10 com `InvalidOperationException: TryParse method found on string with incorrect format`, porque `string` agora expõe um `TryParse` baseado em span que o cache de métodos de binding rejeita em vez de ignorar. Esse é o [dotnet/aspnetcore#62326](https://github.com/dotnet/aspnetcore/issues/62326), corrigido pelo [PR #63072](https://github.com/dotnet/aspnetcore/pull/63072); o commit de merge é ancestral de todas as tags `v11.0.0-preview` e de nenhuma das tags `v10.0.0` ou `v10.0.5`, então a quebra fica com você por todo o ciclo de vida do .NET 10.

- **Dois limites diferentes, ambos com padrão 1024.** Envie 1025 chaves e você recebe `InvalidDataException: Form value count limit 1024 exceeded` do `FormPipeReader`, que é o `FormOptions.ValueCountLimit`. Aumente com `services.Configure<FormOptions>(o => o.ValueCountLimit = 5000)` e você bate na próxima parede: `The number of elements in the dictionary exceeded the maximum number of '1024' elements allowed`, que é o teto do próprio mapeador. Esse é por endpoint: `.WithFormMappingOptions(maxCollectionSize: 5000)`. Você precisa dos dois, e aumentar só um faz parecer que a correção não fez nada. Se seus uploads são grandes em bytes e não em quantidade de chaves, [413 Request Entity Too Large ao enviar um arquivo](/pt-br/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) cobre os limites por tamanho.

- **O binding de formulário exige a configuração de antiforgery.** Qualquer endpoint de minimal API com um parâmetro vinculado a formulário carrega metadados de antiforgery. Se a aplicação nunca chama `app.UseAntiforgery()`, a requisição falha com `InvalidOperationException: Endpoint HTTP: POST /upload contains anti-forgery metadata, but a middleware was not found that supports anti-forgery` e um `500`. Adicione o middleware, ou chame `.DisableAntiforgery()` em endpoints máquina a máquina. Não desative em massa em endpoints para os quais um navegador envia dados.

- **O Request Delegate Generator recusa tudo isso.** Compile com `EnableRequestDelegateGenerator` em `true`, ou com `PublishAot`, e tanto o parâmetro dicionário quanto a classe invólucro produzem `warning RDG003: Unable to statically resolve parameter named 'metadata' for endpoint`. O endpoint recorre à geração em tempo de execução, que é exatamente o que AOT não pode fazer. `IFormCollection` não gera aviso, então a opção 3 é o formato seguro para AOT. Veja [como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para o resto dos diagnósticos do RDG.

- **Um `Content-Type` errado parece o mesmo problema.** Se a requisição chega como `application/json` em vez de `multipart/form-data` ou `application/x-www-form-urlencoded`, você recebe um `415` em vez de um `null` silencioso. É outra falha com outra correção, coberta em [415 Unsupported Media Type de um endpoint de minimal API](/pt-br/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/).

A regra a guardar é curta: em uma minimal API, um parâmetro `[FromForm]` é endereçado pelo nome apenas se o tipo dele puder ser convertido a partir de uma única string. Todo o resto passa pelo mapeador de formulário do Blazor, que começa na raiz do formulário e não sabe como o seu parâmetro se chama. Dê a ele uma classe para descer e os nomes voltam.

## Relacionados

- [Correção: "415 Unsupported Media Type" de um endpoint de minimal API no ASP.NET Core 11](/pt-br/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) para quando o formulário nem chega ao binder.
- [Correção: "413 Request Entity Too Large" ao enviar um arquivo para um endpoint do ASP.NET Core](/pt-br/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) para os limites de tamanho em bytes que ficam antes do parsing do formulário.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para o que o Request Delegate Generator consegue e não consegue vincular.
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para o conjunto mais amplo de diferenças de binding entre os dois modelos.
- [Como enviar um arquivo grande com streaming para o Azure Blob Storage](/pt-br/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) para sair do buffering de `IFormFile` quando os uploads crescem.

## Fontes

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-10.0) (binding de formulário para coleções e tipos complexos, a tabela de coleções `IFormFile`, e a nota de que binding de formulário para tipos complexos e coleções não é suportado sob o Request Delegate Generator).
- dotnet/aspnetcore, [RequestDelegateFactory.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (o predicado `useSimpleBinding` e o `BindComplexParameterFromFormItem`, que chama `FormDataMapper.Map<T>` sem prefixo).
- Issue [#62326](https://github.com/dotnet/aspnetcore/issues/62326) e PR [#63072](https://github.com/dotnet/aspnetcore/pull/63072) do dotnet/aspnetcore (`[FromForm] string[]` quebrando na inicialização, e a correção de binding simples que chegou no .NET 11).
- Microsoft Learn, [RDG003: Unable to statically resolve parameter](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG003) (o diagnóstico em tempo de compilação para parâmetros mapeados de formulário sob AOT).
