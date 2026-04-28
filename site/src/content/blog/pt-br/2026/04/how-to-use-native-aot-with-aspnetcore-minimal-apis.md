---
title: "Como usar Native AOT com APIs mínimas do ASP.NET Core"
description: "Um passo a passo completo para .NET 11 que envia uma API mínima do ASP.NET Core com Native AOT: PublishAot, CreateSlimBuilder, JSON com gerador de código-fonte, a limitação do AddControllers, avisos IL2026 / IL3050 e EnableRequestDelegateGenerator para projetos de biblioteca."
pubDate: 2026-04-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "pt-br"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Para enviar uma API mínima do ASP.NET Core com Native AOT no .NET 11, ponha `<PublishAot>true</PublishAot>` no `.csproj`, construa o host com `WebApplication.CreateSlimBuilder` em vez de `CreateBuilder`, e registre um gerador de código-fonte `JsonSerializerContext` via `ConfigureHttpJsonOptions` para que cada tipo de requisição e resposta seja alcançável sem reflexão. Qualquer coisa que não seja API mínima ou gRPC, incluindo `AddControllers`, Razor, hubs do SignalR e árvores de consulta do EF Core sobre grafos de POCO, vai produzir avisos IL2026 ou IL3050 ao publicar e se comportar de forma imprevisível em runtime. Este guia caminha pelo trajeto inteiro em `Microsoft.NET.Sdk.Web` com .NET 11 SDK e C# 14, incluindo as partes que o template do projeto novo esconde de você, e termina com um checklist para verificar se o binário publicado realmente não precisa do JIT.

## As duas flags de projeto que mudam tudo

Uma API mínima Native AOT é um projeto regular do ASP.NET Core com duas propriedades MSBuild adicionadas. A primeira troca o caminho de publicação do CoreCLR para o ILC, o compilador AOT. A segunda diz ao analisador para falhar seu build no momento em que você toca uma API que precisa de geração de código em runtime.

```xml
<!-- .NET 11, C# 14 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>

    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

`PublishAot` faz o trabalho pesado. Habilita a compilação Native AOT durante o `dotnet publish` e, importante, também liga a análise de código dinâmico durante o build e a edição, para que avisos IL2026 (`RequiresUnreferencedCode`) e IL3050 (`RequiresDynamicCode`) acendam na IDE antes mesmo de você chegar a um publish. A Microsoft documenta isso na [visão geral de deployment do Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).

`InvariantGlobalization` não é estritamente necessário, mas eu o deixo ligado em projetos novos. O Native AOT não embute o arquivo de dados ICU por padrão no Linux, e uma comparação de string sensível a cultura sobre um payload de requisição vai lançar `CultureNotFoundException` em produção se você esquecer. Envie globalização explicitamente quando realmente precisar.

O template de projeto novo (`dotnet new webapiaot`) também adiciona `<StripSymbols>true</StripSymbols>` e `<TrimMode>full</TrimMode>` para você. `TrimMode=full` é implicado por `PublishAot=true`, então é redundante mas inofensivo manter.

## CreateSlimBuilder não é CreateBuilder com nome menor

A maior mudança de comportamento entre uma API mínima regular e uma AOT é o host builder. `WebApplication.CreateBuilder` cabeia toda feature comum do ASP.NET Core: HTTPS, HTTP/3, filtros de hosting, ETW, provedores de configuração baseados em variáveis de ambiente, e um serializador JSON padrão que faz fallback baseado em reflexão. Boa parte dessa maquinária não é compatível com Native AOT, então o template AOT usa `CreateSlimBuilder`, documentado na referência de [suporte do ASP.NET Core a Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0) e inalterado no .NET 11.

```csharp
// .NET 11, C# 14
// PackageReference: Microsoft.AspNetCore.OpenApi 11.0.0
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

var app = builder.Build();

var todos = app.MapGroup("/todos");
todos.MapGet("/", () => Todo.Sample);
todos.MapGet("/{id:int}", (int id) =>
    Todo.Sample.FirstOrDefault(t => t.Id == id) is { } t
        ? Results.Ok(t)
        : Results.NotFound());

app.Run();

public record Todo(int Id, string Title, bool Done)
{
    public static readonly Todo[] Sample =
    [
        new(1, "Try Native AOT", true),
        new(2, "Profile cold start", false),
    ];
}

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Três coisas naquela amostra importam e são fáceis de perder:

1. `CreateSlimBuilder` não registra HTTPS nem HTTP/3 por padrão. O slim builder inclui configuração via arquivo JSON para `appsettings`, user secrets, log de console e configuração de logging, mas deliberadamente deixa de lado protocolos tipicamente tratados por um proxy de terminação TLS. Se você roda isso sem um Nginx, Caddy ou YARP na frente, adicione configuração `Kestrel.Endpoints` explicitamente.
2. `MapGroup("/todos")` está bem no mesmo arquivo que `Program.cs`. Mova-o para outro arquivo no mesmo projeto e você vai começar a ver IL3050 a menos que também ligue o gerador de delegate de requisição. Chegamos lá num instante.
3. O context JSON insere no índice `0` na cadeia do resolver, então tem precedência sobre o resolver baseado em reflexão padrão. Sem `Insert(0, ...)`, o writer de resposta do ASP.NET Core ainda pode cair para reflexão para tipos que você não registrou, o que produz uma `NotSupportedException` em runtime no modo AOT.

## JSON: o único serializador é o que você gera

`System.Text.Json` tem dois modos. O modo de reflexão percorre cada propriedade em runtime, o que é incompatível tanto com trimming quanto com AOT. O modo de geração de código-fonte emite metadados em tempo de compilação para cada tipo registrado, o que é totalmente seguro para AOT. Native AOT exige geração de código-fonte para cada tipo que você coloca em ou tira de um corpo de requisição HTTP. Essa é a maior fonte de bugs do tipo "compila legal, lança em runtime".

O `JsonSerializerContext` mínimo viável:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
[JsonSerializable(typeof(List<Todo>))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Todo tipo que cruza o fio precisa estar nessa classe, incluindo as formas `T[]` e `List<T>` que você de fato retorna de endpoints de API mínima. O writer de resposta do ASP.NET Core não desembrulha `IEnumerable<T>` para você no modo AOT. Se você retorna `Enumerable.Range(...).Select(...)`, registre `IEnumerable<Todo>` também ou materialize para um array antes.

Três armadilhas que mordem mesmo autores cuidadosos:

- **`Results.Json(value)` versus `return value`**: retornar um valor diretamente funciona porque o framework conhece o tipo de retorno estático. Embrulhar em `Results.Json(value)` sem passar um `JsonTypeInfo<T>` cai no serializador padrão e pode lançar em runtime no AOT. Use a sobrecarga de `Results.Json` que recebe `JsonTypeInfo<T>` do seu context gerado, ou apenas retorne o valor.
- **Polimorfismo**: `[JsonDerivedType(typeof(Cat))]` funciona sob AOT, mas o tipo base e cada tipo derivado precisam estar no context. Retornos de `object` puro exigem um registro `JsonSerializable(typeof(object))`, que então força toda forma que ele consiga ver, então prefira tipos concretos.
- **`IFormFile` e `HttpContext.Request.ReadFromJsonAsync`**: o binding de parâmetros de form para primitivos funciona no AOT, mas `ReadFromJsonAsync<T>()` sem um context vai lançar. Sempre passe `AppJsonContext.Default.T` como segundo argumento.

O [tour de Andrew Lock pelo gerador de código-fonte da API mínima](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/) e o passo a passo de Martin Costello sobre [usar geradores JSON com APIs mínimas](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/) cobrem o design original do .NET 8 que o .NET 11 herda inalterado.

## Projetos de biblioteca precisam de EnableRequestDelegateGenerator

O gerador de código-fonte da API mínima transforma cada `MapGet(...)`, `MapPost(...)` e por aí vai em um `RequestDelegate` fortemente tipado em tempo de compilação. Quando `PublishAot=true`, o SDK habilita esse gerador automaticamente para o projeto web. Ele **não** habilita para projetos de biblioteca que você referencia, mesmo que essas bibliotecas chamem `MapGet` por meio de métodos de extensão.

O sintoma são avisos IL3050 ao publicar apontando para sua biblioteca, reclamando que `MapGet` faz reflexão em um delegate. A correção é uma propriedade MSBuild na biblioteca:

```xml
<!-- Library project that defines endpoint extension methods -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <IsAotCompatible>true</IsAotCompatible>
    <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
  </PropertyGroup>
</Project>
```

`IsAotCompatible=true` liga os quatro analisadores de trim e AOT, e `EnableRequestDelegateGenerator=true` troca as chamadas `Map*` da biblioteca para o caminho gerado. Sem o segundo, a biblioteca pode ser marcada como compatível com AOT e ainda emitir IL3050 por causa de como o analisador enxerga call sites estilo `Delegate.DynamicInvoke` em `RouteHandlerBuilder`. O time do dotnet/aspnetcore acompanha as quinas em [issue #58678](https://github.com/dotnet/aspnetcore/issues/58678).

Se a biblioteca precisa ser reusável em projetos AOT e não-AOT, deixe a propriedade. O gerador cai graciosamente para o caminho de runtime em builds CoreCLR regulares.

## Do que você abre mão

Native AOT não é um interruptor que você ativa em um monolito MVC pronto. A lista de subsistemas não suportados é curta mas estruturante.

- **MVC controllers**: `AddControllers()` é o exemplo canônico. A API não é trim-safe e não é suportada pelo Native AOT. O time do dotnet/aspnetcore acompanha o suporte de longo prazo em [issue #53667](https://github.com/dotnet/aspnetcore/issues/53667), mas até o .NET 11 não há caminho AOT para classes decoradas com `[ApiController]`. Você ou reescreve os endpoints como APIs mínimas ou não envia AOT. Models e filters dependem demais de reflexão e model binding em runtime para o ILC poder podar com segurança.
- **Razor Pages e Views MVC**: mesma razão. Ambos dependem de compilação de view em runtime. Eles compilam sob `PublishAot=true` se você não os usa, mas registrar `AddRazorPages()` acende IL2026.
- **Hubs server-side do SignalR**: não suportado sob AOT no .NET 11. Os pacotes cliente têm modos amigáveis a AOT, o host do hub não.
- **EF Core**: o runtime funciona, mas a tradução de consultas que depende de reflexão sobre grafos de propriedades de POCO pode produzir IL2026 a menos que você opte por consultas compiladas e configuração com gerador de código-fonte. Para a maioria dos serviços AOT a jogada certa é Dapper mais um setup de `SqlClient` à mão, ou EF Core só para acesso simples estilo `DbSet<T>.Find()`.
- **Padrões de DI pesados em reflexão**: qualquer coisa que resolve `IEnumerable<IPlugin>` a partir de um assembly escaneado é frágil sob trimming. Registre tipos concretos explicitamente, ou use um container de DI gerado por código-fonte.
- **`AddOpenApi()`**: a integração de OpenAPI do .NET 9 é compatível com AOT, mas versões do `Swashbuckle.AspNetCore` antes do refactor consciente de AOT ainda emitem IL2026. Se você precisa de OpenAPI em uma API mínima AOT, use o pacote embutido [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi) e pule o Swashbuckle.

O time da Thinktecture publicou uma [visão legível dos cenários suportados e não suportados](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/) à qual recorro ao fazer onboarding de um time em Native AOT.

## Lendo IL2026 e IL3050 com profissionalismo

Os dois avisos com que você vai lutar são fáceis de confundir:

- **IL2026** significa que a chamada exige código não referenciado. A implementação lê membros via reflexão que o trimmer removeria de outra forma. Causa comum: passar um `Type` em runtime para uma sobrecarga de serializador, chamar `GetProperties()`, ou usar `Activator.CreateInstance(Type)`.
- **IL3050** significa que a chamada exige geração de código dinâmico. Mesmo com todos os membros preservados, a implementação precisa de `Reflection.Emit` ou um passo similar de codegen em tempo de JIT, que não existe no AOT. Causa comum: sobrecargas de `JsonSerializer.Serialize(object)`, `MakeGenericType` em um genérico ainda não instanciado, compilação de árvore de expressão.

Os dois são detectados pelo analisador `IsAotCompatible`, mas só IL2026 é exibido pelo analisador de trimming sozinho. Eu sempre rodo um publish pontual para `bin\publish` da linha de comando durante o desenvolvimento para tirá-los todos à tona de uma vez:

```bash
dotnet publish -c Release -r linux-x64 -o ./publish
```

Uma segunda armadilha: dotnet/sdk [discussion #51966](https://github.com/dotnet/sdk/discussions/51966) acompanha um problema recorrente em que o Visual Studio 2026 e `dotnet build` engolem IL2026 / IL3050 em algumas configurações, mas `dotnet format` os mostra. Se seu time usa Visual Studio, adicione um passo de CI que rode `dotnet publish` contra o runtime AOT para que um aviso perdido derrube a pipeline.

Quando você não conseguir evitar uma API que usa reflexão, pode suprimir o aviso no call site com os atributos `[RequiresUnreferencedCode]` e `[RequiresDynamicCode]` no método que envolve, o que propaga a exigência para cima. Faça isso somente quando você sabe que os caminhos de código consumidores não estão na superfície de publish do AOT. Suprimir dentro de um endpoint handler é quase sempre errado.

## Verificando que o binário realmente funciona

Um publish limpo não prova que o app inicia sob AOT. Três checagens que rodo antes de cantar vitória:

```bash
# 1. The output is a single static binary, not a CoreCLR loader.
ls -lh ./publish
file ./publish/MyApi
# Expected on Linux: "ELF 64-bit LSB pie executable ... statically linked"

# 2. The runtime never loads the JIT.
LD_DEBUG=libs ./publish/MyApi 2>&1 | grep -E "libcoreclr|libclrjit"
# Expected: empty output. If libclrjit.so loads, you accidentally shipped a runtime fallback.

# 3. A real request round-trips with the source generator.
./publish/MyApi &
curl -s http://localhost:5000/todos | head -c 200
```

A terceira checagem é a importante. O modo de falha clássico é "compila, publica, inicia, retorna 500 na primeira requisição" porque um tipo de retorno está faltando do context JSON. Bata em cada endpoint pelo menos uma vez com um payload representativo antes de enviar.

Para deploys em container, build com `--self-contained true` é implícito sob `PublishAot=true`. A saída `./publish/MyApi` mais o arquivo `.dbg` é a unidade de deploy inteira. Uma API mínima típica do .NET 11 aterrissa em 8-12 MB stripped, comparado aos 80-90 MB de um publish CoreCLR self-contained.

## Guias relacionados no Start Debugging

- A alavanca Native AOT está dentro de uma história mais ampla de cold-start: [o playbook de cold-start do AWS Lambda no .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) percorre o caminho AOT em `provided.al2023` com o mesmo setup de gerador de código-fonte.
- Para OpenAPI em cima de uma API mínima AOT, o [guia de geração de cliente OpenAPI](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) cobre o round trip de metadados de API mínima a um `HttpClient` tipado.
- Projetos AOT proíbem JSON baseado em reflexão, então [escrever um `JsonConverter` customizado em System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) é o primer certo quando uma conversão embutida não basta.
- Uma história limpa de exceções importa mais sob AOT, onde diagnósticos baseados em reflexão não estão disponíveis: [adicionar um filtro global de exceção no ASP.NET Core 11](/pt-br/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) mostra o caminho `IExceptionHandler`, totalmente compatível com AOT.

## Fontes

- [Suporte do ASP.NET Core a Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [Visão geral de deployment do Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [Geração de código-fonte em System.Text.Json (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [aspnetcore#58678 - Avisos AOT de Map* fora do Program.cs](https://github.com/dotnet/aspnetcore/issues/58678)
- [aspnetcore#53667 - Suporte Native AOT para MVC](https://github.com/dotnet/aspnetcore/issues/53667)
- [Andrew Lock - Explorando o novo gerador de código-fonte da API mínima](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)
- [Martin Costello - Usando geradores JSON com APIs mínimas](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)
- [Thinktecture - Native AOT com ASP.NET Core, uma visão geral](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)
