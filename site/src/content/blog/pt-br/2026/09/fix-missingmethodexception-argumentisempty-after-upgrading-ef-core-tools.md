---
title: "Correção: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' após atualizar o EF Core Tools"
description: "dotnet ef lança MissingMethodException em ArgumentIsEmpty porque o Tools 10.0.6 parou de trazer um Microsoft.EntityFrameworkCore.Design compatível. Fixe o Design na sua versão do EF Core."
pubDate: 2026-09-08
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "dotnet"
  - "dotnet-10"
  - "nuget"
lang: "pt-br"
translationOf: "2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools"
translatedBy: "claude"
translationDate: 2026-09-08
---

Adicione um `PackageReference` explícito para `Microsoft.EntityFrameworkCore.Design` fixado na mesma versão dos demais pacotes do EF Core, no **projeto de inicialização**, e então restaure. `Microsoft.EntityFrameworkCore.Tools` 10.0.6, 10.0.7 e 10.0.8 baixaram sua dependência do Design para `>= 8.0.0`, então o NuGet resolve tranquilamente o Design 8.0.0 ao lado de um runtime do EF Core 10 e o assembly de design chama um método que não existe mais. Atualizar o Tools para 10.0.9 ou posterior também resolve, porque a 10.0.9 restaurou o alinhamento de versões por framework.

## O erro em contexto

Rodando `dotnet ef migrations add` contra um grafo de pacotes quebrado:

```
Build started...
Build succeeded.
System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigration.<>c__DisplayClass0_0.<.ctor>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.<>c__DisplayClass3_0`1.<Execute>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.Execute(Action action)
Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
```

Exatamente o mesmo grafo de pacotes produz uma exceção completamente diferente em `dotnet ef database update` ou `dotnet ef migrations list`:

```
System.TypeLoadException: Method 'Identifier' in type 'Microsoft.EntityFrameworkCore.Design.Internal.CSharpHelper' from assembly 'Microsoft.EntityFrameworkCore.Design, Version=8.0.26.0, Culture=neutral, PublicKeyToken=adb9793829ddae60' does not have an implementation.
   at Microsoft.EntityFrameworkCore.Design.DesignTimeServiceCollectionExtensions.<>c__DisplayClass0_0.<AddEntityFrameworkDesignTimeServices>b__0(ServiceCollectionMap services)
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder.TryAddProviderSpecificServices(Action`1 serviceMap)
```

No Package Manager Console do Visual Studio a mesma coisa aparece em `Add-Migration` e `Update-Database`. As duas mensagens têm uma única causa. A `TypeLoadException` é a mais útil das duas, porque imprime a versão do assembly problemático dentro da própria mensagem.

## Por que isso acontece

`Microsoft.EntityFrameworkCore.Design` é o assembly que de fato implementa o scaffolding de migrações e a engenharia reversa. Nem o `dotnet ef` nem o Package Manager Console o distribuem: eles o carregam a partir do grafo de dependências resolvido do seu projeto de inicialização. Ou seja, a versão do Design é a que o NuGet escolheu, e o NuGet escolhe a menor versão que satisfaz todas as restrições.

Até a 10.0.5, `Microsoft.EntityFrameworkCore.Tools` declarava uma dependência de `Microsoft.EntityFrameworkCore.Design` com um piso igual à sua própria versão, então referenciar o Tools bastava para trazer um Design compatível. Na 10.0.6 esse piso caiu para `8.0.0`. Dá para ler a mudança direto no catálogo do NuGet:

| Versão do Tools | Publicada | Dependência do Design |
| --- | --- | --- |
| 10.0.5 | 2026-03-12 | `net8.0` -> `[10.0.5, )` |
| 10.0.6 | 2026-04-14 | `net8.0` -> `[8.0.0, )` |
| 10.0.7 | 2026-04-21 | `net8.0` -> `[8.0.0, )` |
| 10.0.8 | 2026-05-12 | `net8.0` -> `[8.0.0, )` |
| 10.0.9 | 2026-06-09 | `net8.0` -> `[8.0.26, )`, `net9.0` -> `[9.0.15, )`, `net10.0` -> `[10.0.9, )` |
| 10.0.10 | 2026-07-14 | mesmo formato, `net10.0` -> `[10.0.10, )` |
| 10.0.11 | 2026-08-11 | mesmo formato, `net10.0` -> `[10.0.11, )` |

O motivo da mudança na 10.0.6 era legítimo. O pacote Tools tem como alvo `net8.0` e deve ser utilizável a partir de projetos `net8.0`, `net9.0` e `net10.0`, mas o Design 10.0.x só publica um asset `net10.0`, então um único piso alto quebrava a restauração de projetos em frameworks mais antigos. Baixar o piso para `8.0.0` consertou a restauração e quebrou todo mundo cujo runtime do EF Core era 9.x ou 10.x, porque um único grupo de dependências `net8.0` se aplica a todos os frameworks consumidores. O Tools 10.0.9 resolveu isso direito, com três grupos de dependências, um por framework de destino.

A falha é uma quebra pura de compatibilidade binária. `Check.NotEmpty` no EF Core 10 chama `AbstractionsStrings.ArgumentIsEmpty(object)`; as builds 8.x e 9.x dessa classe de recursos expõem uma assinatura diferente. O JIT resolve a chamada na primeira execução de `AddMigrationImpl` e lança a exceção.

## Reprodução mínima

Duas referências de pacote e um `DbContext` bastam. Este é o projeto inteiro, verificado no SDK 10.0.302 com `dotnet-ef` 10.0.11 em 2026-09-08:

```xml
<!-- SDK 10.0.302. Reproduces the failure exactly as written. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=app.db");
}
```

Depois do `dotnet restore`, o grafo fica assim:

```
$ dotnet list package --include-transitive
   > Microsoft.EntityFrameworkCore              10.0.11
   > Microsoft.EntityFrameworkCore.Abstractions 10.0.11
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Tudo do lado do runtime é 10.0.11 e o assembly de design é 8.0.0. `dotnet ef migrations add Initial` então falha.

## A correção, em detalhe

### 1. Fixe o Design explicitamente no projeto de inicialização

Esta é a correção recomendada pelo time do EF, e a que continua funcionando independentemente do que futuras versões do Tools declararem:

```xml
<!-- SDK 10.0.302, EF Core 10.0.11. Version must match your other EF Core packages. -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

`PrivateAssets=all` mantém o assembly de design fora da sua saída publicada, e é por isso que vale a pena escrever o bloco de metadados inteiro em vez de usar a linha única. Com isso no lugar, `dotnet ef migrations add Initial` funciona mesmo com o Tools ainda na 10.0.6.

A palavra **inicialização** importa. O `dotnet ef` compila e carrega o projeto de inicialização, não o projeto que contém o seu `DbContext`. Numa solução em que `Data` tem o contexto e `Api` é o ponto de entrada, fixar o Design dentro de `Data` não adianta nada, porque `PrivateAssets=all` impede que ele flua pela referência de projeto:

```
$ dotnet list Api/Api.csproj package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

O comando continua falhando com o mesmo `MissingMethodException`. Mova a referência para `Api` e ele passa. Se por convenção você mantém pacotes de design no projeto do contexto, adicione a referência nos dois.

### 2. Ou atualize o Tools para 10.0.9 ou posterior

Se você preferir não adicionar uma referência de pacote, atualizar o pacote Tools basta por si só, porque a 10.0.9 restaurou o alinhamento por framework:

```
$ dotnet list package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       10.0.9
```

A ressalva: você recebe o piso do pacote Tools, não a sua versão do EF Core. Tools 10.0.9 ao lado do EF Core 10.0.11 te dá Design 10.0.9, que funciona, mas é uma diferença de versão que você não escolheu. A correção 1 continua sendo o melhor hábito.

### 3. Ou volte o Tools para 10.0.5

Voltar para a 10.0.5 restaura a antiga dependência de versão coincidente e é uma parada de emergência válida se você está no meio de uma entrega e não pode mexer em arquivos de projeto de forma ampla. Mas é um beco sem saída: a 10.0.5 é anterior a vários meses de correções de tooling, e qualquer atualização posterior te joga direto de volta na janela quebrada, a não ser que você também aplique a correção 1.

### 4. Central Package Management

Com CPM a versão fica em `Directory.Packages.props`, e vale a mesma regra: declare o Design lá e referencie-o a partir do projeto de inicialização.

```xml
<!-- Directory.Packages.props, EF Core 10.0.11 -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.11" />
</ItemGroup>
```

Uma entrada `PackageVersion` sozinha não adiciona o pacote. Ela só define a versão se algo o referenciar. Se o Design chega ao grafo transitivamente através do Tools, `CentralPackageTransitivePinningEnabled` definido como `true` vai elevar o Design transitivo para a versão que você declarou, o que é uma segunda linha de defesa razoável para uma solução grande.

## Como confirmar qual versão do Design a ferramenta vai carregar

Não confie no `dotnet ef --version`. Ele reporta a ferramenta global, que é independente do grafo do projeto:

```
$ dotnet ef --version
Entity Framework Core .NET Command-line Tools
10.0.11
```

Isso imprime 10.0.11 enquanto o projeto carrega o Design 8.0.0. Dois comandos dão a resposta real. O primeiro mostra a versão resolvida e quem a pediu:

```
$ dotnet nuget why . Microsoft.EntityFrameworkCore.Design
Project 'EfToolsRepro' has the following dependency graph(s) for
'Microsoft.EntityFrameworkCore.Design':

  [net10.0]
  └── Microsoft.EntityFrameworkCore.Tools (v10.0.6)
      └── Microsoft.EntityFrameworkCore.Design (v8.0.0)
```

`dotnet nuget why` precisa do SDK do .NET 9 ou posterior e é a forma mais rápida de descobrir qual pacote está arrastando o Design antigo, que nem sempre é o Tools. Qualquer biblioteca na sua solução que referencie o Design diretamente com um piso antigo pode fazer o mesmo.

A segunda verificação lê a saída de build, que é contra o que o tooling realmente resolve:

```
$ grep -o '"Microsoft.EntityFrameworkCore.Design/[0-9.]*"' bin/Debug/net10.0/Api.deps.json
"Microsoft.EntityFrameworkCore.Design/8.0.0"
```

Repare que o assembly do Design não é copiado para `bin`. Ele é resolvido a partir da pasta global de pacotes do NuGet pela entrada no `deps.json`, então procurar a DLL ao lado do seu executável não diz nada.

## Pegadinhas e erros parecidos

**Alguns comandos continuam funcionando, e é por isso que as pessoas descartam cedo demais um problema de pacotes.** Com Design 8.0.26 ao lado do EF Core 10.0.11, `dotnet ef dbcontext info` imprime o contexto, o provedor e a fonte de dados sem reclamar, e `dotnet ef dbcontext script` emite SQL correto. Só explodem os caminhos de código que tocam os tipos desalinhados. Não conclua que seu tooling está alinhado porque um comando retornou com sucesso.

**Leia a assinatura de `AddMigrationImpl` no stack trace.** Ela identifica a versão do Design carregada sem nenhuma investigação adicional. O Design 9.x tem um parâmetro `Boolean dryRun` que 8.x e 10.x não têm:

```
// Design 9.0.15
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace, Boolean dryRun)

// Design 8.0.26
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
```

**"Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design" é um erro diferente com uma causa vizinha.** Aquele significa que o Design está totalmente ausente, e não presente na versão errada. Vale saber que `Microsoft.EntityFrameworkCore.Tools` 11.0.0-preview.7.26381.103, publicado em 2026-08-11, declara um grupo de dependências `net10.0` vazio: nenhuma dependência do Design. Se você levar o hábito de referenciar só o Tools para uma atualização ao EF Core 11, vai encontrar [o erro de projeto de inicialização que não referencia o Design](/pt-br/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) em vez deste. O pin explícito da correção 1 cobre os dois.

**"Unable to create an object of type 'DbContext'" não tem relação.** Isso é um problema de factory de design ou de host builder, não uma diferença de versões. Se o seu stack trace menciona `DbContextActivator` ou um `IDesignTimeDbContextFactory` faltando, o que você quer é [o caminho de diagnóstico para a criação do DbContext](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), não esta página.

**`MissingMethodException` em tempo de execução da aplicação, e não em tempo de design.** Se a exceção dispara a partir da sua aplicação web e não do `dotnet ef`, o culpado normalmente é uma biblioteca compilada contra uma versão maior diferente do EF Core, não o pacote Design. O diagnóstico é o mesmo, porém: rode `dotnet nuget why` em `Microsoft.EntityFrameworkCore` e procure um pacote com um piso antigo.

**Um bundle de migrações herda o problema.** Como `dotnet ef migrations bundle` roda a mesma pilha de design para construir o executável, um grafo quebrado pode produzir um bundle a partir de um modelo desatualizado ou falhar de vez. Conserte a referência antes de gerar o artefato que você pretende rodar contra produção, como descrito no [passo a passo de implantação com bundle de migrações](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## O que fazer numa atualização para o EF Core 11

O EF Core 11 está em preview em setembro de 2026 e sai com o .NET 11 em novembro de 2026. Como o único SDK nesta máquina é o 10.0.302, toda a saída de comandos acima foi produzida contra o EF Core 10.0.11, não o 11. O que é verificável hoje pelo catálogo do NuGet é o formato das dependências: o Tools 11.0.0-preview.7 não tem nenhuma dependência de pacote. Trate `Microsoft.EntityFrameworkCore.Design` como um pacote que você sempre declara, na versão exata dos seus outros pacotes do EF Core, e essa classe de falha deixa de ser possível independentemente do que o Tools declarar. É uma mudança de uma linha que vale a pena fazer antes de começar [o trabalho mais amplo de migração para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), porque um comando de migrações que falha no meio de uma atualização é muito difícil de atribuir a um piso do NuGet.

A regra geral que este incidente ilustra: mantenha todos os pacotes `Microsoft.EntityFrameworkCore.*` numa mesma versão, incluindo os que você nunca faz `using`. O EF Core não suporta misturar versões maiores entre os próprios assemblies, e o tooling não te avisa quando o NuGet resolve silenciosamente um grafo que as mistura.

## Relacionados

- [Correção: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/pt-br/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)
- [Correção: dotnet tool install --global dotnet-ef lança um erro](/pt-br/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Correção: dotnet ef migrations add falha com "Unable to create an object of type DbContext"](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Como aplicar migrações do EF Core 11 em produção com um bundle de migrações](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Correção: "The model for context 'X' has pending changes" no EF Core 11](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)

## Fontes

- [dotnet/efcore#38124, anúncio: mudança de dependência do pacote Design no Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124)
- [dotnet/efcore#38107, exceção no Add-Migration: AbstractionsStrings.ArgumentIsEmpty](https://github.com/dotnet/efcore/issues/38107)
- [dotnet/efcore#38123, fechado como duplicado do 38107, com a variante TypeLoadException](https://github.com/dotnet/efcore/issues/38123)
- [Microsoft.EntityFrameworkCore.Tools no NuGet, grupos de dependências por versão](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tools/)
- [Referência das ferramentas do Entity Framework Core para a CLI do .NET](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [Referência do comando dotnet nuget why](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-why)
