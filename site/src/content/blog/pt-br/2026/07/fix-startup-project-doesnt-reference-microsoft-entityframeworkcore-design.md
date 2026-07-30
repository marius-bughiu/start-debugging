---
title: "Correção: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design"
description: "Adicione Microsoft.EntityFrameworkCore.Design ao projeto de inicialização que o dotnet ef compila, não ao projeto que contém seu DbContext, e passe -s em soluções em camadas."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
lang: "pt-br"
translationOf: "2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design"
translatedBy: "claude"
translationDate: 2026-07-30
---

Adicione o pacote ao **projeto de inicialização**, que é o projeto que o `dotnet ef` compila e executa, não à biblioteca de classes que contém seu `DbContext`: `dotnet add package Microsoft.EntityFrameworkCore.Design`. Em uma solução em camadas, também informe às ferramentas qual é esse projeto com `-s ./src/Api`. Desde o `Microsoft.EntityFrameworkCore.Tools` 10.0.6, o pacote Design não é mais trazido automaticamente.

```text
Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design. This package is required for the Entity Framework Core Tools to work. Ensure your startup project is correct, install the package, and try again.
```

Este artigo foi escrito contra o EF Core 11.0.0-preview.6 (`11.0.0-preview.6.26359.118`, 2026-07-14), o SDK do .NET 11 preview 6 e o C# 14, com observações sobre EF Core 9 e 10 nos pontos em que as ferramentas se comportam de forma diferente. A linha estável atual é a 10.0.10. O texto do erro não mudou desde o EF Core 2.1, mas **como** as ferramentas decidem que o pacote está ausente mudou bastante no EF Core 10, e isso determina qual das correções abaixo se aplica a você.

## Do que as ferramentas estão realmente reclamando

A mensagem parece uma verificação estática do seu `.csproj`. Não é. É uma falha de carregamento, relatada depois do fato.

Esta é a sequência real quando você executa `dotnet ef migrations add Init`:

1. O `dotnet-ef` roda uma compilação de metadados do projeto de inicialização. No EF Core 10 e 11 isso é `dotnet build --no-restore /getProperty:AssemblyName /getProperty:OutputPath ... /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems`.
2. Ele varre os `RuntimeCopyLocalItems` retornados procurando um `FullPath` que contenha `Microsoft.EntityFrameworkCore.Design` e guarda esse caminho absoluto.
3. Ele compila o projeto de inicialização e depois chama o `ef.dll`, passando o caminho encontrado como `--design-assembly`, junto com os arquivos `.deps.json` e `.runtimeconfig.json` do projeto, para que o processo da ferramenta emule o carregamento de assemblies da sua aplicação.
4. O `ef.dll` carrega `Microsoft.EntityFrameworkCore.Design.dll` em um `AssemblyLoadContext`: a partir desse caminho, se recebeu um, ou pelo nome do assembly caso contrário.
5. Se o passo 4 lança uma `FileNotFoundException` e o nome do assembly ausente é exatamente `Microsoft.EntityFrameworkCore.Design`, a ferramenta engole a exceção e imprime a mensagem amigável acima, nomeando o assembly de inicialização.

Duas consequências saem direto disso. Primeiro, o projeto nomeado na mensagem é o projeto **de inicialização**, então se esse nome te surpreende, seu problema está no passo 1 e não em um pacote ausente. Segundo, um `PackageReference` que existe mas não produz um ativo de runtime copiado localmente é invisível para o passo 2, e é por isso que as pessoas colam o `.csproj` em relatos de issue insistindo que o pacote está ali.

O EF Core 9 e anteriores funcionavam de outra forma: o `dotnet-ef` injetava um arquivo `EntityFrameworkCore.targets` embutido no projeto e o `ef.dll` resolvia o Design pelo nome do assembly através do `.deps.json` do projeto de inicialização. Essa distinção importa para um modo de falha específico coberto mais adiante.

## Reprodução mínima

Uma solução em camadas com dois projetos, que é o layout que produz esse erro com mais frequência:

```text
Shop.sln
  src/Shop.Api/Shop.Api.csproj          <- startup project, has Program.cs
  src/Shop.Data/Shop.Data.csproj        <- has AppDbContext and Migrations/
```

```xml
<!-- src/Shop.Data/Shop.Data.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

```xml
<!-- src/Shop.Api/Shop.Api.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Data/Shop.Data.csproj" />
  </ItemGroup>
</Project>
```

```bash
# .NET 11 SDK preview 6
cd src/Shop.Data
dotnet ef migrations add Init -s ../Shop.Api
# Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design.
```

O pacote Design está referenciado. Está referenciado no projeto errado, e não pode viajar.

## Correção 1: referencie o Design no projeto de inicialização

Essa é a correção em quase todos os casos. Execute a partir do diretório do projeto de inicialização:

```bash
# .NET 11 SDK preview 6, EF Core 11
dotnet add src/Shop.Api/Shop.Api.csproj package Microsoft.EntityFrameworkCore.Design
```

O NuGet escreve isto, porque o Design é marcado como `developmentDependency` no seu nuspec:

```xml
<!-- src/Shop.Api/Shop.Api.csproj - EF Core 11.0.0-preview.6 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

Leia essa lista de `IncludeAssets` com atenção, porque ela explica as duas metades do problema:

- `runtime` **está** na lista. É isso que coloca o `Microsoft.EntityFrameworkCore.Design.dll` na sua pasta `bin` e, portanto, dentro dos `RuntimeCopyLocalItems`, que é o que as ferramentas procuram. Não remova.
- `compile` **não** está na lista. Você não pode referenciar tipos do Design a partir do código da sua aplicação, o que é intencional: é um pacote de tempo de design e nada do seu código de produção deveria se ligar a ele.
- `PrivateAssets: all` significa que a referência **não flui transitivamente**. Essa é toda a razão pela qual a Correção 1 existe como um passo separado de ter o pacote no seu projeto de dados.

## Correção 2: aponte as ferramentas para o projeto de inicialização correto

Se o nome do projeto no erro não é o projeto que você queria, o pacote está certo e o alvo está errado. A regra, conforme a documentação da CLI do EF Core: o *projeto de destino* é onde os arquivos são escritos (`--project`, `-p`, padrão é o diretório atual), e o *projeto de inicialização* é aquele que as ferramentas compilam e executam para descobrir sua string de conexão e seu modelo (`--startup-project`, `-s`, também padrão o diretório atual).

```bash
# EF Core 11, run from the repository root
dotnet ef migrations add Init -p src/Shop.Data -s src/Shop.Api
```

Digitar isso em cada comando é como as equipes acabam pregando o pacote no projeto errado só para o erro sumir. O EF Core 11 adiciona um arquivo de configuração exatamente para isso, descoberto subindo do diretório atual até o primeiro `.config/dotnet-ef.json` que encontrar:

```json
{
  "project": "src/Shop.Data",
  "startupProject": "src/Shop.Api"
}
```

Caminhos relativos são resolvidos em relação ao diretório pai do diretório `.config`, então coloque o arquivo na raiz do repositório e qualquer invocação de `dotnet ef` a partir de qualquer subdiretório vai usá-lo. Opções explícitas de linha de comando continuam vencendo o arquivo. Apenas as chaves documentadas são aceitas: `project`, `startupProject`, `context`, `framework`, `configuration`, `runtime`, `verbose`, `noColor`, `prefixOutput`. Uma chave desconhecida é um erro fatal, não um aviso, então um typo como `startProject` faz o comando falhar por completo.

## Correção 3: pare de tentar fazer a referência do projeto de dados fluir

De vez em quando alguém encontra este truque, e ele funciona:

```xml
<!-- src/Shop.Data/Shop.Data.csproj - do not do this -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>none</PrivateAssets>
</PackageReference>
```

Definir `PrivateAssets` como `none` faz a referência fluir transitivamente até o `Shop.Api`, e o erro desaparece. Também arrasta o Roslyn para todo projeto que referencie sua camada de dados, porque o Design depende de `Microsoft.CodeAnalysis.CSharp` e `Microsoft.CodeAnalysis.CSharp.Workspaces` (5.0.0 ou posterior no pacote 10.0.10), além de `Microsoft.Build.Framework`, `Humanizer.Core`, `Mono.TextTemplating` e `Newtonsoft.Json`. Você moveu uma cadeia de geração de código para o seu grafo de dependências de runtime para economizar uma linha em um `.csproj`. Prefira a referência explícita no projeto de inicialização.

## A variante de versões incompatíveis desde o Tools 10.0.6

Se você instala o `Microsoft.EntityFrameworkCore.Tools` (o módulo do Package Manager Console) esperando que ele traga o Design junto, essa suposição expirou. Antes do 10.0.6, o Tools dependia de uma versão correspondente do Design. Isso quebrava o restore em projetos que miravam `net8.0`, porque o Design 10.0.x só mira `net10.0`, então o time do EF baixou o piso para Design 8.0.0 no Tools 10.0.6. No branch do EF Core 11, o `Microsoft.EntityFrameworkCore.Tools` não carrega nenhum `PackageReference` para o Design.

O resultado prático é que o NuGet agora pode resolver uma versão antiga do Design que satisfaz o piso, e o sintoma não é este erro, e sim:

```text
System.MissingMethodException: Method not found ...
System.TypeLoadException: Could not load type ...
```

A correção é uma referência explícita com versão correspondente. Com gerenciamento centralizado de pacotes, fixe uma única vez:

```xml
<!-- Directory.Packages.props - EF Core 11.0.0-preview.6 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

O gerenciamento centralizado de pacotes também tem sua própria armadilha aqui: uma entrada `PackageVersion` no `Directory.Packages.props` não é uma referência. O projeto de inicialização ainda precisa de `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" />` sem o atributo `Version`. Mantenha o próprio `dotnet-ef` em sintonia também, porque uma ferramenta 10.x dirigindo um assembly Design 11.x é uma classe de falha à parte:

```bash
dotnet tool update --global dotnet-ef --version 11.0.0-preview.6.26359.118
```

## Quando a referência está lá e ainda assim falha

Execute a mesma consulta que as ferramentas executam e olhe a resposta você mesmo. O switch `-getItem` exige o SDK do .NET 8 ou posterior:

```bash
# .NET 11 SDK preview 6
dotnet build src/Shop.Api/Shop.Api.csproj --no-restore \
  /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems
```

Se `Microsoft.EntityFrameworkCore.Design.dll` não estiver nesse JSON, o EF Core 10 e 11 não conseguem vê-lo, não importa o que o `.csproj` diga. Os culpados de sempre são atributos de fluxo de ativos que alguém copiou de um pacote que traz apenas analisadores:

- `<ExcludeAssets>runtime</ExcludeAssets>` ou `<ExcludeAssets>all</ExcludeAssets>` na referência ao Design.
- Uma lista `<IncludeAssets>` que deixa `runtime` de fora, por exemplo `build; analyzers`.
- `<PackageReference ... GeneratePathProperty="true" ExcludeAssets="all" />`, um padrão que aparece quando alguém quer apenas o diretório de ferramentas do pacote.

Adicione `-v` para ver o relato da própria ferramenta sobre o que ela resolveu. A saída detalhada imprime o comando completo da compilação de metadados e o caminho do assembly Design que ela escolheu, o que transforma um jogo de adivinhação em um diagnóstico de duas linhas:

```bash
dotnet ef migrations add Init -s src/Shop.Api -v
```

O único caso em que um `.csproj` correto realmente não bastava: no EF Core 9 com certas compilações do SDK do .NET 9, o [dotnet/sdk#45259](https://github.com/dotnet/sdk/pull/45259) deixou de emitir para o `.deps.json` as entradas `PackageReference` marcadas com `PrivateAssets="all"`. Como o `ef.dll` do EF Core 9 resolvia o Design pelo nome do assembly através desse arquivo, as ferramentas perdiam o pacote ([dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265), com a [#35544](https://github.com/dotnet/efcore/issues/35544) como uma de suas duplicatas). Foi corrigido no EF Core 10 pelo [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527), que registra um handler `AssemblyLoadContext.Resolving` que sonda o caminho base da aplicação, ao lado do caminho explícito `--design-assembly` descrito antes. Se você está preso em um projeto de EF Core 9 batendo nisso, atualizar a ferramenta global `dotnet-ef` para 10 ou posterior é suficiente, porque as ferramentas são independentes da versão dos pacotes de runtime que dirigem.

## Armadilhas e falsos parecidos

**Projetos gerados sem o pacote.** As primeiras compilações do SDK do .NET 11 preview 3 geravam projetos de `dotnet new mvc --auth Individual` sem referência ao Design, uma regressão em relação ao preview 2 registrada como [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750). Parou de reproduzir a partir do SDK `11.0.100-preview.3.26166.111`. Se um projeto foi gerado nessa janela, o template é o culpado e a Correção 1 é tudo de que você precisa.

**Uma biblioteca de classes `netstandard2.0` como projeto de inicialização.** As ferramentas precisam executar código da aplicação, o que exige um runtime real, e o .NET Standard é uma especificação, não uma implementação. Adicionar o Design não vai ajudar. Crie um projeto de console descartável que referencie a biblioteca e use-o como `-s`.

**Um target framework específico de plataforma.** Com `net11.0-android` ou `net11.0-ios` você recebe uma mensagem diferente sobre um framework específico de plataforma, e a resposta documentada é implementar `IDesignTimeDbContextFactory<TContext>` para que as ferramentas nunca precisem inicializar sua aplicação.

**`NETSDK1004` na saída detalhada.** A compilação de metadados roda com `--no-restore`. Se o projeto nunca foi restaurado, o `dotnet-ef` relata que um restore é necessário em vez de um pacote ausente. Execute `dotnet restore` e tente de novo.

**Multi-targeting.** O `dotnet-ef` escolhe o primeiro target framework e se reinvoca. Se o Design está condicionado a um TFM e o primeiro não é ele, passe `--framework net11.0` explicitamente.

**`Unable to create an object of type 'AppDbContext'`.** Erro diferente, causa diferente. O assembly Design carregou bem e depois as ferramentas não conseguiram instanciar seu contexto. Isso é coberto em [o guia sobre descoberta de DbContext em tempo de design](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

**Contêineres de CI.** A imagem `dotnet/sdk`, não `dotnet/aspnet`, e `dotnet tool install --global dotnet-ef` antes de qualquer chamada a `dotnet ef`. Se seu pipeline só precisa aplicar migrações e não criá-las, dispense a ferramenta por completo e entregue um bundle de migrações.

## O layout que nunca cai nisso

Quatro regras, e esse erro para de aparecer na sua solução:

1. `Microsoft.EntityFrameworkCore.Design` é referenciado pelo projeto de inicialização, com os `PrivateAssets` e `IncludeAssets` padrão que o `dotnet add package` escreve.
2. O pacote do provedor (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL` e assim por diante) é alcançável a partir do projeto de inicialização, e transitivamente através do projeto de dados está tudo bem.
3. Todas as versões dos pacotes do EF Core e a versão da ferramenta `dotnet-ef` são iguais, idealmente fixadas em `Directory.Packages.props`.
4. O `.config/dotnet-ef.json` registra `project` e `startupProject` para que ninguém precise lembrar de `-p` e `-s`.

## Relacionados

- [Por que as ferramentas de tempo de design não conseguem instanciar seu DbContext](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) cobre o erro que você encontra imediatamente depois de resolver este.
- [Entregando mudanças de esquema com bundles de migração](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) é o comando de tempo de design que este pacote também condiciona, e a forma de manter o `dotnet-ef` fora das máquinas de produção.
- [O PendingModelChangesWarning e o que ele realmente detecta](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) é a próxima coisa que a CI vai te contar depois que as migrações rodarem.
- [Registrando DbContextOptions corretamente](/pt-br/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) explica a falha do lado da injeção de dependência que se parece com esta em uma solução em camadas.
- [Mudanças que quebram ao ir do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) inclui as mudanças de tooling que vale conhecer antes de atualizar.

## Fontes

- [Referência de ferramentas do EF Core (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), incluindo as regras de projeto de destino versus projeto de inicialização e o arquivo de configuração `dotnet-ef.json` do EF Core 11.
- [Arquitetura das ferramentas de tempo de design](https://learn.microsoft.com/en-us/ef/core/miscellaneous/internals/tools) para a cadeia de `dotnet-ef` a `ef.dll` a `EFCore.Design.dll`.
- [`src/dotnet-ef/Project.cs`](https://github.com/dotnet/efcore/blob/main/src/dotnet-ef/Project.cs) e [`src/ef/Commands/ProjectCommandBase.cs`](https://github.com/dotnet/efcore/blob/main/src/ef/Commands/ProjectCommandBase.cs) para a busca em `RuntimeCopyLocalItems` e o ponto exato em que a `FileNotFoundException` se transforma nesta mensagem.
- [Anúncio: mudança de dependência do pacote Design no Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124).
- [dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265) e [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527) para a regressão de `.deps.json` e `PrivateAssets`.
- [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750) para a regressão de templates do .NET 11 preview 3.
