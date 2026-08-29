---
title: "Migrar uma solução .NET para o Central Package Management com Directory.Packages.props"
description: "Mova todas as versões de pacotes dos seus arquivos csproj para um único Directory.Packages.props. Cobre um script gerador que reconcilia versões conflitantes com ordenação semver de verdade, o diff do grafo de dependências antes/depois que comprova o que mudou, NU1008/NU1010/NU1013/NU1507, fixação transitiva, GlobalPackageReference, VersionOverride e por que um Directory.Packages.props aninhado sobrepõe silenciosamente o da raiz."
pubDate: 2026-08-28
template: migration
tags:
  - "migration"
  - "dotnet"
  - "nuget"
  - "csharp"
lang: "pt-br"
translationOf: "2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props"
translatedBy: "claude"
translationDate: 2026-08-28
---

O Central Package Management tira todos os atributos `Version` dos seus arquivos `.csproj` e os coloca em um único `Directory.Packages.props` na raiz do repositório. Ative-o com `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`, declare um `<PackageVersion Include="..." Version="..." />` para cada pacote que a solução usa e remova o atributo `Version` de cada `<PackageReference>`. A migração em si é mecânica e automatizável. A parte que precisa de uma pessoa é reconciliar os pacotes fixados em versões diferentes em projetos diferentes, porque consolidá-los é uma mudança real de comportamento, não uma mudança de formatação. Tudo abaixo foi verificado contra o SDK do .NET 10 10.0.302 com o NuGet 7.6.0 incluído.

## O que realmente muda

Antes, cada projeto é dono das suas versões:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
</ItemGroup>
```

Depois, o projeto declara apenas *do que* depende, e o arquivo raiz decide *qual versão*:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" />
</ItemGroup>
```

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

O `Directory.Packages.props` é descoberto subindo *para cima* a partir do diretório de cada projeto, do mesmo jeito que o `Directory.Build.props`. Ele não precisa ficar ao lado do arquivo de solução, e nada o importa explicitamente. Repare que apenas a versão se move. `PrivateAssets`, `IncludeAssets` e `ExcludeAssets` continuam no `PackageReference` do projeto que precisa deles, porque são decisões por projeto.

## Passos

1. Crie o `Directory.Packages.props` na raiz do repositório com `ManagePackageVersionsCentrally` definido como `true`.
2. Colete a versão de cada `PackageReference` de cada projeto e emita um item `PackageVersion` por identificador de pacote.
3. Resolva os pacotes que aparecem em mais de uma versão. Este é o único passo que não é mecânico.
4. Remova o atributo `Version` de cada `PackageReference` de cada projeto.
5. Restaure e compare o grafo de dependências resolvido com aquele que você capturou antes de começar.

## Gerando o arquivo a partir do que você já tem

Um aplicativo C# baseado em arquivo cai bem aqui: um único arquivo, sem projeto, e o `dotnet run` o executa diretamente. Capture as versões, informe os conflitos, escreva o arquivo de propriedades e então remova os atributos.

```csharp
// migrate-to-cpm.cs -- execute com: dotnet run migrate-to-cpm.cs .
#:property ManagePackageVersionsCentrally=false
#:package NuGet.Versioning@6.*

using System.Xml.Linq;
using NuGet.Versioning;

var root = args.Length > 0 ? args[0] : ".";
var projects = Directory.GetFiles(root, "*.csproj", SearchOption.AllDirectories);
var versions = new Dictionary<string, SortedSet<NuGetVersion>>(StringComparer.OrdinalIgnoreCase);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        var id = (string?)reference.Attribute("Include") ?? (string?)reference.Attribute("Update");
        var version = (string?)reference.Attribute("Version") ?? (string?)reference.Element("Version");
        if (id is null || version is null) continue;
        if (!versions.TryGetValue(id, out var set))
            versions[id] = set = new SortedSet<NuGetVersion>();
        if (NuGetVersion.TryParse(version, out var parsed)) set.Add(parsed);
    }
}

foreach (var (id, set) in versions.Where(v => v.Value.Count > 1))
    Console.WriteLine($"conflict: {id} -> {string.Join(", ", set)}");

var props = new XElement("Project",
    new XElement("PropertyGroup",
        new XElement("ManagePackageVersionsCentrally", true),
        new XElement("CentralPackageTransitivePinningEnabled", true)),
    new XElement("ItemGroup",
        versions.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase)
                .Select(v => new XElement("PackageVersion",
                    new XAttribute("Include", v.Key),
                    new XAttribute("Version", v.Value.Max()!)))));

File.WriteAllText(Path.Combine(root, "Directory.Packages.props"), props + Environment.NewLine);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    var changed = false;
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        if (reference.Attribute("Version") is { } attribute) { attribute.Remove(); changed = true; }
        if (reference.Element("Version") is { } element) { element.Remove(); changed = true; }
    }
    if (changed) doc.Save(project);
}

Console.WriteLine($"wrote {versions.Count} PackageVersion entries from {projects.Length} projects");
```

Dois detalhes desse script são essenciais.

O primeiro é o `NuGetVersion` em vez de strings simples. Ordenar versões como texto está errado, e está errado na direção que silenciosamente rebaixa você:

```text
string  max: 13.0.3
semver  max: 13.0.10
```

O segundo é a diretiva `#:property ManagePackageVersionsCentrally=false` na linha 1. Sem ela, o script quebra a si mesmo no instante em que dá certo. A diretiva `#:package` de um aplicativo baseado em arquivo é traduzida para um `PackageReference` *com* `Version`, e o `Directory.Packages.props` que o script acabou de escrever está na mesma árvore de diretórios, então a execução seguinte falha antes de chegar ao `Main`:

```text
migrate-to-cpm.cs.csproj : error NU1008: The following PackageReference items cannot define a value for
Version: NuGet.Versioning. Projects using Central Package Management must define a Version value on a
PackageVersion item.
```

Vale lembrar disso para além deste script: ativar o CPM na raiz do repositório também vale para todos os aplicativos `.cs` baseados em arquivo do repositório, e o `#:package` não é compatível com isso. Exclua cada um com `#:property`, ou mantenha seus scripts fora da árvore.

## Os conflitos são a migração

Rode o script em uma solução onde três projetos discordam e você obtém a lista real de tarefas:

```text
conflict: Serilog -> 4.1.0, 4.2.0
conflict: Newtonsoft.Json -> 13.0.1, 13.0.3
wrote 3 PackageVersion entries from 3 projects
```

Pegar a versão mais alta, que é o que o script faz, é o *padrão* certo e a *política* errada. É certo porque uma solução que distribui duas versões da mesma biblioteca normalmente é um acidente e não uma decisão, e porque a fixação mais baixa costuma ser a desatualizada que ninguém revisitou. É errado como política porque "a mais alta vence" é exatamente como você atravessa sem perceber um limite de versão maior em um projeto quando só estava tentando reorganizar seus arquivos de build. Leia a lista e, para tudo que salta uma versão maior, migre aquele projeto deliberadamente em vez de deixar o script fazer isso.

## Comprove o que se moveu

O CPM não é uma operação neutra, e a forma de saber o que ele realmente fez é comparar o grafo resolvido. Capture-o antes de começar, a partir da saída de restauração de cada projeto:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(k) for t in d['targets'].values() for k in sorted(t)]" src/Domain/obj/project.assets.json
```

Antes e depois, para a solução de três projetos acima:

```text
            BEFORE                       AFTER
Api       Newtonsoft.Json/13.0.3      Newtonsoft.Json/13.0.3
          Polly/8.5.0                 Polly/8.5.0
          Serilog/4.2.0               Serilog/4.2.0
Domain    Newtonsoft.Json/13.0.1  ->  Newtonsoft.Json/13.0.3
Workers   Serilog/4.1.0           ->  Serilog/4.2.0
          Polly/8.5.0                 Polly/8.5.0
```

Dois projetos se moveram. Essa é a mudança que precisa ser testada e colocada na descrição do pull request. Se o seu diff estiver vazio, a migração foi genuinamente mecânica e você pode mesclá-la com bem menos cerimônia.

## Os quatro erros que você vai encontrar

**NU1008**: um `PackageReference` ainda carrega uma `Version`. Esse é o estado esperado no meio da migração e é um erro, não um aviso, então um repositório migrado pela metade não compila.

```text
error NU1008: The following PackageReference items cannot define a value for Version: Serilog.
```

**NU1010**: um `PackageReference` não tem um `PackageVersion` correspondente. Normalmente é um pacote que só aparece em um projeto que o script não varreu, como um fora da raiz que você passou a ele.

```text
error NU1010: The following PackageReference items do not define a corresponding PackageVersion item:
Humanizer.Core.
```

**NU1013**: um `VersionOverride` foi usado enquanto `CentralPackageVersionOverrideEnabled` está como `false`. Veja as saídas de emergência mais abaixo.

**NU1507**: um aviso, e o que as pessoas ignoram:

```text
warning NU1507: There are 2 package sources defined in your configuration. When using central package
management, please map your package sources with package source mapping
(https://aka.ms/nuget-package-source-mapping) or specify a single package source.
The following sources are defined: nuget.org, contoso
```

Com uma única fonte, nada muda. Com um feed privado ao lado do nuget.org, uma versão declarada centralmente passa a ser resolvível a partir de qualquer um dos dois, o que amplia a janela para uma substituição por confusão de dependências. Corrija com o mapeamento de fontes de pacotes em vez de suprimir o aviso.

## Fixação transitiva

Este é o recurso que por si só justifica a migração. Ative-o com `<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>` e qualquer `PackageVersion` que você declarar também se aplica a pacotes que chegam de forma transitiva.

Pegue um projeto que referencia `Newtonsoft.Json.Bson` e mais nada. A dependência dele em `Newtonsoft.Json >= 12.0.1` resolve exatamente para isso, mesmo que o `Directory.Packages.props` declare 13.0.3, porque um `PackageVersion` sem um `PackageReference` correspondente não faz nada por padrão:

```text
warning NU1903: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability
```

Ligue a fixação transitiva e a mesma restauração fica limpa:

```text
Top-level Package           Requested   Resolved
> Newtonsoft.Json.Bson      1.0.2       1.0.2

Transitive Package      Resolved
> Newtonsoft.Json       13.0.3
```

O pacote é elevado para 13.0.3 e continua classificado como transitivo, então ele não passa a fazer parte da superfície pública de dependências do seu projeto nem vaza para o nuspec de um pacote que você produza. É esse o objetivo: você consegue corrigir uma dependência transitiva vulnerável em todos os projetos de uma vez sem adicionar uma referência direta que depois você teria de lembrar de remover.

## GlobalPackageReference

Pacotes que só atuam em tempo de build e que pertencem a todos os projetos, como provedores de source link, analisadores e ferramentas de versionamento, têm seu próprio tipo de item. Declare uma vez no `Directory.Packages.props` e não toque em nenhum `.csproj`:

```xml
<ItemGroup>
  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
</ItemGroup>
```

Note que um `GlobalPackageReference` carrega sua `Version` inline, diferente de um `PackageReference`. Ele se aplica em todo lugar como referência de nível superior com comportamento de ativos somente de desenvolvimento, então vai aparecer no `dotnet package list` de todos os projetos. Use apenas para pacotes que realmente pertençam a todos eles; um pacote que é global "por enquanto" é muito difícil de remover depois.

## Saídas de emergência

Um projeto precisa de uma versão diferente e você tem um motivo real. O `VersionOverride` vence o valor central:

```xml
<PackageReference Include="Newtonsoft.Json" VersionOverride="13.0.1" />
```

Se o seu objetivo ao adotar o CPM era tornar impossível o desvio de versões, feche essa porta com `<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>`, que transforma qualquer uso dele em NU1013.

Um projeto inteiro pode ficar de fora com `<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>` no seu `.csproj`, e depois disso ele volta a gerenciar as próprias versões inline. Saiba que isso também tira o projeto da fixação transitiva, então uma dependência transitiva vulnerável que o resto da solução elevou volta direto naquele projeto.

## Um Directory.Packages.props aninhado sobrepõe, não mescla

A varredura de descoberta para no primeiro arquivo que encontra. Portanto, um `Directory.Packages.props` em um subdiretório substitui completamente o da raiz em vez de somar a ele, e todo projeto abaixo dele falha imediatamente com NU1010 para os pacotes que o arquivo raiz declarava. Se você precisa de versões por área, importe o pai explicitamente e sobreponha com `Update`:

```xml
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Packages.props', '$(MSBuildThisFileDirectory)../'))" />
  <ItemGroup>
    <PackageVersion Update="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
```

`Update` em vez de `Include`, porque o item já existe. Errar aqui deixa você com dois itens `PackageVersion` para um pacote, o que é ambíguo.

## A CLI já sabe

Você não precisa editar o arquivo de propriedades à mão depois da migração. Os comandos de pacote do SDK do .NET 10 conhecem o CPM e escrevem no arquivo certo por conta própria.

`dotnet package add Humanizer.Core --project src/Lib1/Lib1.csproj` adiciona um `PackageReference` sem versão ao projeto *e* insere um `PackageVersion` no `Directory.Packages.props` em ordem alfabética:

```text
info : PackageReference for package 'Humanizer.Core' version '3.0.10' added to file
'/repo/Directory.Packages.props'.
```

`dotnet package update Serilog --project src/App/App.csproj` edita apenas a versão central e deixa o arquivo de projeto em paz. `dotnet package list --outdated` continua reportando corretamente, incluindo itens `GlobalPackageReference`. `dotnet nuget why <project> <package>` continua sendo a forma mais rápida de descobrir qual referência arrastou um pacote transitivo que você está prestes a fixar.

## Relacionado

- O CPM combina naturalmente com a limpeza de dependências transitivas de [a poda de pacotes NuGet ativada por padrão no .NET 10](/pt-br/2026/05/nuget-package-pruning-default-net-10/), que remove do grafo os pacotes fornecidos pelo framework antes que a fixação precise pensar neles.
- As diretivas `#:package` e `#:property` usadas pelo script de migração são cobertas por completo em [como executar um aplicativo C# baseado em arquivo com `dotnet run app.cs`](/pt-br/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/).
- Consolidar versões entre projetos é uma boa coisa a fazer *antes* de [migrar do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), para que o salto de framework seja a única variável no diff.
- Se um projeto parar de compilar depois que você tirar as versões dele, a causa costuma ser a própria referência e não o CPM; veja [o tipo ou nome de namespace não pôde ser encontrado após adicionar uma referência de projeto](/pt-br/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/).
- Quando dois projetos convergem para uma única versão, os erros de carregamento em tempo de execução são a forma como você fica sabendo; [não foi possível carregar o arquivo ou assembly em um aplicativo publicado](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cobre como diagnosticá-los.

## Fontes

- [Central Package Management](https://learn.microsoft.com/pt-br/nuget/consume-packages/central-package-management) na documentação do NuGet, para `PackageVersion`, `GlobalPackageReference`, `VersionOverride` e fixação transitiva.
- [Referência de erros e avisos do NuGet](https://learn.microsoft.com/pt-br/nuget/reference/errors-and-warnings/) para NU1008, NU1010, NU1013 e NU1507.
- [Mapeamento de fontes de pacotes](https://learn.microsoft.com/pt-br/nuget/consume-packages/package-source-mapping), a resposta recomendada ao NU1507.
- [Personalizar seu build com Directory.Build.props](https://learn.microsoft.com/pt-br/visualstudio/msbuild/customize-by-directory) para a varredura de diretórios que também rege o `Directory.Packages.props`.
