---
title: "Correção: PublishAot junto com EFOptimizeContext esgota a memória durante um build do EF Core"
description: "A geração do modelo do EF Core em tempo de build chamava o MSBuild de novo até a RAM acabar. Atualize Tasks e Design para 10.0.10+ e, no EF Core 11, remova EFOptimizeContext."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "native-aot"
  - "msbuild"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/09/fix-publishaot-and-efoptimizecontext-exhaust-memory-during-an-ef-core-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Atualize tanto `Microsoft.EntityFrameworkCore.Tasks` quanto `Microsoft.EntityFrameworkCore.Design` para 10.0.10 ou posterior (10.0.12 é a versão atual em 2026-09-10), depois encerre os processos de build que ficaram para trás e reinicie o Visual Studio. Até a 10.0.9, a geração do modelo compilado e a pré-compilação de consultas do EF Core em tempo de build disparavam a si mesmas de novo a partir dos próprios builds aninhados, criando processos do MSBuild até a máquina ficar sem memória. No EF Core 11 a correção já está incluída, e o próprio `EFOptimizeContext` deixou de existir: remova-o, ou o build falha.

## O erro em contexto

Não existe exceção para pesquisar, e é isso que torna esse problema tão desagradável. O relato contra o EF Core 10.0.5, [dotnet/efcore#38087](https://github.com/dotnet/efcore/issues/38087), descreve o sintoma inteiro: a RAM sobe até a máquina parar de responder, a saída do build nunca passa da primeira linha, e basta abrir a solução no Visual Studio para disparar o problema, porque o IntelliSense inicia builds de design-time assim que o projeto carrega. O log detalhado do build nesse relato contém exatamente isto e nada mais:

```
Build started at 5:55 PM...
```

Enquanto isso, o Gerenciador de Tarefas ou o `top` mostra uma pilha crescente de processos `dotnet` e `MSBuild`. As configurações de projeto que disparam o problema são sempre as mesmas quatro linhas:

```xml
<!-- EF Core 10.0.5 through 10.0.9: do not build this without the fix -->
<PublishAot>true</PublishAot>
<EFOptimizeContext>true</EFOptimizeContext>
<EFScaffoldModelStage>build</EFScaffoldModelStage>
<EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
```

Se você chegou aqui depois de atualizar para o EF Core 11, o que você vê é diferente: um erro de build definitivo gerado pelo target `_EFValidateProperties` em `Microsoft.EntityFrameworkCore.Tasks` 11.0.0-rc.1.26425.128, com esta mensagem:

```
$(EFOptimizeContext) is no longer supported. Use $(EFScaffoldModelStage) and $(EFPrecompileQueriesStage) instead.
```

## Por que isso acontece

Aqui se combinam dois fatos que parecem não ter relação.

Primeiro, `PublishAot` não é apenas uma configuração de publicação. Com `<PublishAot>true</PublishAot>` no arquivo de projeto, até um simples `dotnet build` grava os switches de recursos de AOT em `bin/Debug/net10.0/YourApp.runtimeconfig.json`, incluindo este:

```json
"System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
```

O EF Core respeita esse switch e se recusa a construir o modelo em runtime, então uma sessão de depuração com F5 morre na primeira consulta:

```
Unhandled exception. System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
```

A reação natural é fazer o modelo compilado e as consultas pré-compiladas serem gerados a cada build. É exatamente isso que `EFScaffoldModelStage=build` e `EFPrecompileQueriesStage=build` fazem, e no EF Core 9 e 10 eles só têm efeito junto com `EFOptimizeContext=true`. Daí as quatro linhas.

Segundo, existe a forma como o `Microsoft.EntityFrameworkCore.Tasks` encaixa a geração no build. O target `_EFGenerateFilesAfterBuild` é adicionado a `$(TargetsTriggeredByCompilation)`, então roda depois de cada `CoreCompile`. Ele inicia um MSBuild aninhado do mesmo projeto com `_EFGenerationStage=build`, que compila o projeto de novo com AOT desligado e depois executa a tarefa `OptimizeDbContext`. Para as consultas pré-compiladas, o código de design-time do EF abre o projeto pelo `MSBuildWorkspace` do Roslyn, e carregar um projeto dessa forma executa mais um build de design-time dele.

A única coisa que impedia essa cadeia de virar recursão era uma condição `'$(_EFGenerationStage)'==''` nos targets de geração. Ela tinha duas brechas:

1. **Builds de design-time do Visual Studio.** O `CoreCompile` também roda durante os builds leves de design-time que o VS dispara continuamente enquanto um projeto está aberto. Cada um iniciava uma geração completa fora do processo, e eles se acumulavam mais rápido do que terminavam. O [dotnet/efcore#38386](https://github.com/dotnet/efcore/pull/38386) corrigiu isso adicionando `'$(DesignTimeBuild)' != 'True'` aos targets de geração. Essa mudança fica no arquivo `.targets` do pacote **Tasks**.
2. **Builds pela linha de comando.** O `MSBuildWorkspace` aberto para a pré-compilação de consultas não carregava `_EFGenerationStage`, então o build dele satisfazia a condição e disparava a geração de novo, que abria outro workspace, e assim por diante. O [dotnet/efcore#38403](https://github.com/dotnet/efcore/pull/38403) corrigiu isso criando o workspace com `_EFGenerationStage=build` como propriedade global. Essa mudança fica em `DbContextOperations`, dentro do pacote **Design**.

As duas correções entraram em `release/10.0` em junho de 2026 e foram publicadas pela primeira vez na 10.0.10, em 2026-07-14. Conferi isso nos próprios pacotes em vez de confiar no milestone: o `Microsoft.EntityFrameworkCore.Tasks.targets` da 10.0.9 não tem nenhuma verificação de `DesignTimeBuild`, enquanto o da 10.0.10 tem três, e a string `_EFGenerationStage` aparece pela primeira vez em `Microsoft.EntityFrameworkCore.Design.dll` na 10.0.10.

## Reprodução mínima

Este é o projeto do relato original, reduzido a uma entidade e um contexto sobre SQLite. Todas as versões até a 10.0.9, inclusive, reproduzem o problema. Não compile isso em uma máquina onde você não esteja pronto para matar a árvore de processos.

```xml
<!-- .NET 10 SDK, EF Core 10.0.9 (broken). Reproduces the memory exhaustion. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <EFOptimizeContext>true</EFOptimizeContext>
    <EFScaffoldModelStage>build</EFScaffoldModelStage>
    <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.9" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.x
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();
await db.Database.OpenConnectionAsync();
await db.Database.ExecuteSqlRawAsync(
    "CREATE TABLE IF NOT EXISTS Entities (Id INTEGER PRIMARY KEY)");
var count = await db.Entities.Where(e => e.Id > 0).CountAsync();
Console.WriteLine($"Entities: {count}");

public class Entity { public int Id { get; set; } }

public class AppDbContext : DbContext
{
    public DbSet<Entity> Entities => Set<Entity>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=db.sqlite");
}
```

A tabela é criada com SQL puro de propósito, em vez de `EnsureCreatedAsync()`. A seção de armadilhas mais abaixo explica o motivo.

## A correção, em detalhes

### 1. Atualize Tasks e Design juntos para 10.0.10 ou posterior

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 (fixed) -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.12" PrivateAssets="all" />
</ItemGroup>
```

Fixe o Design explicitamente. A proteção para design-time está no Tasks, a proteção para a linha de comando está no Design, e sem isso o Design chega ao seu grafo de forma transitiva, na versão que o NuGet resolver. Nem sempre é a versão que você imagina: o Tools 10.0.6 a 10.0.8 deixava o Design ser resolvido em versões tão baixas quanto 8.0.0, uma bagunça descrita em [a correção do MissingMethodException ArgumentIsEmpty](/pt-br/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/). Atualizar só o Tasks conserta o Visual Studio e deixa o `dotnet build` quebrado. Rode `dotnet nuget why . Microsoft.EntityFrameworkCore.Design` para ver o que você realmente recebeu.

Depois limpe o que a versão quebrada deixou para trás. Feche o Visual Studio, encerre qualquer processo `dotnet` ou `MSBuild` órfão, desligue os servidores de build e apague `obj` para que arquivos gerados pela metade e as listas `*.EFGeneratedSources.Build.txt` não voltem para a próxima compilação:

```bash
dotnet build-server shutdown
```

Com a reprodução acima movida para a 10.0.12, no SDK 10.0.302, o `dotnet build` termina em 5,4 segundos com 0 erros, o app imprime `Entities: 0`, e `obj/Debug/net10.0/EfBombRepro.EFGeneratedSources.Build.txt` lista seis arquivos gerados:

```
AppDbContextAssemblyAttributes.g.cs
EntityUnsafeAccessors.g.cs
AppDbContextModel.g.cs
AppDbContextModelBuilder.g.cs
EntityEntityType.g.cs
Program.EFInterceptors.AppDbContext.g.cs
```

O arquivo de interceptors contém o SQL final da chamada `CountAsync`, `SELECT COUNT(*) FROM "Entities" AS "e" WHERE "e"."Id" > 0`, como literal de string. Esse é todo o objetivo da pré-compilação de consultas: nenhuma tradução de LINQ acontece em runtime.

### 2. No EF Core 11, remova EFOptimizeContext

O EF Core 11 removeu a propriedade ([dotnet/efcore#35079](https://github.com/dotnet/efcore/issues/35079)) porque as propriedades de estágio já expressavam tudo o que ela fazia. Agora elas habilitam a geração sozinhas:

```xml
<!-- .NET 11, EF Core 11.0.0-rc.1.26425.128 -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <EFScaffoldModelStage>build</EFScaffoldModelStage>
  <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
</PropertyGroup>
```

O arquivo targets da rc.1 traz a proteção de `DesignTimeBuild`, e o assembly Design da rc.1 traz a correção do workspace com `_EFGenerationStage`, então essa configuração é segura. Se você só precisa da geração na publicação, remova também as duas linhas de estágio: as duas usam `publish` como padrão, e com `PublishAot=true` o EF Core 11 gera o modelo compilado e as consultas pré-compiladas durante o `dotnet publish` sem nenhuma propriedade extra. Uma combinação é rejeitada de cara, `EFScaffoldModelStage=publish` com `EFPrecompileQueriesStage=build`, que falha com "If $(EFScaffoldModelStage) is set to 'publish' then $(EFPrecompileQueriesStage) must also be set to 'publish'."

Cuidado com a ordem. Na 10.x, `EFOptimizeContext` ainda é a chave que libera a geração no estágio de build. Eu a removi da reprodução corrigida na 10.0.12 e deixei os dois estágios em `build`: o build passou, não gerou nada, e o app lançou a exceção "Model building is not supported" na primeira consulta. Remova a propriedade como parte da atualização para o EF Core 11, não antes. Note também que no EF Core 11 o pacote Tasks não depende mais do Design, mais um motivo para manter a referência explícita ao Design do passo 1.

Como o único SDK na minha máquina é o 10.0.302 e os pacotes do EF Core 11 têm como alvo apenas `net11.0`, as afirmações sobre o EF Core 11 acima vêm da leitura do arquivo targets e do assembly publicados na rc.1, não da execução de um build.

### 3. Mantenha PublishAot fora do ciclo interno de desenvolvimento

O conselho do mantenedor do EF na thread da issue é direto: "I'd recommend not setting `<PublishAot>true</PublishAot>` for the inner dev loop". A objeção de quem relatou o problema é a que importa: sem `PublishAot`, os avisos de trimming e de AOT somem da IDE. Não precisam sumir, porque os analisadores têm switches próprios:

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 -->
<PropertyGroup>
  <EnableAotAnalyzer>true</EnableAotAnalyzer>
  <EnableTrimAnalyzer>true</EnableTrimAnalyzer>
</PropertyGroup>
```

Com `PublishAot` substituído por essas duas linhas, a reprodução continua reportando os mesmos avisos `IL2026` e `IL3050` em `new AppDbContext()`. O runtimeconfig deixa de conter o switch `IsDynamicCodeSupported`, o EF Core constrói o modelo em runtime como sempre, e nada é gerado durante o build. AOT vira uma decisão de publicação:

```bash
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
```

A documentação do EF também recomenda definir `<RuntimeIdentifier>` no projeto de inicialização quando a geração roda no estágio de publicação.

O custo no ciclo interno não é hipotético. Na reprodução com uma única entidade, um build incremental depois de editar `Program.cs` levou 4,7 segundos com a geração no estágio de build e 1,2 segundo sem ela. Um build sem alterações levou 0,6 segundo nos dois casos, porque a geração é pulada sempre que o `CoreCompile` é pulado. A documentação avisa que o modelo e os interceptors gerados "may currently be quite large" e demoram para ser produzidos, então essa diferença cresce junto com o seu modelo.

## Armadilhas e erros parecidos

**"Design-time DbContext operations are not supported when publishing with NativeAOT."** Com `PublishAot=true`, `EnsureCreatedAsync()`, `Migrate()` e qualquer outra coisa que precise do modelo de design-time lançam isso, mesmo com F5 e mesmo com um modelo compilado presente. É por isso que a reprodução cria a tabela com SQL puro. Aplique mudanças de esquema no seu pipeline de implantação com um migrations bundle ou um script SQL.

**`warning CS9270: 'InterceptsLocationAttribute(string, int, int)' is not supported`.** Os interceptors gerados pela 10.0.12 ainda usam a forma do atributo baseada em caminho de arquivo, então o compilador emite o aviso no arquivo gerado. É um aviso em código gerado, não algo que você corrige no seu. O mesmo detalhe explica por que esses arquivos contêm caminhos absolutos específicos da máquina e pertencem a `obj`, nunca ao controle de versão.

**CS9137, "The 'interceptors' feature is not enabled in this namespace".** Ou a linha `InterceptorsNamespaces` está faltando, ou, segundo a documentação do EF, há referências transitivas desatualizadas a `Microsoft.CodeAnalysis.CSharp.Workspaces` e `Microsoft.CodeAnalysis.Workspaces.MSBuild` no grafo. O mesmo código de erro vindo de outro gerador é tratado em [a correção do CS9137 de interceptors](/pt-br/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

**Geração pulada em silêncio em uma solução com vários projetos.** Cada projeto que contém um `DbContext` ou uma consulta do EF precisa da própria referência a `Microsoft.EntityFrameworkCore.Tasks`, já que ela não é transitiva. A integração também não consegue usar um projeto de inicialização separado, então um contexto configurado a partir de um host em outro projeto precisa de um `IDesignTimeDbContextFactory<TContext>`.

**A mesma exceção de construção do modelo no iOS sem PublishAot.** Builds de iOS definem `DynamicCodeSupport=false` por conta própria, então apps .NET MAUI caem nesse caminho sem nunca terem ativado AOT. Veja [a correção de construção do modelo com NativeAOT no MAUI iOS](/pt-br/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/).

## Relacionados

- [Como aquecer o modelo do EF Core antes da primeira consulta](/pt-br/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/), incluindo como distribuir um modelo compilado com `dotnet ef dbcontext optimize` quando você não precisa de AOT.
- [Correção: Model building is not supported when publishing with NativeAOT em um build .NET MAUI para iOS](/pt-br/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/)
- [Native AOT vs ReadyToRun vs JIT no .NET 11: qual você deve distribuir?](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), vale a leitura antes de comprometer um app EF Core com AOT.
- [Correção: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' depois de atualizar o EF Core Tools](/pt-br/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/)
- [Correção: The 'interceptors' feature is not enabled in this namespace](/pt-br/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/)

## Fontes

- [dotnet/efcore#38087, `PublishAot` + `EFOptimizeContext` fork bombs the system](https://github.com/dotnet/efcore/issues/38087)
- [dotnet/efcore#38386, protege a geração de arquivos do EF contra builds de design-time](https://github.com/dotnet/efcore/pull/38386)
- [dotnet/efcore#38403, protege a geração de arquivos do EF em builds pela linha de comando](https://github.com/dotnet/efcore/pull/38403)
- [dotnet/efcore#35079, remove a propriedade EFOptimizeContext dos targets do EF](https://github.com/dotnet/efcore/issues/35079)
- [Tarefas do MSBuild do EF Core](https://learn.microsoft.com/en-us/ef/core/cli/msbuild)
- [Mudanças que causam quebra no EF Core 11: a propriedade EFOptimizeContext do MSBuild foi removida](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Suporte a NativeAOT e consultas pré-compiladas no EF Core](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)
- [Microsoft.EntityFrameworkCore.Tasks no NuGet](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks)
