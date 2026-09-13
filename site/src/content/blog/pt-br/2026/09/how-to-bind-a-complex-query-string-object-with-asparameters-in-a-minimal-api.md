---
title: "Como vincular um objeto complexo da query string com [AsParameters] em uma minimal API no ASP.NET Core 11"
description: "Coloque [AsParameters] em uma classe ou record para vincular um filtro inteiro da query string em uma minimal API do ASP.NET Core 11. Aborda valores padrão, arrays, enums, objetos aninhados, validação, OpenAPI e um bug do gerador de Native AOT com records posicionais."
pubDate: 2026-09-13
template: how-to
tags:
  - "aspnetcore"
  - "minimal-apis"
  - "dotnet-11"
  - "csharp"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-bind-a-complex-query-string-object-with-asparameters-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Resposta curta:** declare as chaves da query como propriedades de uma classe (ou como parâmetros do construtor de um record) e coloque `[AsParameters]` no parâmetro do handler: `app.MapGet("/products", ([AsParameters] ProductFilter filter) => ...)`. O ASP.NET Core achata o tipo em parâmetros individuais, então `?search=lamp&page=2&tags=a&tags=b` é vinculado a `Search`, `Page` e `Tags` pelo nome, sem diferenciar maiúsculas de minúsculas. Ele só lida com tipos planos: um objeto aninhado precisa do seu próprio `TryParse` ou `BindAsync`, e um valor opcional precisa ser anulável ou ter um valor padrão no construtor, porque um inicializador de propriedade como `= 1` não torna a propriedade opcional.

Tudo o que vem a seguir foi executado no .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1.26425.128`). O `[AsParameters]` chegou no .NET 7 e suas regras não mudaram desde então, então o mesmo código roda no .NET 8, 9 e 10. A única exceção que vale conhecer, um bug do gerador de código-fonte no caminho do Native AOT, também se reproduz no SDK 10.0.302.

## Por que `[FromQuery] ProductFilter` não funciona

Para quem vem de controllers MVC, o reflexo é escrever `[FromQuery] ProductFilter filter`. Em uma minimal API do .NET 11 isso nem compila. O analisador [ASP0020](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020) reporta como erro de build:

```text
error ASP0020: Parameter 'f' of type ProductFilter should define a bool
TryParse(string, IFormatProvider, out ProductFilter) method, or implement IParsable<ProductFilter>
```

Suprima o analisador e o app passa a falhar na inicialização, quando o endpoint é montado:

```text
InvalidOperationException: f must have a valid TryParse method to support converting from a string.
No public static bool ProductFilter.TryParse(string, out ProductFilter) method found for f.
```

Remova o atributo e fica ainda mais confuso. Um tipo complexo sem fonte de binding é inferido como o corpo da requisição, e o `MapGet` recusa corpos inferidos:

```text
InvalidOperationException: Body was inferred but the method does not allow inferred body parameters.
```

Isso é intencional. As minimal APIs dispensam o model binder recursivo do MVC, e `[FromQuery]` significa "uma chave da query, convertida com `TryParse`". A [documentação de binding de parâmetros](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) diz que `AsParametersAttribute` habilita binding simples de parâmetros para tipos, e não model binding complexo ou recursivo. O que ele faz é achatar: a factory de request delegate trata cada membro do tipo como um parâmetro separado do handler e depois aplica as regras normais (rota, query, header, serviços, tipos especiais) a cada membro. Esse modelo mental explica todos os comportamentos do restante deste post.

## Vincule um filtro da query string passo a passo

1. Crie um tipo com um membro por chave da query.
2. Torne anulável cada membro opcional, ou dê a ele um valor padrão em um parâmetro do construtor de um record.
3. Coloque `[AsParameters]` no parâmetro do handler.
4. Renomeie ou mude a fonte de membros individuais com `[FromQuery(Name = ...)]`, `[FromRoute]` ou `[FromHeader]`.
5. Adicione DataAnnotations e chame `AddValidation()` se precisar de verificações de intervalo.

Este é o filtro que usei:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15, <Nullable>enable</Nullable>
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/products", ([AsParameters] ProductFilter f) => f);

app.Run();

enum SortOrder { Asc, Desc }

class ProductFilter
{
    public string? Search { get; set; }
    public int? Page { get; set; }
    public int? PageSize { get; set; }
    public SortOrder? Sort { get; set; }
    public DateOnly? Since { get; set; }
    public string[] Tags { get; set; } = [];
    [FromQuery(Name = "q")] public string? Keyword { get; set; }
}
```

E as respostas reais:

```text
GET /products?search=lamp&page=2&pageSize=10&sort=Desc&since=2026-01-31&tags=a&tags=b&q=kw
200 {"search":"lamp","page":2,"pageSize":10,"sort":1,"since":"2026-01-31","tags":["a","b"],"keyword":"kw"}

GET /products?SEARCH=lamp&PAGE=3
200 {"search":"lamp","page":3,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}

GET /products
200 {"search":null,"page":null,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}
```

A chave da query é o nome do membro, comparado sem diferenciar maiúsculas de minúsculas, e `[FromQuery(Name = "q")]` a substitui para um membro. Chaves repetidas preenchem um array. `DateOnly` interpreta uma string ISO `yyyy-MM-dd`. Qualquer tipo de membro com um `TryParse` estático (todos os primitivos, `Guid`, `DateTimeOffset`, enums e os seus próprios tipos `IParsable<T>`) é vinculado a partir de uma única chave.

## Obrigatório vs opcional: a armadilha do inicializador de propriedade

Esse é o erro que mais vejo. Parece uma classe com valores padrão sensatos:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
class RequiredFilter
{
    public int Page { get; set; } = 1;
    public bool InStock { get; set; }
    public string Search { get; set; } = "";
}
```

`GET /required` sem query string retorna `400`:

```text
BadHttpRequestException: Required parameter "int Page" was not provided from query string.
```

A factory decide se um membro é opcional pela sua anulabilidade e, no caso de parâmetros de construtor, por um valor padrão declarado. Um inicializador de propriedade é apenas código dentro do construtor, invisível para reflection, então uma propriedade `int`, `bool` ou `string` não anulável é obrigatória independentemente do que você atribua a ela. O documento OpenAPI gerado concorda e marca as três como `required: true`.

Existem duas correções. Torne os membros anuláveis e aplique o valor padrão no handler (`f.Page ?? 1`), ou mude para um record posicional, onde os valores padrão do construtor contam:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
record ProductQuery(string? Search, int Page = 1, int PageSize = 20,
    SortOrder Sort = SortOrder.Asc, string[]? Tags = null);

app.MapGet("/products-record", ([AsParameters] ProductQuery q) => q);
```

```text
GET /products-record         -> {"search":null,"page":1,"pageSize":20,"sort":0,"tags":[]}
GET /products-record?page=4  -> {"search":null,"page":4,"pageSize":20,"sort":0,"tags":[]}
```

Repare que `Tags` voltou como `[]`, e não `null`, apesar do padrão `= null`: um array sem chaves correspondentes é vinculado como array vazio. Um `record struct PagingStruct(int Page = 1, int PageSize = 20)` se comporta da mesma forma e retornou `{"page":1,"pageSize":20}`. A documentação observa que uma `struct` pode ter melhor desempenho do que uma classe `record` porque evita uma alocação por requisição; eu não fiz benchmark disso, então trate como uma afirmação da documentação.

Vale saber como a factory escolhe os membros. A lógica em [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) é: se o tipo tem um único construtor público com parâmetros, vincula os parâmetros dele (associados às propriedades pelo nome). Caso contrário, usa o construtor sem parâmetros e vincula todas as propriedades **graváveis**. Uma propriedade somente leitura em uma classe sem esse tipo de construtor é ignorada silenciosamente. Dois construtores públicos com parâmetros falham com `Only a single public parameterized constructor is allowed for type 'TwoCtors'.`, e um tipo abstrato falha com `The abstract type 'AbstractFilter' is not supported.`

## Misture valores de rota, headers e serviços no mesmo tipo

Como cada membro passa pelas regras normais de binding, um único tipo `[AsParameters]` pode reunir a lista inteira de argumentos, e não só a query string:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
app.MapGet("/tenants/{tenantId:int}/orders", ([AsParameters] OrderRequest r) => new
{
    r.TenantId, r.Region, r.Status, r.Ids, r.UserAgent,
    Logger = r.Logger.GetType().Name,
    Path = r.Http.Request.Path.Value,
    CanCancel = r.Ct.CanBeCanceled
});

enum OrderStatus { Pending, Shipped, Cancelled }

class OrderRequest
{
    [FromRoute(Name = "tenantId")] public int TenantId { get; set; }
    [FromHeader(Name = "X-Region")] public string? Region { get; set; }
    public OrderStatus? Status { get; set; }
    public int[] Ids { get; set; } = [];
    [FromHeader(Name = "User-Agent")] public string? UserAgent { get; set; }
    public ILogger<OrderRequest> Logger { get; set; } = default!;   // from DI
    public HttpContext Http { get; set; } = default!;              // special type
    public CancellationToken Ct { get; set; }                      // RequestAborted
}
```

```text
GET /tenants/42/orders?status=Shipped&ids=1&ids=2   (X-Region: eu-west)
200 {"tenantId":42,"region":"eu-west","status":1,"ids":[1,2],"userAgent":"curl/8.7.1",
     "logger":"Logger`1","path":"/tenants/42/orders","canCancel":true}
```

Esse é o caso de uso com que o próprio exemplo da Microsoft abre: condensar uma assinatura longa de handler (`int id, TodoDb db, ...`) em um único tipo. Ele combina bem com [agrupar endpoints com `MapGroup`](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), onde o prefixo da rota já carrega um valor `{tenantId}`.

## Valores inválidos, enums que diferenciam maiúsculas e listas separadas por vírgula

Um valor que falha no `TryParse` produz um `400` antes que o seu handler seja executado:

```text
GET /products?page=abc    -> 400 Failed to bind parameter "Nullable<int> Page" from "abc".
GET /products?sort=Desc   -> 200
GET /products?sort=desc   -> 400 Failed to bind parameter "Nullable<SortOrder> Sort" from "desc".
```

O resultado do enum surpreende as pessoas: o binding usa a sobrecarga de `Enum.TryParse` que diferencia maiúsculas de minúsculas, então `desc` é rejeitado enquanto `Desc` funciona. Se os seus clientes enviam valores em minúsculas, vincule um `string?` e chame `Enum.TryParse<SortOrder>(value, ignoreCase: true, out var sort)` você mesmo, ou envolva o enum em um tipo pequeno com o seu próprio `TryParse`.

Em Development, a página de exceção do desenvolvedor mostra o texto de `BadHttpRequestException` acima. Fora de Development, o cliente recebe um `400` sem detalhes e o motivo vai apenas para o log de debug, então não use essa mensagem como contrato da sua API.

Listas separadas por vírgula não são divididas:

```text
GET /products?tags=a,b              -> 200 "tags":["a,b"]   (one element)
GET /tenants/42/orders?ids=1,2      -> 400 Failed to bind parameter "int[] Ids" from "1,2".
```

Arrays só são vinculados a partir de chaves repetidas (`?ids=1&ids=2`). Se você precisa aceitar `ids=1,2`, vincule um `string?` e divida você mesmo, ou dê a um tipo personalizado um `TryParse` que faça a divisão.

## Objetos aninhados precisam do seu próprio parser

Este é o formato que as pessoas realmente querem vincular:

```csharp
class Money { public decimal Min { get; set; } public decimal Max { get; set; } }
class NestedFilter { public string? Q { get; set; } public Money? Price { get; set; } }
```

`Price` é um tipo complexo sem fonte de binding, então a factory o infere como o corpo, e em um `GET` o endpoint falha na inicialização com o mesmo erro `Body was inferred but the method does not allow inferred body parameters.` visto antes. Chaves no estilo `?price.min=10`, que o model binder do MVC entende, não significam nada aqui. Colocar `[AsParameters]` em um membro aninhado também não ajuda. Isso lança `NotSupportedException: Nested AsParametersAttribute is not supported and should be used only for handler parameters.`

Você tem três opções, na ordem em que eu recorreria a elas.

**Achate o objeto.** `decimal? MinPrice` e `decimal? MaxPrice` é sem graça, gera a melhor saída de OpenAPI e não exige código.

**Interprete uma chave com `IParsable<T>`.** Um membro cujo tipo tem um `TryParse` estático é vinculado a partir de uma única chave:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15
using System.Diagnostics.CodeAnalysis;
using System.Globalization;

record PriceRange(decimal Min, decimal Max) : IParsable<PriceRange>
{
    public static bool TryParse(string? s, IFormatProvider? provider,
        [MaybeNullWhen(false)] out PriceRange result)
    {
        result = null;
        if (s?.Split('-', 2) is not [var lo, var hi]) return false;
        if (!decimal.TryParse(lo, NumberStyles.Number, CultureInfo.InvariantCulture, out var min)) return false;
        if (!decimal.TryParse(hi, NumberStyles.Number, CultureInfo.InvariantCulture, out var max)) return false;
        if (min > max) return false;
        result = new PriceRange(min, max);
        return true;
    }

    public static PriceRange Parse(string s, IFormatProvider? provider) =>
        TryParse(s, provider, out var r) ? r : throw new FormatException($"'{s}' is not a price range.");
}
```

`?price=10-50` é vinculado a `{"min":10,"max":50}`, e `?price=50-10` retorna `400 Failed to bind parameter "PriceRange Price" from "50-10".`

**Leia chaves com ponto usando `BindAsync`.** Se o formato na requisição é fixo em `budget.min=5&budget.max=99`, implemente `BindAsync(HttpContext, ParameterInfo)`. Dentro de um tipo `[AsParameters]`, `parameter.Name` é o nome da propriedade, então o prefixo vem de graça:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.Globalization;
using System.Reflection;

record DottedRange(decimal? Min, decimal? Max)
{
    public static ValueTask<DottedRange?> BindAsync(HttpContext context, ParameterInfo parameter)
    {
        var q = context.Request.Query;
        decimal? Read(string key) => decimal.TryParse(q[$"{parameter.Name}.{key}"],
            NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? v : null;
        var (min, max) = (Read("min"), Read("max"));
        return ValueTask.FromResult(min is null && max is null ? null : new DottedRange(min, max));
    }
}

class RangeFilter
{
    public PriceRange? Price { get; set; }
    public DottedRange? Budget { get; set; }
    public string? Q { get; set; }
}
```

```text
GET /by-range?price=10-50&budget.min=5&budget.max=99&q=chair
200 {"price":{"min":10,"max":50},"budget":{"min":5,"max":99},"q":"chair"}
```

O custo do `BindAsync` é a documentação: o gerador de OpenAPI embutido listou `Price` (como string) e `Q` para esse endpoint e deixou `Budget` totalmente de fora. Se você precisa que ele apareça documentado, adicione-o com um [transformer de operação](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

Mais uma restrição: o próprio parâmetro `[AsParameters]` não pode ser anulável. `[AsParameters] ProductFilter? f` falha com `The nullable type 'ProductFilter' is not supported, mark the parameter as non-nullable.`

## Validação e saída de OpenAPI

A validação embutida das minimal APIs entende os membros de `[AsParameters]`, incluindo parâmetros do construtor de records. Com `builder.Services.AddValidation()` registrado (a mesma configuração usada para [validar corpos de requisição](/pt-br/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)):

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.ComponentModel.DataAnnotations;

record ValidatedPaging([Range(1, 1000)] int Page = 1, [Range(1, 100)] int PageSize = 20);

app.MapGet("/validated", ([AsParameters] ValidatedPaging p) => p);
```

```text
GET /validated?pageSize=500
400 {"title":"One or more validation errors occurred.","status":400,
     "errors":{"PageSize":["The field PageSize must be between 1 and 100."]}}
```

O `Microsoft.AspNetCore.OpenApi` 11.0.0-rc.1 transforma o mesmo tipo em parâmetros de query com `minimum`, `maximum` e `default`. No .NET 10, essa combinação exata (um atributo de validação em um parâmetro do construtor primário de um record `[AsParameters]`) fazia a geração do documento lançar `InvalidCastException`; esse era o [dotnet/aspnetcore#65348](https://github.com/dotnet/aspnetcore/issues/65348), corrigido para o .NET 11 pelo [PR #67284](https://github.com/dotnet/aspnetcore/pull/67284). Se você ainda está no .NET 10, coloque os atributos em uma classe com propriedades. O documento também mostra a armadilha do array vista antes, pelo outro lado. Um `string[] Tags { get; set; } = []` não anulável é documentado como `required: true`, mesmo que o runtime vincule sem problemas uma chave ausente como array vazio, então clientes gerados vão insistir em enviá-lo. Declare arrays opcionais como `string[]?` e o documento os marca como opcionais.

## Native AOT: records posicionais com tipos de referência anuláveis não compilam

Com `<PublishAot>true</PublishAot>`, o build ativa o [Request Delegate Generator](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/aot/request-delegate-generator/rdg), que substitui a factory de runtime por código gerado (a stack abordada em [Native AOT com minimal APIs](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)). A maioria dos erros de inicialização acima vira aviso de build nesse caso: `RDG009` para `[AsParameters]` aninhado, `RDG010` para um parâmetro anulável, `RDG005` para um tipo abstrato e `RDG008` para múltiplos construtores. Isso é uma melhoria.

Ele também tem um bug. Este endpoint:

```csharp
// .NET 11 RC 1 and SDK 10.0.302, <PublishAot>true</PublishAot> or <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
app.MapGet("/a", ([AsParameters] F f) => f.Page?.ToString() ?? "none");

record F(string? Q, int? Page);
```

falha ao compilar com quatro cópias de:

```text
GeneratedRouteBuilderExtensions.g.cs: error CS8639: The typeof operator cannot be used on a nullable reference type
```

O gerador localiza o construtor do record emitindo `typeof(F).GetConstructor(new[] { typeof(string?), typeof(int?) })`, e `typeof(string?)` não é C# válido. `int?` funciona porque é `Nullable<int>`. Compilei seis variantes do mesmo endpoint com o gerador ativado:

| Tipo `[AsParameters]` | Compila? |
| --- | --- |
| `record F(string? Q, int? Page)` | Não, CS8639 |
| `record F(string[]? Tags, int? Page)` | Não, CS8639 |
| `record F(string Q = "", int? Page = null)` | Sim |
| `record struct F(string? Q, int? Page)` | Sim |
| `record F { public string? Q { get; init; } ... }` | Sim |
| O mesmo record posicional, gerador desativado (build JIT comum) | Sim |

Então o gatilho é uma classe `record` posicional cujo construtor tem um parâmetro de tipo de referência anulável. O build JIT comum funciona, e é por isso que o problema costuma aparecer só quando alguém ativa o `PublishAot` (a documentação diz que o trimming também ativa o gerador). Até que seja corrigido, use uma classe com propriedades graváveis, um record com propriedades `init` ou um `record struct` posicional para tipos `[AsParameters]` em projetos AOT. Não encontrei uma issue de acompanhamento para isso no dotnet/aspnetcore no momento em que escrevi.

## Leia a seguir

- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), incluindo onde o model binder do MVC ainda leva vantagem.
- [Unions do C# no ASP.NET Core 11](/pt-br/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/), outro caso em que a query string é a única fonte de binding que não coopera.
- [Paginação por keyset (cursor) no EF Core 11](/pt-br/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/), um consumidor natural para o filtro de paginação construído aqui.
- [Por que um dicionário `[FromForm]` é sempre null em uma minimal API](/pt-br/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/), o primo do problema de objetos aninhados no binding de formulários.

## Fontes

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) (a seção de `[AsParameters]` e a lista de precedência das fontes de binding).
- Microsoft Learn, [referência da API `AsParametersAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.asparametersattribute).
- Microsoft Learn, [ASP0020: Complex types referenced by route parameters must be parsable](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020).
- Microsoft Learn, [diagnósticos do Request Delegate Generator RDG009](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG009) e [RDG010](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG010).
- dotnet/aspnetcore em `v11.0.0-rc.1.26425.128`: [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) (achatamento de membros, verificação de anulável) e [`RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (verificação de `[AsParameters]` aninhado).
