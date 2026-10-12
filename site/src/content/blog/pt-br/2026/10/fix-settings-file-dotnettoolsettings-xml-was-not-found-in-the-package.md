---
title: "Correção: Settings file 'DotnetToolSettings.xml' was not found in the package"
description: "O pacote da ferramenta tem como alvo um .NET mais novo que o SDK que executa a instalação, ou nem é uma ferramenta .NET. Use um SDK mais novo, fixe uma versão da ferramenta com uma pasta tools compatível ou force --framework."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "dotnet-tools"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package"
translatedBy: "claude"
translationDate: 2026-10-12
---

O pacote quase nunca está quebrado, e limpar o cache do NuGet não vai ajudar. Esta mensagem significa que o SDK que executa `dotnet tool install` não encontrou nenhuma pasta `tools/<tfm>/` que pudesse usar. A causa habitual é uma ferramenta compilada apenas para um .NET mais novo que o próprio SDK, por exemplo `dotnet-ef` 10.0.0/10.0.1 ou 11.0 no SDK 8 ou 9. Execute `dotnet --version` na pasta em que a instalação falha. Depois, ou migre para um SDK pelo menos tão novo quanto o framework de destino da ferramenta, ou fixe uma versão da ferramenta que traga uma pasta `tools/` mais antiga (`dotnet-ef` 10.0.2 e posteriores voltaram a trazer `net8.0`). Se o pacote não for uma ferramenta .NET (`Microsoft.EntityFrameworkCore.Tools`, `Microsoft.EntityFrameworkCore.Design`), instale `dotnet-ef`. Tudo abaixo foi reproduzido em 2026-10-12 com os SDKs 8.0.425, 9.0.318 e 10.0.302 no macOS arm64, contra o nuget.org real.

## O erro em contexto

`dotnet tool install` (global, `--tool-path` ou local) imprime isto, mesmo em uma máquina limpa em que nada foi instalado antes:

```
Tool 'dotnet-ef' failed to update due to the following:
The settings file in the tool's NuGet package is invalid: Settings file 'DotnetToolSettings.xml' was not found in the package.
Tool 'dotnet-ef' failed to install. Contact the tool author for assistance.
```

"Failed to update" engana. Ele aparece também na primeira instalação. `dotnet tool restore` e `dotnet dnx` passam pelo mesmo caminho de código, mas não encapsulam a exceção, então em um repositório com manifesto de ferramentas você recebe a forma bruta:

```
Unhandled exception: Settings file 'DotnetToolSettings.xml' was not found in the package.
```

As duas formas terminam com código de saída 1. Nada mais na saída diz qual framework o SDK estava procurando, e é por isso que as pessoas acabam apagando caches e reinstalando SDKs ao acaso.

## Por que isso acontece

Um pacote de ferramenta .NET mantém seu conteúdo em `tools/<target framework>/<rid>/`, e o `DotnetToolSettings.xml` fica nessa pasta. O arquivo existe, mas só dentro de uma pasta de framework. O SDK não procura o arquivo no pacote inteiro. Ele monta um arquivo de assets sintético com as regras de seleção de assets do NuGet e pede o item na **pasta de framework compatível mais próxima**. No código-fonte do SDK do .NET 10 (`ToolPackageDownloader.CreateAssetFile`), o framework de destino vem do runtime em que a CLI está executando:

```csharp
// dotnet/sdk, release/10.0.3xx: src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs
currentTargetFramework = new NuGetFramework(
    FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
    new Version(Environment.Version.Major, Environment.Version.Minor));
```

O SDK 9.0.318 executa no runtime do .NET 9, então pede `net9.0`. Um pacote que contém apenas `tools/net10.0/any/` não tem pasta compatível, e a lista de itens selecionados fica vazia. Em seguida `ToolPackageInstance.DeserializeToolConfiguration` lança `MissingToolSettingsFile`, que é a mensagem que você vê. Na prática, o texto significa "nenhuma pasta `tools/` tem como alvo um framework que este SDK consiga executar".

Duas consequências surpreendem as pessoas:

1. **Runtimes instalados não contam.** Adicionei o runtime do .NET 10.0.12 ao lado do SDK 9.0.318 e a instalação simples de `dotnet-ef` 10.0.1 continuou falhando com a mesma mensagem. Só importa a versão do runtime do próprio SDK.
2. **A verificação do tipo de pacote vem depois, e só no SDK 10.** O SDK 10 verifica primeiro o `packageType` do nuspec e imprime um claro "is not a .NET tool" para pacotes que não são ferramentas. Os SDKs 8 e 9 pulam essa verificação e caem na mesma mensagem enganosa.

Então há três causas reais por trás de uma única string, ordenadas pela frequência com que aparecem:

- **A ferramenta tem como alvo um .NET mais novo que o seu SDK.** É a causa habitual depois de uma nova versão principal (`dotnet-ef` 10.0.0/10.0.1, `AzureSignTool` 7.0.0, qualquer ferramenta compilada apenas para `net10.0` ou `net11.0`).
- **A ferramenta é uma ferramenta específica de RID (específica de plataforma) do .NET 10.** O pacote raiz dela também só tem uma pasta `tools/net10.0/`, então SDKs mais antigos falham do mesmo jeito.
- **O pacote não é uma ferramenta.** É uma biblioteca ou um pacote de MSBuild/PowerShell, instalado com `dotnet tool install` por engano.

## Repro mínimo

Estes comandos usam `--tool-path` para que nada toque na sua pasta de ferramentas globais. Cada bloco mostra a versão do SDK que o executou.

```bash
# SDK 9.0.318 (also identical on SDK 8.0.425)
dotnet tool install dotnet-ef --version 10.0.1 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --version 11.0.0-rc.1.26425.128 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install AzureSignTool --version 7.0.0 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --tool-path ./tools
# Tool 'dotnet-ef' (version '10.0.12') was successfully installed.  exit 0
```

A última linha importa. O simples `dotnet tool install dotnet-ef` resolve hoje para 10.0.12 e funciona nos SDKs 8 e 9. A falha só aparece quando uma versão é fixada, em um manifesto `dotnet-tools.json` ou em um script de CI escrito em novembro de 2025, por exemplo. Este é o layout de `tools/` de cada versão de `dotnet-ef` que verifiquei no nuget.org:

| versão do dotnet-ef | pasta tools | Instala no SDK 8 / 9 | Instala no SDK 10 |
|---|---|---|---|
| 8.0.21 | `tools/net8.0/any/` | sim | sim |
| 9.0.10 | `tools/net8.0/any/` | sim | sim |
| 10.0.0, 10.0.1 | `tools/net10.0/any/` | **não** | sim |
| 10.0.2 a 10.0.12 | `tools/net8.0/any/` | sim | sim |
| 11.0.0-rc.1.26425.128 | `tools/net10.0/any/` | **não** | sim |

A mesma coisa acontece uma versão principal acima. Reempacotei uma ferramenta trivial para que sua única pasta fosse `tools/net11.0/any/`, e o SDK 10.0.302 a rejeitou com a mesma mensagem. `dotnet dnx` no SDK 10 imprimiu a forma "Unhandled exception" para o mesmo pacote.

## Correção, em detalhe

### 1. Verifique qual SDK realmente executa nessa pasta

O `global.json` escolhe o SDK por diretório, então o SDK que executa `dotnet tool restore` no seu repositório pode não ser o mais novo instalado:

```bash
# Any SDK. Run in the directory where the install fails.
dotnet --version
dotnet --list-sdks
cat global.json 2>/dev/null
```

Se `dotnet --version` imprimir `8.0.x` ou `9.0.x` e a ferramenta tiver como alvo `net10.0`, essa é a sua resposta. No CI, o mesmo descompasso vem de uma imagem de runner que só tem o SDK antigo, ou de `actions/setup-dotnet` lendo um `global.json` que fixa o 8.0. O [passo a passo de CI para "the command dotnet could not be found"](/pt-br/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) explica como o runner escolhe seu SDK.

### 2. Recomendado: execute a ferramenta com um SDK pelo menos tão novo quanto o alvo dela

```json
// global.json, .NET 10 SDK. rollForward keeps you on the newest 10.0 feature band.
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

Um SDK do .NET 10 compila projetos `net8.0` e `net9.0` sem nenhuma alteração, então atualizar o SDK não obriga você a mudar o alvo do seu app. Essa é a correção mais limpa, porque todas as outras ferramentas do seu manifesto também se beneficiam. Se você já está planejando a migração completa, o [checklist do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) lista as mudanças incompatíveis em nível de SDK que você deve esperar.

### 3. Se você não pode mudar o SDK: fixe uma versão da ferramenta com pasta compatível

Para `dotnet-ef`, qualquer build 10.0.2 ou posterior traz `tools/net8.0/` e instala nos SDKs 8 e 9:

```bash
# SDK 8.0.425 or 9.0.318
dotnet tool install --global dotnet-ef --version 10.0.12
```

```json
// .config/dotnet-tools.json, works with SDK 8, 9 and 10
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "10.0.12", "commands": [ "dotnet-ef" ], "rollForward": false }
  }
}
```

A ferramenta ainda precisa de um runtime em que consiga executar. O build `net8.0` do `dotnet-ef` 10.0.12 rodou bem no SDK 8.0.425 com apenas o runtime do .NET 8 instalado. Para outras ferramentas, olhe dentro do pacote antes de fixar. A aba "Frameworks" no nuget.org mostra isso, ou você pode listar o arquivo diretamente:

```bash
# Any OS with curl and unzip. Replace the id and version.
curl -sL https://api.nuget.org/v3-flatcontainer/dotnet-ef/10.0.1/dotnet-ef.10.0.1.nupkg -o t.nupkg
unzip -l t.nupkg | grep DotnetToolSettings
#   tools/net10.0/any/DotnetToolSettings.xml
```

Se toda versão que você pode usar tiver apenas uma pasta mais nova, volte à correção 2.

### 4. Saída de emergência: force o framework com `--framework`

`dotnet tool install` e `dotnet tool update` aceitam `--framework`, e esse valor substitui `Environment.Version` na seleção de assets acima. Se o runtime mais novo estiver instalado lado a lado, um SDK antigo consegue instalar uma ferramenta portátil mais nova:

```bash
# SDK 9.0.318 with the .NET 10.0.12 runtime installed next to it
dotnet tool install --global dotnet-ef --version 10.0.1 --framework net10.0
# Tool 'dotnet-ef' (version '10.0.1') was successfully installed.
dotnet-ef --version
# 10.0.1
```

Sem o runtime do .NET 10, a instalação ainda "tem sucesso", mas a ferramenta falha na primeira execução. No SDK 8.0.425 com apenas o .NET 8 presente, `dotnet-ef` informou "You must install or update .NET to run this application" e pediu `Microsoft.NETCore.App` 10.0.0. `dotnet tool restore` não tem a opção `--framework`, então isso só ajuda instalações globais e com `--tool-path`. Trate como um paliativo, não como uma correção de pipeline.

### 5. Se o pacote não é uma ferramenta: instale o pacote certo

`Microsoft.EntityFrameworkCore.Tools` é o pacote do Package Manager Console para o Visual Studio, e `Microsoft.EntityFrameworkCore.Design` é a biblioteca de tempo de design que o seu projeto de inicialização referencia. Nenhum dos dois é uma ferramenta .NET. O que cada SDK imprime depende da versão:

```bash
# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.

# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Design
# Unhandled exception: System.IO.DirectoryNotFoundException: Could not find a part
# of the path '.../microsoft.entityframeworkcore.design/10.0.12/tools'.

# SDK 10.0.302
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Package microsoft.entityframeworkcore.tools is not a .NET tool.
```

A ferramenta de CLI é `dotnet-ef`. Adicione `Microsoft.EntityFrameworkCore.Design` ao seu projeto de inicialização como um `PackageReference` normal. Se `dotnet ef` reclamar disso mais tarde, a correção está em [your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/pt-br/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

## Pegadinhas e erros parecidos

**Ferramentas específicas de RID do .NET 10 escondem uma mensagem melhor.** O .NET 10 permite que autores publiquem [ferramentas específicas de plataforma](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools): um pequeno pacote raiz cujo `DotnetToolSettings.xml` usa `Version="2"` e aponta para pacotes por RID. Empacotei uma com `<RuntimeIdentifiers>osx-arm64;linux-x64;win-x64</RuntimeIdentifiers>` no SDK 10.0.302. Os SDKs 8.0.425 e 9.0.318 a rejeitaram com o texto genérico "was not found", porque o pacote raiz só tem uma pasta `net10.0`. A Microsoft fez o backport de um erro mais claro para o SDK 8.0.21 ([dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414)), mas você só chega a ele quando a pasta é resolvida. Com `--framework net10.0`, o SDK 9.0.318 imprimiu "Format version is higher than supported. This tool may not be supported in this SDK version. Update your SDK." `--framework` não consegue salvar uma ferramenta específica de RID. A única correção é um SDK do .NET 10.

**Limpar caches não resolve isto.** `dotnet nuget locals all --clear` é o conselho mais comum para esta mensagem. Ele não ajuda em nenhum dos três casos acima, porque o pacote foi baixado corretamente. O arquivo está no pacote, só não está em uma pasta que o seu SDK seleciona. Um download truncado é possível em teoria, mas fica bem no fim da lista. Verifique `dotnet --version` e a pasta `tools/` do pacote antes de recorrer ao cache.

**"Tool 'dotnet-ef' is already installed", "is not found in NuGet feeds" e conflitos de shim são falhas diferentes** com flags diferentes. Todas as seis estão cobertas em [every way dotnet tool install --global dotnet-ef fails](/pt-br/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/).

**A instalação funcionou, mas `dotnet ef` está "not found".** Isso é um problema de `PATH`, não de pacote. Veja [como corrigir "dotnet ef" not found](/pt-br/2023/06/how-to-fix-command-dotnet-ef-not-found/).

**Autores de ferramentas podem evitar isso para os seus usuários.** Use multi-targeting na ferramenta (`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` com `<PackAsTool>true</PackAsTool>`) para que SDKs mais antigos encontrem uma pasta que consigam executar, como o `dotnet-ef` fez a partir da 10.0.2. Para ferramentas específicas de RID, Andrew Lock documenta um pacote raiz de compromisso que também carrega um build dependente de framework para SDKs antigos. A equipe do SDK concorda que a mensagem não ajuda. [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172) e [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878) continuam abertos até a data desta escrita.

## Relacionados

- [Fix: dotnet tool install --global dotnet-ef throws an error](/pt-br/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/), para as outras falhas de instalação e o descompasso de runtime que só aparece depois de uma instalação bem-sucedida.
- [How to fix "dotnet ef" not found](/pt-br/2023/06/how-to-fix-command-dotnet-ef-not-found/), para o lado do `PATH` da mesma ferramenta.
- [Fix: the command dotnet could not be found on CI](/pt-br/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), para saber como os runners de CI escolhem e expõem um SDK.
- [Fix: your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/pt-br/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/), para o pacote que as pessoas tentam instalar como ferramenta por engano.
- [Migrate from .NET 8 to .NET 11: the full checklist](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), se a atualização do SDK faz parte de uma migração maior.

## Fontes

- [dotnet/sdk `ToolPackageDownloader.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs) e [`ToolPackageInstance.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageInstance.cs), para a seleção de framework e o throw de `MissingToolSettingsFile`.
- [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172), "Installing a tool that targets a framework not installed gives a non-actionable error message".
- [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878), o relato do `AzureSignTool` 7.0.0 e a explicação de que a regressão data do .NET 7, quando os downloads de ferramentas deixaram de passar pelo restore.
- [dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414), o backport 8.0.4xx do erro "Format version is higher than supported".
- [Create RID-specific, self-contained, and AOT .NET tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools) no Microsoft Learn.
- [dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), para `--framework`, `--tool-path` e o comportamento do manifesto.
- Andrew Lock, [Supporting platform-specific .NET tools on old SDKs](https://andrewlock.net/exploring-dotnet-10-preview-features-8-supporting-platform-specific-dotnet-tools-on-old-sdks/), para os esquemas versão 1 e versão 2 do `DotnetToolSettings.xml`.
