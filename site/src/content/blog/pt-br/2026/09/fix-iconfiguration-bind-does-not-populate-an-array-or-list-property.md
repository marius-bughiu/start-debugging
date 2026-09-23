---
title: "Correção: IConfiguration.Bind não preenche uma propriedade array ou List<T> a partir do appsettings.json"
description: "O binder ignora silenciosamente propriedades array sem setter público, IReadOnlyList<T> somente leitura, campos e membros init-only sob o gerador de código-fonte, e acrescenta aos valores padrão em vez de substituí-los. Medido no .NET 10.0.12 e no 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "options-pattern"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Resposta curta:** o `ConfigurationBinder` nunca lança exceção quando não consegue fazer o binding de uma coleção. Ele simplesmente deixa a propriedade como está. Os motivos habituais são: a propriedade é um array (ou `IReadOnlyList<T>`, `IEnumerable<T>`) sem setter público, é um campo público em vez de uma propriedade, o nome da seção que você passou para `GetSection` não corresponde ao JSON, ou você ativou Native AOT ou trimming, o que troca o binder pelo seu gerador de código-fonte, e o gerador ignora acessores `init`. Dê à propriedade um `get; set;` público, faça o binding da seção correta e ative `ErrorOnUnknownConfiguration` para que a próxima divergência falhe de forma explícita. Se a lista é preenchida mas tem itens *a mais*, essa é a outra metade deste bug: o binder acrescenta ao que a propriedade já contém, nunca substitui.

Tudo abaixo foi medido com um probe baseado em arquivo no SDK 10.0.302 com `Microsoft.Extensions.Configuration.Binder` 10.0.12, e depois repetido com 11.0.0-rc.1.26425.128 no SDK do .NET 11 RC 1. Todas as linhas foram idênticas nas duas versões. As diferenças que importam estão entre o binder por reflexão e o binder gerado por código-fonte, não entre o .NET 10 e o 11.

## Por que o binder ignora uma coleção silenciosamente

O binder por reflexão em `ConfigurationBinder.cs` decide, propriedade por propriedade, se consegue escrever nela. A verificação é curta: ele precisa de um getter público e, para qualquer coisa que tenha que *substituir* em vez de *modificar*, também precisa de um setter público (ou `BinderOptions.BindNonPublicProperties = true`). Se a verificação falha, `BindProperty` retorna sem dizer nada.

Essa divisão entre "substituir" e "modificar" explica a maioria dos casos confusos:

- Um **array** nunca pode ser modificado no lugar, porque tem tamanho fixo. O binder cria um novo array e precisa de um setter para armazená-lo. `string[] Hosts { get; } = [];` fica vazio para sempre.
- Um **`List<T>` ou `IList<T>`** que já contém uma instância pode ser modificado. O binder chama `Add` nele, então um `List<string> Hosts { get; } = new();` somente leitura funciona sem problemas.
- Um **`IReadOnlyList<T>`** ou **`IEnumerable<T>`** não tem `Add`. Com um setter, o binder cria um novo array e o atribui. Sem setter, nada acontece.

Erros de conversão de elementos também são engolidos. Em `BindArray` e `BindCollection`, cada elemento é vinculado dentro de um `try`/`catch` que só relança quando `ErrorOnUnknownConfiguration` está definido. Um valor como `"abc"` em um `int[]` simplesmente desaparece do resultado.

## A matriz medida

O probe faz o binding de `{ "App": { "Hosts": [ "a.example", "b.example" ] } }` em diferentes formatos de classe de opções, uma vez com o binder por reflexão padrão e outra com `EnableConfigurationBindingGenerator=true`:

```csharp
// .NET 10.0.12 / .NET 11 RC 1, Microsoft.Extensions.Configuration.Binder
class GetOnlyArray { public string[] Hosts { get; } = []; }
class GetOnlyList { public List<string> Hosts { get; } = new(); }
class GetOnlyRoList { public IReadOnlyList<string> Hosts { get; } = []; }
class FieldArray { public string[] Hosts = []; }
class PrivateSet { public string[] Hosts { get; private set; } = []; }
class InitOnly { public string[] Hosts { get; init; } = []; }
class Settable { public string[] Hosts { get; set; } = []; }
```

| Formato da propriedade | Binder por reflexão | Gerador de código-fonte |
| --- | --- | --- |
| `string[] { get; }` | `[]` | `[]` |
| `List<string> { get; } = new()` | `[a, b]` | `[a, b]` |
| `IReadOnlyList<string> { get; } = []` | `[]` | `[]` |
| `IList<string> { get; } = new List<string>()` | `[a, b]` | `[a, b]` |
| campo público `string[]` | `[]` | `[]` |
| `string[] { get; private set; }` | `[]` | `[]` |
| o mesmo, `BindNonPublicProperties = true` | `[a, b]` | `NotSupportedException` |
| `string[] { get; init; }` | `[a, b]` | `[]` |
| `string[] { get; set; }` | `[a, b]` | `[a, b]` |
| `record Opts(string[] Hosts)` via `Get<T>()` | `[a, b]` | `[a, b]` |
| `ImmutableArray<string> { get; set; }` | `[]` | `NullReferenceException` |

Três linhas merecem uma segunda olhada. Acessores `init` funcionam com reflexão e são ignorados silenciosamente pelo gerador. `ImmutableArray<T>` nunca é preenchido. E o build com gerador deste probe reportou **zero** avisos, então nada em tempo de compilação avisa você sobre nenhum desses casos.

## Corrija passo a passo

1. **Confirme o caminho da seção.** `builder.Configuration.GetSection("App")` precisa corresponder exatamente ao JSON até o nome da propriedade (a correspondência não diferencia maiúsculas de minúsculas, então a capitalização não é o seu problema). Fazer o binding da raiz em vez da seção, o erro de digitação mais comum, produziu `[]` no probe. Imprima o que a configuração realmente contém antes de culpar o binder:

   ```csharp
   // .NET 10 / 11
   foreach (var kv in builder.Configuration.GetSection("App").AsEnumerable())
       Console.WriteLine($"{kv.Key} = {kv.Value}");
   // Among the output you should see:
   // App:Hosts:0 = a.example
   // App:Hosts:1 = b.example
   ```

   Arrays são achatados em chaves indexadas (`App:Hosts:0`, `App:Hosts:1`). Se essas linhas estiverem faltando, o problema é o arquivo (não copiado para a saída, nome de ambiente errado, aninhamento errado), não a classe.

2. **Dê à coleção um setter público.** Esta é a correção para a maioria dos relatos:

   ```csharp
   // .NET 10 / 11
   public sealed class AppOptions
   {
       public string[] Hosts { get; set; } = [];
       public List<EndpointOptions> Endpoints { get; set; } = [];
   }

   public sealed class EndpointOptions
   {
       public string Url { get; set; } = "";
   }
   ```

   Use `get; set;`, não `init`, se houver qualquer chance de o projeto ser publicado com `PublishAot` ou `PublishTrimmed` (veja abaixo). Evite `ImmutableArray<T>` em classes de opções. Se você quer semântica somente leitura para os consumidores, exponha `IReadOnlyList<T> { get; set; }`: o binder por reflexão atribui um `string[]` a ela e o gerador atribui um `List<T>`, e ambos foram preenchidos corretamente no probe.

3. **Faça as divergências falharem de forma explícita.** `ErrorOnUnknownConfiguration` lança exceção quando a configuração tem uma chave sem propriedade correspondente, e também impede o binder de engolir erros de conversão de elementos:

   ```csharp
   // .NET 10 / 11
   builder.Services.AddOptions<AppOptions>()
       .Bind(builder.Configuration.GetSection("App"),
             o => o.ErrorOnUnknownConfiguration = true)
       .ValidateOnStart();
   ```

   Com `"Host": ["a"]` no JSON (no singular), o probe lançou `InvalidOperationException: 'ErrorOnUnknownConfiguration' was set on the provided BinderOptions, but the following properties were not found on the instance of Settable: 'Host'`. Com `"Ports": [1, "abc", 3]`, lançou `'ErrorOnUnknownConfiguration' was set and binding has failed`, com a exceção interna `Failed to convert configuration value 'abc' at 'App:Ports:1' to type 'System.Int32'`. Sem a opção, o mesmo binding retornou `[1, 3]`.

   Combine isso com validação para que uma lista vazia seja uma falha na inicialização em vez de um mistério em produção. [Validar opções na inicialização com `IValidateOptions<T>`](/pt-br/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) cobre o lado do `ValidateOnStart` em detalhes.

4. **Pare de inicializar coleções com valores padrão.** Veja a próxima seção: os valores padrão recebem acréscimos, não são substituídos.

## O binder acrescenta aos valores padrão em vez de substituí-los

Este é o bug que as pessoas encontram logo depois de corrigir a lista vazia. Dê um valor padrão à propriedade e faça o binding de uma seção que tem valores:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public List<string> Hosts { get; set; } = ["localhost"];
}
// appsettings.json: "App": { "Hosts": [ "a.example", "b.example" ] }
// Result: [ "localhost", "a.example", "b.example" ]
```

Foi isso que o probe retornou para `List<T>`, `string[]`, `IEnumerable<T>`, `IReadOnlyList<T>` e `HashSet<T>` igualmente, e tanto para `Bind` quanto para `Get<T>()`. `BindArray` literalmente começa copiando os elementos existentes para uma nova lista antes de adicionar os configurados. Chamar `Bind` duas vezes na mesma instância, por exemplo a partir de um callback de change token, produziu `[a, b, a, b]`.

Esse é um comportamento antigo e deliberado. Uma opção para sobrescrever coleções existentes foi proposta em [dotnet/runtime#62112](https://github.com/dotnet/runtime/issues/62112) em 2021 e continua aberta no milestone Future, assim como [dotnet/runtime#118204](https://github.com/dotnet/runtime/issues/118204), então não espere por uma flag. Aplique os valores padrão *depois* do binding, e só quando a configuração não forneceu nada:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public string[]? Hosts { get; set; }
}

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.PostConfigure<AppOptions>(o => o.Hosts ??= ["localhost"]);
```

No probe, isso deu `[a, b]` quando a seção existia e `[localhost]` quando não existia. A factory do `IOptionsMonitor<T>` cria uma instância nova a cada recarga, então o passo de post-configure roda sobre um estado limpo toda vez. [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/pt-br/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) explica quando cada uma dessas instâncias é criada.

## Arquivos em camadas mesclam arrays por índice

O `appsettings.Development.json` não substitui um array do `appsettings.json`. Provedores de configuração só contribuem com chaves, e o último provedor a definir uma chave vence. Um array é apenas as chaves `0`, `1`, `2`. O probe sobrepôs estes dois arquivos:

```json
// appsettings.json
{ "App": { "Hosts": [ "a", "b", "c" ] } }
```

```json
// appsettings.Development.json
{ "App": { "Hosts": [ "dev1", "dev2" ] } }
```

O resultado do binding foi `[dev1, dev2, c]`. O índice 2 ainda vem do arquivo base. O mesmo acontece com variáveis de ambiente (`App__Hosts__0=env.example` substituiu apenas o primeiro elemento) e argumentos de linha de comando (`--App:Hosts:2=cli.example` acrescentou um terceiro). A documentação de configuração do ASP.NET Core aponta isso e sugere manter os índices alinhados entre as fontes.

Duas coisas que você poderia tentar para limpar o array base não funcionam:

- Um array vazio `"Hosts": []` no arquivo de sobrescrita: o resultado continuou sendo `[a, b]`.
- `"Hosts": null` no arquivo de sobrescrita: também `[a, b]`.

O que funciona é não definir esse array no arquivo base, definir o array completo em cada arquivo de ambiente, ou armazenar o valor como uma única string delimitada e dividi-la no `PostConfigure`. Um simples `"Hosts": "a.example,b.example"` vinculado diretamente a `string[]` dá `[]`; o binder não divide strings para você.

## Native AOT e trimming trocam o binder sem você perceber

O SDK do .NET ativa automaticamente o gerador de código-fonte de binding de configuração para apps com trimming. De `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` no SDK 10.0.302:

```xml
<PropertyGroup Condition="'$(PublishTrimmed)' == 'true' Or '$(PublishAot)' == 'true'">
  <EnableRequestDelegateGenerator Condition="'$(EnableRequestDelegateGenerator)' == ''">true</EnableRequestDelegateGenerator>
  <EnableConfigurationBindingGenerator Condition="'$(EnableConfigurationBindingGenerator)' == ''">true</EnableConfigurationBindingGenerator>
</PropertyGroup>
```

O gerador intercepta suas chamadas a `Bind`, `Get<T>` e `Configure<T>` em tempo de compilação. É assim que o Native AOT consegue binding sem reflexão, mas é uma implementação diferente, e o probe encontrou quatro diferenças de comportamento:

| Caso | Reflexão | Gerador de código-fonte |
| --- | --- | --- |
| `string[] { get; init; }` | faz o binding | ignorado silenciosamente |
| `BindNonPublicProperties = true` | faz o binding de setters privados | `NotSupportedException` |
| `"Ports": [1, "abc", 3]` em `int[]` | `[1, 3]` | `InvalidOperationException: Failed to convert configuration value 'abc'` |
| `"Ports": [1, null, 3]` em `int[]` | `InvalidCastException` | `[1, 3]` |
| `ImmutableArray<string>` | `[]` | `NullReferenceException` |

Então um app que faz o binding sem problemas com `dotnet run` pode se comportar diferente depois que alguém adiciona `<PublishAot>true</PublishAot>` ao projeto. Se você está migrando para AOT, defina `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` explicitamente também em Debug, para que seus testes exercitem o mesmo binder que a produção. [Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) cobre os outros geradores que são ativados ao mesmo tempo. Apps baseados em arquivo (`dotnet run app.cs`) usam `PublishAot=true` por padrão, então um probe rápido escrito dessa forma já está rodando o gerador, a menos que você adicione `#:property PublishAot=false`.

## Outros casos que vale conhecer

- **Índices esparsos são compactados.** As chaves `App:Hosts:0` e `App:Hosts:5` resultaram em `[a, f]`, um array de dois elementos, não seis elementos com lacunas. O exemplo da documentação para o índice 3 ausente mostra a mesma coisa.
- **Chaves de objeto funcionam como índices.** `"Hosts": { "x": "a", "y": "b" }` resultou em `[a, b]`. É por isso que um objeto JSON onde você queria um array não falha.
- **Elementos string nulos sobrevivem.** `["a", null, "c"]` em `string[]` deu `[a, null, c]` nos dois binders, embora a documentação do ASP.NET Core diga que o binder não consegue criar entradas `null`. Não dependa de nenhum dos dois comportamentos; filtre os nulos no `PostConfigure` ou na validação.
- **O binding por construtor funciona para coleções.** `record AppOptions(string[] Hosts)` e tipos de elemento com apenas um construtor parametrizado (`class Endpoint(string url)`) foram vinculados corretamente com `Get<T>()` nos dois modos.
- **`Get<string[]>()` na própria seção do array** (`GetSection("App:Hosts").Get<string[]>()`) é uma forma rápida de verificar os dados independentemente da sua classe de opções.

## Como testar sua própria classe de opções

Mantenha um teste unitário que faz o binding do seu `appsettings.json` real no seu tipo de opções real, com a mesma configuração de gerador da produção:

```csharp
// .NET 10 / 11, xUnit
[Fact]
public void AppOptions_binds_hosts()
{
    var config = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json")
        .Build();

    var options = config.GetSection("App")
        .Get<AppOptions>(o => o.ErrorOnUnknownConfiguration = true);

    Assert.NotNull(options);
    Assert.Equal(new[] { "a.example", "b.example" }, options.Hosts);
}
```

Para cobertura de ponta a ponta, incluindo arquivos específicos de ambiente e variáveis de ambiente, [testes de integração com WebApplicationFactory](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) permitem resolver `IOptions<AppOptions>` a partir do host real.

## Relacionados

- [Como validar opções na inicialização com IValidateOptions<T> no .NET 11](/pt-br/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) transforma uma lista vazia em um erro de inicialização.
- [IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> no .NET 11](/pt-br/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) para saber quando as instâncias vinculadas são criadas e recriadas.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para os outros geradores de código-fonte que o AOT ativa.
- [Como escrever testes de integração com WebApplicationFactory<T> no ASP.NET Core 11](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) para testar a configuração contra o host real.

## Fontes

- [Configuração no ASP.NET Core: vincular um array](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/#bind-an-array), Microsoft Learn
- [Gerador de código-fonte de binding de configuração](https://learn.microsoft.com/dotnet/core/extensions/configuration-generator), Microsoft Learn
- [`ConfigurationBinder.cs` na v10.0.12](https://github.com/dotnet/runtime/blob/v10.0.12/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs), dotnet/runtime
- [dotnet/runtime#62112: permitir a sobrescrita opcional de instâncias existentes de coleções mutáveis](https://github.com/dotnet/runtime/issues/62112)
- [dotnet/runtime#118204: a mesclagem padrão de arrays de configuração é confusa e propensa a erros](https://github.com/dotnet/runtime/issues/118204)
- [`Microsoft.Extensions.Configuration.Binder` no NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Configuration.Binder), versões 10.0.12 e 11.0.0-rc.1.26425.128 testadas
