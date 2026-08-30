---
title: "Correção: Model building is not supported when publishing with NativeAOT em um build .NET MAUI para iOS"
description: "Builds de iOS definem DynamicCodeSupport=false, então o EF Core se recusa a construir o modelo mesmo que você nunca tenha ativado o NativeAOT. Publique um modelo compilado mais consultas precompiladas, ou reative o interpretador."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "maui"
  - "ios"
  - "native-aot"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-08-30
---

Seu aplicativo MAUI para iOS quebra na primeira chamada ao banco de dados com `Model building is not supported when publishing with NativeAOT. Use a compiled model.`, e definir `<PublishAot>false</PublishAot>` não muda nada. Isso acontece porque o EF Core nunca olha para `PublishAot`. Ele verifica `RuntimeFeature.IsDynamicCodeSupported`, e os targets do .NET para iOS colocam essa chave em `false` em todo build de iOS, tvOS e Mac Catalyst, a menos que o interpretador esteja ativado. A correção suportada é mover seu `DbContext` e todas as consultas LINQ para uma biblioteca de classes comum, rodar `dotnet ef dbcontext optimize --precompile-queries --nativeaot` sobre ela e adicionar `<InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>`. A saída de emergência de uma linha é `<UseInterpreter>true</UseInterpreter>`, com um custo real de inicialização.

Tudo abaixo foi verificado no macOS com o .NET SDK 10.0.302, `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21 / 9.0.19 / 10.0.11 e a CLI `dotnet-ef` 10.0.11. A falha e as três correções se reproduzem em um simples aplicativo de console, sem Xcode e sem iPhone, porque o gatilho é uma única chave do AppContext. Quando uma afirmação é sobre o build de iOS em si e não sobre algo que eu rodei, ela vem dos targets de `dotnet/macios` e `dotnet/sdk` e eu digo isso.

## O erro em contexto

```text
System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder...
   at Microsoft.EntityFrameworkCore.DbContext.get_Model()
```

Ele aparece na primeira operação que toca o modelo: uma consulta, `Add`, `SaveChanges` ou `EnsureCreated`. Criar o `DbContext` sozinho não dispara nada, e é por isso que a quebra costuma cair bem longe do código onde você configura o banco de dados.

As duas mensagens irmãs em que você pode esbarrar assim que começar a corrigir isso são `Design-time DbContext operations are not supported when publishing with NativeAOT.` e `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Ambas são cobertas abaixo.

## Por que um build de iOS reporta um erro de NativeAOT se você nunca ativou o NativeAOT

A mensagem cita NativeAOT, mas nada na verificação menciona isso. Este é o código real, de [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, DbContextServices.CreateModel
if (modelFromOptions == null
    || (designTime && modelFromOptions is not Metadata.Internal.Model))
{
    return RuntimeFeature.IsDynamicCodeSupported
        ? dependencies.ModelSource.GetModel(_currentContext!.Context, dependencies, designTime)
        : designTime
            ? throw new InvalidOperationException(CoreStrings.NativeAotDesignTimeModel)
            : throw new InvalidOperationException(CoreStrings.NativeAotNoCompiledModel);
}
```

`RuntimeFeature.IsDynamicCodeSupported` lê a chave do AppContext `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported`, que o SDK escreve no `runtimeconfig.json` a partir da propriedade MSBuild `DynamicCodeSupport`. De [`Microsoft.NET.Sdk.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.targets):

```xml
<!-- .NET SDK 10.0.302 -->
<RuntimeHostConfigurationOption Include="System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"
                                Condition="'$(DynamicCodeSupport)' != ''"
                                Value="$(DynamicCodeSupport)"
                                Trim="true" />
```

E esta é a linha que a define, de [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) no `dotnet/macios`:

```xml
<!-- dotnet/macios, Xamarin.Shared.Sdk.targets -->
<DynamicCodeSupport Condition="'$(DynamicCodeSupport)' == '' And ( '$(MtouchInterpreter)' == '' And '$(UseInterpreter)' != 'true' ) And ('$(_PlatformName)' == 'iOS' Or '$(_PlatformName)' == 'tvOS' Or '$(_PlatformName)' == 'MacCatalyst')">false</DynamicCodeSupport>
```

Três coisas decorrem dessa condição, e as três contradizem o folclore em torno deste erro.

Não é sobre `PublishAot`. Essa propriedade não aparece em lugar nenhum da cadeia, e é por isso que defini-la como `false` não muda nada.

Não é sobre a configuração Release. A condição não tem nenhuma verificação de `Configuration`. O que realmente decide é se o interpretador está ligado, então um build Debug sem interpretador também recebe `IsDynamicCodeSupported = false`, e um build Release com `UseInterpreter=true` não recebe.

Não se aplica ao Android. A lista de plataformas é apenas iOS, tvOS e Mac Catalyst, e é por isso que a mesma solução continua funcionando no Android e no Windows enquanto o iOS quebra.

A propriedade foi introduzida pelo [PR #18555 do dotnet/macios](https://github.com/dotnet/macios/pull/18555), "Set `DynamicCodeSupport=false` to enable trimming in full AOT mode", e chegou ao workload do MAUI na faixa 8.0.6x. Esse cronograma bate com [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), onde quem reportou isolou a regressão entre o workload 8.0.40 (funcionando) e o 8.0.61 (quebrado) sem mudar uma linha de código do EF Core.

## Reproduzindo sem um iPhone

Como o gatilho é uma única chave, você pode reproduzir e corrigir isso em um aplicativo de console no desktop. Crie um projeto e defina a mesma propriedade que os targets de iOS definem:

```xml
<!-- .NET SDK 10.0.302, net10.0 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <!-- exactly what Xamarin.Shared.Sdk.targets sets for iOS/tvOS/MacCatalyst -->
  <DynamicCodeSupport>false</DynamicCodeSupport>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
</ItemGroup>
```

```csharp
// .NET 10, EF Core 10.0.11
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;

Console.WriteLine($"IsDynamicCodeSupported = {RuntimeFeature.IsDynamicCodeSupported}");

using var db = new NotesContext();
db.Database.EnsureCreated();

public class Note
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

public class NotesContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=notes.db");
}
```

`dotnet run` imprime `IsDynamicCodeSupported = False` e então lança o erro exato. O arquivo gerado `bin/Debug/net10.0/<app>.runtimeconfig.json` mostra de onde veio:

```json
"configProperties": {
  "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
}
```

Esse ciclo de reprodução importa, porque a alternativa é um build para dispositivo de 10 minutos a cada tentativa.

## Correção 1: modelo compilado mais consultas precompiladas em uma biblioteca compartilhada

Esta é a rota suportada e a única que preserva o benefício de trimming para o qual a chave existe. Ela tem três partes, e pular qualquer uma delas só te leva à próxima exceção.

**Passo 1: mova o `DbContext`, as entidades e todas as consultas LINQ para uma biblioteca de classes `net10.0` comum.** Não `net10.0-ios`. As ferramentas `dotnet ef` carregam seu assembly em um processo de tempo de design no host, e precisam de um projeto que consigam de fato compilar e carregar. Uma biblioteca comum também te dá um projeto onde `IsDynamicCodeSupported` ainda é `true`, que é o que o passo seguinte exige.

A parte "todas as consultas LINQ" não é preferência de estilo. Eu verifiquei: uma consulta escrita no projeto do aplicativo que referencia a biblioteca otimizada ainda lança `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` A precompilação funciona gerando interceptores de C# para os pontos de chamada que ela consegue ver, então um ponto de chamada em outro projeto é invisível para ela. Na prática isso te empurra para uma classe de repositório ou de serviço de dados dentro da biblioteca, que é onde aplicativos MAUI deveriam manter esse código de qualquer forma.

```csharp
// .NET 10, EF Core 10.0.11 - Notes.Data class library
public static class NoteRepository
{
    public static async Task<List<Note>> GetAllAsync()
    {
        using var db = new NotesContext();
        return await db.Notes.OrderBy(n => n.Id).ToListAsync();
    }

    public static async Task<Note?> FindByTextAsync(string text)
    {
        using var db = new NotesContext();
        var needle = text;
        return await db.Notes.FirstOrDefaultAsync(n => n.Text == needle);
    }
}
```

Aquela linha `var needle = text;` não é cosmética. Escrever `n.Text == text` direto contra o parâmetro do método faz a precompilação falhar no EF Core 10.0.11 com `System.Diagnostics.UnreachableException: IdentifierName of type ParameterSymbol: text`. Copiar o parâmetro para uma variável local antes faz a mesma consulta precompilar sem problemas. Mantenha a variável local até que isso seja corrigido no projeto original.

**Passo 2: habilite os interceptores e gere o modelo.** Adicione a propriedade à biblioteca:

```xml
<!-- Notes.Data.csproj, EF Core 10.0.11 -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
</PropertyGroup>
```

Sem ela o build falha com `CS9137: The 'interceptors' feature is not enabled in this namespace`. Se esse código parece familiar, é a mesma habilitação em que as pessoas tropeçam com [os interceptores do gerador de código-fonte do OpenAPI](/pt-br/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

Então, a partir do diretório da biblioteca:

```bash
dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Notes.Data.CompiledModels --precompile-queries --nativeaot
```

Quando dá certo, ele imprime:

```text
Successfully generated a compiled model, it will be discovered automatically, but you can also
call 'options.UseModel(Notes.Data.CompiledModels.NotesContextModel.Instance)'.
Run this command again when the model is modified.
```

Esse "discovered automatically" é um comportamento do EF Core 9 em diante: o gerador emite `[assembly: DbContextModel(typeof(NotesContext), typeof(NotesContextModel))]` em `NotesContextAssemblyAttributes.cs`, e o EF encontra isso desde que o atributo esteja no mesmo assembly que o `DbContext`. No EF Core 8 não existe atributo e você precisa chamar `UseModel` você mesmo.

**Passo 3: regenere a cada mudança de código.** Interceptores de C# são fixados em posições do código-fonte, então qualquer edição na biblioteca os invalida. A documentação do EF é direta sobre isso: a geração de interceptores "isn't expected to happen in the inner loop". Para um aplicativo real, adicione o pacote [`Microsoft.EntityFrameworkCore.Tasks`](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks) (10.0.11) à biblioteca para que o MSBuild faça isso na publicação, em vez de depender de alguém lembrar do comando da CLI. Eu verifiquei a rota via CLI de ponta a ponta; a integração com MSBuild é o que a documentação recomenda para CI.

Com as três partes no lugar, meu aplicativo de console com `DynamicCodeSupport=false` insere uma linha, lista linhas e roda uma busca parametrizada sem nenhuma exceção.

## Correção 2: reative o interpretador

Olhe de novo para a condição do macios: definir `MtouchInterpreter` ou `UseInterpreter` suprime `DynamicCodeSupport=false` por completo, então o EF Core constrói seu modelo em tempo de execução exatamente como faz no Android.

```xml
<!-- MAUI app csproj -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <UseInterpreter>true</UseInterpreter>
</PropertyGroup>
```

Esta é uma configuração legítima, não uma gambiarra: o interpretador de IL do Mono não é JIT, e a Apple permite. O que você paga é throughput e inicialização, já que código interpretado é mais lento que código compilado com AOT e o modelo ainda é construído por reflexão no primeiro uso. Use para desbloquear uma versão, e depois faça a Correção 1.

Duas ressalvas. O interpretador também desativa o IL stripping (`EnableAssemblyILStripping` é forçado para `false` quando `MtouchInterpreter` está definido), então o pacote do seu aplicativo cresce. E é um recurso do Mono: os targets do macios emitem o aviso "The property 'UseInterpreter' has no effect when not using the Mono runtime (for instance when using CoreCLR)". Isso importa daqui para frente, porque [o MAUI mobile é só CoreCLR a partir do .NET 11 Preview 6](/pt-br/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). Trate esta correção como uma ponte para o .NET 10, não como um plano de longo prazo.

## Correção 3: forçar DynamicCodeSupport de volta para true

```xml
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <DynamicCodeSupport>true</DynamicCodeSupport>
</PropertyGroup>
```

A condição da linha do macios começa com `'$(DynamicCodeSupport)' == ''`, então um valor explícito vence e a chave aterrissa no `runtimeconfig.json` como `true`. O EF Core então para de lançar a exceção.

Estou listando isso por último por um motivo. A chave não é decorativa: é o que diz ao trimmer que ele pode remover os caminhos de código dinâmico, que é justamente o objetivo do [PR #18555](https://github.com/dotnet/macios/pull/18555). Defini-la como `true` enquanto o aplicativo continua totalmente compilado com AOT é mentir para o runtime, e você passa a depender de cada biblioteca do seu grafo de dependências tolerar um ambiente que declara um suporte a código dinâmico que ele não tem. Se você já passou por [o que código seguro para trimming realmente exige](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) vai reconhecer o formato do risco. Use para diagnosticar, não para publicar.

## EnsureCreated e Migrate continuam falhando depois de corrigir o modelo

Este é o passo que pega a maioria dos aplicativos MAUI, porque a inicialização padrão do SQLite é uma chamada a `EnsureCreated()` no construtor do aplicativo. Com um modelo compilado no lugar e `IsDynamicCodeSupported = false`, as duas lançam:

```text
EnsureCreated: InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
Migrate:       InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
```

Volte ao trecho de `CreateModel`: um modelo compilado é um `RuntimeModel`, não um `Metadata.Internal.Model`, então qualquer caminho de código que peça o modelo de tempo de design segue o ramo `NativeAotDesignTimeModel`. A criação do esquema precisa do modelo de tempo de design para emitir DDL, então não pode funcionar a partir de um modelo compilado. Esta é outra regressão do EF Core 9: rodei a mesma chamada a `EnsureCreated()` com a chave desligada contra o EF Core 8.0.21 e ele criou o banco de dados sem reclamar.

A alternativa é parar de pedir ao aplicativo que calcule o DDL. Gere o SQL uma vez no host e execute como texto:

```bash
dotnet ef migrations script -o Migrations.sql
```

```csharp
// .NET 10, EF Core 10.0.11 - runs fine with IsDynamicCodeSupported = false
using var db = new NotesContext();
db.Database.ExecuteSqlRaw(await File.ReadAllTextAsync(scriptPath));
```

Publique `Migrations.sql` como um raw asset do MAUI e execute na primeira inicialização. Note que o SQLite não suporta `--idempotent`; `dotnet ef migrations script --idempotent` falha com "Generating idempotent scripts for migrations is not currently supported for SQLite", então controle você mesmo a migração aplicada ou proteja o script com `CREATE TABLE IF NOT EXISTS`. O mesmo raciocínio de "entregue um script em vez de rodar `Migrate()`" vale quando [um login de migração não consegue criar o banco de dados](/pt-br/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), por motivos diferentes.

## O que mudou entre EF Core 8, 9 e 10

Se seu aplicativo funcionava no iOS só com um modelo compilado e quebrou de novo depois de atualizar o EF Core, é por isso. Rodei o mesmo código com `DynamicCodeSupport=false` e um modelo compilado, mas sem consultas precompiladas, contra três versões do EF Core:

| EF Core | Descoberta do modelo compilado | `EnsureCreated()` | Consulta LINQ simples |
| --- | --- | --- | --- |
| 8.0.21 | exige `UseModel(...)` | funciona | funciona |
| 9.0.19 | automática | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |
| 10.0.11 | automática | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |

No EF Core 8 o pipeline de consultas ainda compilava LINQ em tempo de execução, e o interpretador de expressões dava conta. Do EF Core 9 em diante o compilador se apoia na mesma chave, em [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, QueryCompiler.ExecuteAsync
var compiledQuery
    = _compiledQueryCache
        .GetOrAddQuery(
            _compiledQueryCacheKeyGenerator.GenerateCacheKey(queryAfterExtraction, async),
            () => RuntimeFeature.IsDynamicCodeSupported
                ? CompileQueryCore<TResult>(_database, queryAfterExtraction, _model, async)
                : throw new InvalidOperationException(CoreStrings.QueryNotPrecompiled));
```

Não existe chave de AppContext para restaurar o comportamento antigo. Um modelo compilado bastava no EF Core 8; a partir do EF Core 9 você também precisa de consultas precompiladas.

## Erros parecidos

`Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` significa que o modelo compilado foi encontrado e a consulta não. Verifique se a consulta está no projeto sobre o qual você rodou `optimize --precompile-queries`, e se o arquivo gerado `*.EFInterceptors.*.cs` está sendo compilado.

`Dynamic LINQ queries are not supported when precompiling queries.` vem do comando optimize, não do aplicativo. Significa que a consulta é composta ao longo de várias instruções (`query = query.Where(...)` dentro de um `if`). Reescreva como duas consultas completas atrás de uma expressão condicional, exatamente como a documentação mostra.

`Design-time DbContext operations are not supported when publishing with NativeAOT.` é `EnsureCreated`, `Migrate`, `GenerateCreateScript`, ou uma ferramenta de tempo de design rodando contra uma configuração onde a chave está desligada. Note que isso também bloqueia o próprio `dotnet ef`: rodar `dotnet ef dbcontext optimize` em um projeto com `DynamicCodeSupport=false` falha com a mesma família de erros de NativeAOT, que é o problema do ovo e da galinha que torna a biblioteca de classes separada necessária.

`PlatformNotSupportedException` na inicialização de um aplicativo com trimming ou AOT é uma falha diferente com uma causa diferente; veja as notas sobre [PlatformNotSupportedException com Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Relacionado

- [O que é Native AOT e quanto ele custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) cobre o trade-off que esta chave existe para habilitar.
- [MAUI mobile é só CoreCLR no .NET 11 Preview 6](/pt-br/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) explica por que a saída de emergência do interpretador tem prazo de validade.
- [O que é código seguro para trimming e como escrevê-lo?](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) é o pano de fundo de por que sobrescrever a chave é arriscado.
- [Correção: o recurso 'interceptors' não está habilitado neste namespace](/pt-br/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) cobre o CS9137 em que você vai esbarrar no passo 2.
- [Correção: CREATE DATABASE permission denied in database 'master'](/pt-br/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) é o outro caso em que publicar um script SQL vence chamar `Migrate()`.

## Fontes

- [Suporte a NativeAOT e consultas precompiladas](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries), documentação do EF Core, incluindo a habilitação de `InterceptorsNamespaces`, o pacote `Microsoft.EntityFrameworkCore.Tasks` e a limitação de consultas dinâmicas.
- [Modelos compilados](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models), documentação do EF Core, para `dotnet ef dbcontext optimize` e as limitações do modelo compilado.
- [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) e [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs) no `dotnet/efcore`, para as duas verificações de `RuntimeFeature.IsDynamicCodeSupported`.
- [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) no `dotnet/macios`, para o padrão de `DynamicCodeSupport` e as condições do interpretador.
- [PR #18555 do dotnet/macios](https://github.com/dotnet/macios/pull/18555), que introduziu a propriedade.
- [dotnet/maui#23653](https://github.com/dotnet/maui/issues/23653) e [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), os relatos originais que isolam a regressão à atualização do workload.
