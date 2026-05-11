---
title: "Fix: The type or namespace name 'X' could not be found (depois de adicionar uma referência de projeto)"
description: "CS0246 logo após um ProjectReference recém-adicionado quase sempre é um descompasso de TargetFramework, uma pasta obj/ desatualizada ou uma diretiva using ausente. Cinco correções em ordem de probabilidade."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "pt-br"
translationOf: "2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference"
translatedBy: "claude"
translationDate: 2026-05-11
---

A correção: nove em cada dez vezes, o seu projeto consumidor mira um `TargetFramework` menor do que o projeto referenciado (então o pack do SDK nem tenta resolver o assembly), os diretórios `obj/` e `bin/` da compilação anterior ainda apontam para o reference assembly errado, ou o tipo compilou limpo mas falta uma diretiva `using` no ponto de chamada. Abra os dois arquivos `.csproj`, alinhe os valores de `TargetFramework`, rode `dotnet build --no-incremental` (ou apague `obj/` e `bin/` na mão no Windows) e só então comece a olhar para as diretivas `using`. O texto da exceção e a causa não mudaram entre .NET 6 e .NET 11 preview 4, então o mesmo checklist se aplica a qualquer projeto SDK-style moderno.

```text
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?)
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'MyApp.Domain' (are you missing an assembly reference?)
```

Os dois códigos dividem a mesma causa raiz por uma linha estreita: `CS0246` significa que o compilador não consegue encontrar um tipo de nível superior pelo nome curto; `CS0234` significa que ele encontrou o namespace mas não conseguiu enxergar o membro aninhado. Ambos disparam assim que o compilador C# pergunta ao Roslyn por um símbolo que o leitor de metadados não consegue resolver, o que num build SDK-style acontece depois que o MSBuild termina de montar a lista de referências. Se essa lista está errada, o compilador é a camada errada para depurar.

Este guia é escrito contra .NET SDK 11.0.100-preview.4, MSBuild 17.13 e Roslyn 4.13. O comportamento é idêntico no .NET 8 LTS e no .NET 10. Os códigos de erro do compilador estão estáveis desde que o Roslyn foi lançado, então as correções se aplicam a toda versão de C# de 7.0 em diante.

## Por que o compilador não enxerga o tipo depois de adicionar um `ProjectReference`

Há cinco causas recorrentes, e elas devem ser checadas nesta ordem. As três primeiras explicam a vasta maioria do tráfego de busca que cai na mensagem exata acima.

1. **Descompasso de TargetFramework.** Seu consumidor é `net8.0` e o projeto referenciado é `net11.0`, ou seu consumidor é `netstandard2.0` e o projeto referenciado é `net8.0`. O MSBuild faz a coisa certa aqui e se recusa a conectar a referência, mas o aviso que ele emite (`NU1201` do NuGet ou `NETSDK1005` do SDK) é fácil de passar batido na saída do build. O erro C# que dispara em seguida é o CS0246, que é o sintoma que você notou.
2. **`obj/` e `bin/` desatualizados.** Builds incrementais no MSBuild são agressivos. Depois de editar um `.csproj`, o assets file (`obj/project.assets.json`) e os response files (`obj/*.csproj.AssemblyReference.cache`) podem discordar do novo grafo. O Roslyn compila feliz contra o conjunto antigo de referências e você ganha CS0246 para um tipo que existe em disco.
3. **Diretiva `using` ausente.** Você adicionou a referência corretamente, o tipo existe e o build está limpo, mas o ponto de chamada não importa o namespace. Com `ImplicitUsings` habilitado isso é raro para a BCL, mas é a regra para os seus próprios namespaces. A dica do compilador no final do CS0246, `(are you missing a using directive or an assembly reference?)`, lista essa opção em primeiro por um motivo.
4. **O projeto não está na solution.** O Visual Studio e `dotnet build <solution>` só compilam projetos que o arquivo `.sln` conhece. Você pode adicionar um `ProjectReference` para um `.csproj` que não está na solution, e o consumidor falhará em encontrar o tipo porque o produtor nunca foi compilado. `dotnet build <consumer.csproj>` funciona porque ele percorre o grafo de projetos diretamente; o IDE falha porque ele percorre a solution.
5. **`ReferenceOutputAssembly="false"` ou `PrivateAssets="all"` na referência.** Ambos são metadados legítimos, usados para suprimir o fluxo transitivo ou para passar referências só de build como analisadores, mas cada um diz ao MSBuild para não adicionar o assembly produzido à lista de referências do compilador. O IDE em geral mostra o projeto como referenciado no Solution Explorer, o que torna esse caso o mais lento de detectar.

Há causas de menor incidência que vale nomear para você descartar por inspeção: um sistema de arquivos sensível a maiúsculas (Linux, macOS) onde a diretiva `using` não bate exatamente com a capitalização do namespace; um ItemGroup `Conditional` que exclui a referência para a `Configuration` ou o `TargetFramework` atual; um consumidor multi-target (`<TargetFrameworks>net8.0;net11.0</TargetFrameworks>`) em que só um dos builds internos pega a referência; e um global.json fixando uma versão de SDK mais antiga que o mínimo do `TargetFramework` do consumidor.

## O erro em contexto

É assim que a saída do build aparece quando a causa é o descompasso de TargetFramework. Preste atenção às linhas antes do CS0246, não ao próprio CS0246:

```text
warning NU1201: Project Domain is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Project Domain supports: net11.0 (.NETCoreApp,Version=v11.0)
warning MSB3277: Found conflicts between different versions of "System.Runtime" that could not be resolved.
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?) [C:\src\Api\Api.csproj]
```

`NU1201` é a arma fumegante. A etapa de restore do NuGet encontrou o projeto mas o rejeitou porque o conjunto de target frameworks dele não contém nada que o consumidor consiga consumir. O compilador então rodou com referência vazia para aquele projeto. O CS0246 é efeito colateral, não o bug.

## Reprodução mínima

A menor configuração de dois projetos que reproduz o descompasso de TargetFramework. Salve como `Domain/Domain.csproj` e `Api/Api.csproj`:

```xml
<!-- Domain/Domain.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```xml
<!-- Api/Api.csproj - .NET 8 LTS consumer of a net11.0 library -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Domain\Domain.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Domain/OrderService.cs - .NET 11 preview 4
namespace MyApp.Domain;

public sealed class OrderService
{
    public string Greet(int id) => $"order-{id}";
}
```

```csharp
// Api/Program.cs - .NET 8 LTS
using MyApp.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderService>();

var app = builder.Build();
app.MapGet("/", (OrderService svc) => svc.Greet(1));
app.Run();
```

Rode `dotnet build Api/Api.csproj` e você obtém o par de erros exato da seção anterior. O CS0246 é barulhento; o aviso `NU1201` logo acima é a falha real.

## Correção um: alinhe os valores de TargetFramework

O movimento mais seguro é atualizar o consumidor em vez de rebaixar a biblioteca, porque rebaixar tipicamente perde APIs:

```xml
<!-- Api/Api.csproj - now .NET 11 to match the library -->
<TargetFramework>net11.0</TargetFramework>
```

Se você não pode mover o consumidor, multi-target a biblioteca para que ela entregue um assembly para os dois:

```xml
<!-- Domain/Domain.csproj -->
<TargetFrameworks>net8.0;net11.0</TargetFrameworks>
```

Para bibliotecas genuinamente framework-neutras, `netstandard2.0` ainda é o target mais amplo e é consumível a partir de .NET Framework 4.7.2+, Mono, Unity e qualquer .NET moderno. Escolha `netstandard2.0` apenas quando a superfície de API couber dentro dele; caso contrário, multi-targeting `net8.0` + `net11.0` é a opção mais limpa em 2026.

Uma nota sobre `<TargetFrameworks>` com um único valor: escreva `<TargetFramework>` (singular). O MSBuild trata como propriedades diferentes, e um projeto com `<TargetFrameworks>net8.0</TargetFrameworks>` compila para `bin/<config>/net8.0/` em vez de `bin/<config>/`, o que silenciosamente quebra ferramentas downstream que assumem o layout plano.

## Correção dois: apague `obj/` e `bin/` depois de editar o `.csproj`

Se os frameworks batem mas o erro persiste, o cache do build está obsoleto. O Roslyn lê `obj/<project>.csproj.AssemblyReference.cache` e o `*.GeneratedMSBuildEditorConfig.editorconfig` por projeto para encurtar a resolução de referências. Se você editou o `.csproj` para adicionar o `ProjectReference` enquanto um build anterior ainda está residente, o cache discorda do novo grafo e o compilador roda contra a lista antiga de referências.

O reset correto no .NET 11 é `dotnet build --no-incremental` para uma recompilação limpa pontual ou, no caso raro em que isso não basta, remova manualmente as pastas de build:

```powershell
# .NET SDK 11.0.100-preview.4, PowerShell on Windows
Get-ChildItem -Path . -Include obj,bin -Recurse -Directory | Remove-Item -Recurse -Force
dotnet build
```

```bash
# .NET SDK 11.0.100-preview.4, bash on Linux/macOS
find . -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
dotnet build
```

`dotnet clean` é deliberadamente conservador: ele remove as saídas mas mantém o assets file, o que significa que nem sempre cura essa classe de bug. Trate-o como um reset parcial, não completo. Se você está com um IDE aberto ao mesmo tempo, feche-o antes de apagar `obj/` porque no Windows o language service mantém handles de arquivo abertos e o delete vai falhar na metade dos diretórios.

## Correção três: adicione ou corrija a diretiva `using`

Uma vez que a referência está saudável, o compilador consegue achar o tipo, mas você ainda precisa importar o namespace dele no ponto de chamada. A correção é mecânica:

```csharp
// Api/Program.cs - .NET 11 preview 4
using MyApp.Domain;        // the namespace declared inside Domain/OrderService.cs
// using MyApp.Domain.Models; // for the CS0234 variant where you also need the nested namespace
```

Duas sutilezas mordem os times a cada release. Primeira, `<ImplicitUsings>enable</ImplicitUsings>` adiciona um conjunto fixo de namespaces (`System`, `System.Collections.Generic`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks` e os extras específicos do SDK) mas não importa seus próprios namespaces. Segunda, desde C# 10 você pode declarar global usings para preencher essa lacuna:

```xml
<!-- Api/Api.csproj - .NET 11 preview 4 -->
<ItemGroup>
  <Using Include="MyApp.Domain" />
</ItemGroup>
```

Isso emite um `GlobalUsings.g.cs` em `obj/` e poupa a linha `using` por arquivo em todos os lugares onde `OrderService` é consumido. O custo é que global usings tornam refatorações mais barulhentas: um typo em um namespace global derruba o projeto inteiro, e uma biblioteca removida agora se esconde como uma única edição de MSBuild em vez de uma onda de sublinhados vermelhos. Use-os com critério, não por reflexo.

## Correção quatro: confirme que o projeto está na solution

`dotnet sln list` é o jeito mais rápido de verificar. Se o seu consumidor é `Api/Api.csproj` e a sua biblioteca é `Domain/Domain.csproj`, ambos devem aparecer no `.sln`:

```bash
# .NET SDK 11.0.100-preview.4
dotnet sln list
# Project(s)
# ----------
# Api\Api.csproj
# Domain\Domain.csproj   <-- must be here
```

Se `Domain` faltar, o IDE parecerá conhecê-lo (porque o `ProjectReference` o resolve em disco), mas builds com escopo de solution pulam ele e aí uma recompilação de projeto único falha porque o `obj/project.assets.json` do consumidor referencia um assembly que ninguém produziu. Adicione o projeto faltante:

```bash
dotnet sln add Domain/Domain.csproj
```

Essa armadilha é mais comum em 2026 do que era quando `slnx` e o novo formato leve de solution chegaram no SDK do .NET 11. A CLI tolera compilar uma solution que lista projetos com grafos de referência disjuntos, e os language services no Visual Studio 2026 e no Rider 2026.1 melhoraram em avisar quando um projeto referenciado está fora da solution ativa. Se você está em um SDK mais antigo, o aviso é silencioso. Para ergonomia de arquivo de solution em geral, vale dar uma olhada na nova CLI: veja [as melhorias do dotnet sln CLI no .NET 11](/pt-br/2026/04/dotnet-11-sln-cli-solution-filters/).

## Correção cinco: cheque `ReferenceOutputAssembly` e `PrivateAssets`

Algumas referências deliberadamente não são propagadas ao compilador. Os dois itens de metadados para checar no `ProjectReference` são:

```xml
<!-- Will NOT add Domain.dll to the compiler's reference list -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  ReferenceOutputAssembly="false" />

<!-- Will not flow transitively to projects that consume the consumer -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  PrivateAssets="all" />
```

`ReferenceOutputAssembly="false"` é correto quando o projeto referenciado é uma ferramenta de tempo de build (um gerador de código, um host de analisadores) cuja saída você quer sequenciada no grafo de build mas cujo assembly você não consome. Se ele estiver setado na sua referência real de biblioteca, o consumidor falha CS0246 mesmo com o grafo de build saudável.

`PrivateAssets="all"` é o caso simétrico para referências transitivas. Se `Api` referencia `Bff`, e `Bff` referencia `Domain` com `PrivateAssets="all"`, então `Api` não consegue ver tipos de `Domain` mesmo que `Bff` consiga. A dica está no projeto que consome, não no que produz.

## Variantes que parecem o mesmo erro

Um punhado de erros vizinhos é confundido com CS0246 nos resultados de busca:

- **`CS1069`: The type name 'X' could not be found in the namespace 'Y'. This type has been forwarded to assembly 'Z'.** Falta um type-forwarder. Adicione o assembly nomeado na mensagem. Mais comum com `System.Configuration.ConfigurationManager` e `System.Drawing.Common` no .NET moderno.
- **`CS8073` / `CS0518`: Predefined type 'System.Object' is not defined or imported.** A referência implícita ao `System.Runtime` está quebrada. Quase sempre um `obj/` corrompido ou um `<Reference>` escrito à mão que exclui o framework. `dotnet build --no-incremental` é a primeira tentativa.
- **`CS0433`: The type 'X' exists in both 'A' and 'B'.** Dois assemblies expõem o mesmo tipo. Resolva com um alias no `ProjectReference` (`<ProjectReference Include="..." Aliases="domain" />`) e uma diretiva `extern alias` no ponto de chamada.
- **`NETSDK1005`: Assets file '...' doesn't have a target for 'net8.0'.** A referência é a um pacote NuGet compilado para um framework mais alto que o do consumidor. Mesma causa raiz da Correção um acima, mensagem diferente porque o produtor é um pacote, não um projeto.
- **`MSB4181`: The "ResolvePackageAssets" task returned false but did not log an error.** Uma falha de restore genuína; o grafo de pacotes é insolúvel. Apague o cache global `~/.nuget/packages/<name>/<version>/` do pacote infrator e restaure de novo. Trate isso como ortogonal ao CS0246, embora os dois frequentemente coocorram.

## Como ler a saída do build para confirmar a correção

Vire sua depuração para o log do build em vez da lista de erros do C#. O compilador é o lugar errado para começar quando a resolução de referências está quebrada. Três comandos valem o seu peso:

```bash
# .NET SDK 11.0.100-preview.4
dotnet build -v:n Api/Api.csproj
```

`-v:n` (`-verbosity normal`) imprime a lista de referências resolvidas em `CoreCompile -> ResolveReferences`. Se sua biblioteca não está nessa lista, o compilador nunca a viu e você tem um problema de MSBuild, não de Roslyn.

```bash
dotnet build -bl Api/Api.csproj
```

`-bl` escreve um `msbuild.binlog` ao lado do projeto. Abra-o no [MSBuild Structured Log Viewer](https://msbuildlog.com/) e busque por `ResolveAssemblyReferences`. O visor mostra exatamente quais caminhos de arquivo o MSBuild entregou ao Roslyn e por que cada um foi incluído ou pulado.

```bash
dotnet msbuild Api/Api.csproj -t:ResolveReferences -p:DesignTimeBuild=false
```

Isso roda o target de resolução de referências isoladamente, sem invocar o compilador. A saída é concisa e te diz se a falha está no restore, na resolução ou na compilação. CS0246 some do ruído.

## Casos de borda que pegam desenvolvedores experientes

Alguns padrões reproduzem CS0246 em código que parece correto à inspeção:

- **`Directory.Packages.props` com `ManagePackageVersionsCentrally=true`.** Se você esqueceu de adicionar uma entrada `<PackageVersion>` para um pacote transitivo que sua biblioteca expõe na API, o consumidor não consegue resolver o tipo a partir da dependência transitiva. A mensagem é CS0246, não o erro de versão faltante que você esperaria.
- **Multi-targeting com `Condition`.** `<ProjectReference Include="..." Condition="'$(TargetFramework)' == 'net11.0'" />` vai pular a referência para o build interno `net8.0` de um consumidor multi-target. O IDE mostra a referência; o build de `net8.0` não vê o tipo.
- **`global.json` fixando um SDK que não tem seu `TargetFramework`.** Se o `global.json` seleciona o SDK 8.0.x e o projeto mira `net11.0`, o restore reporta um aviso benigno, o build falha CS0246 para todo tipo da biblioteca referenciada porque os packs do SDK não estão instalados para `net11.0`.
- **Sensibilidade a maiúsculas no Linux.** `using MyApp.domain;` em vez de `using MyApp.Domain;` compila no Windows e falha CS0246 em CI no Linux. Adicione `<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` e trave a capitalização com uma regra do `.editorconfig`.
- **Consumidores Native AOT.** Se `<PublishAot>true</PublishAot>` está setado no consumidor mas não na biblioteca, o analisador AOT marca os avisos transitivos de trim como erros e o build pode parar em um CS0246 downstream uma vez que um tipo é podado. A correção é marcar a biblioteca como trim-safe, não silenciar o analisador. A mesma disciplina de trim que o [post sobre PlatformNotSupportedException em Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/) cobre se aplica aqui.

## Relacionado

- A próxima exceção de resolução de referências em que os times caem depois desta é a variante de tempo de execução coberta em [Unable to resolve service for type 'X' while attempting to activate 'Y'](/pt-br/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Ergonomia do arquivo de solution que torna essa classe de bug mais fácil de detectar: [as mudanças do dotnet sln CLI no .NET 11](/pt-br/2026/04/dotnet-11-sln-cli-solution-filters/).
- Os casos de canto do Native AOT que trazem o CS0246 à tona indiretamente via trimming: [PlatformNotSupportedException em Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/).
- Uma política de avisos de build que impede avisos silenciosos `NU1201` de se esconderem sob um CI verde: [TreatWarningsAsErrors sem sabotar builds de dev](/pt-br/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).
- Quando o tipo faltante é um valor de configuração e a mensagem é parecida em espírito: [no connection string named 'DefaultConnection' could be found](/pt-br/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fontes

- Microsoft Learn, [Compiler Error CS0246](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0246).
- Microsoft Learn, [Compiler Error CS0234](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0234).
- Microsoft Learn, [MSBuild ProjectReference protocol](https://learn.microsoft.com/en-us/visualstudio/msbuild/common-msbuild-project-items#projectreference).
- Microsoft Learn, [Implicit using directives in .NET 6+](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview#implicit-using-directives).
- Microsoft Learn, [global.json overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
- MSBuild source, [`Microsoft.Common.CurrentVersion.targets`](https://github.com/dotnet/msbuild/blob/main/src/Tasks/Microsoft.Common.CurrentVersion.targets), where `ResolveProjectReferences` lives.
