---
title: "dotnet sln finalmente edita solution filters pela CLI no .NET 11 Preview 3"
description: ".NET 11 Preview 3 ensina ao dotnet sln a criar, adicionar, remover e listar projetos em solution filters .slnf, então monorepos grandes podem carregar um subconjunto sem abrir o Visual Studio."
pubDate: 2026-04-18
tags:
  - "dotnet-11"
  - "sdk"
  - "dotnet-cli"
  - "msbuild"
lang: "pt-br"
translationOf: "2026/04/dotnet-11-sln-cli-solution-filters"
translatedBy: "claude"
translationDate: 2026-04-24
---

Solution filters (`.slnf`) existem desde o Visual Studio 2019, mas editá-los fora da IDE significava escrever JSON na mão. O [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) conserta isso: `dotnet sln` agora cria, edita e lista o conteúdo de arquivos `.slnf` direto, via [dotnet/sdk #51156](https://github.com/dotnet/sdk/pull/51156). Para repositórios grandes essa é a diferença entre abrir um subconjunto de vinte projetos a partir do terminal e manter um shell script que mexe no JSON manualmente.

## O que é de fato um solution filter

Um `.slnf` é um ponteiro JSON para um `.sln` pai mais uma lista de caminhos de projetos. Quando uma ferramenta carrega o filtro, ela descarrega todo projeto na solution pai que não está na lista. Isso mantém grafos de build, analyzers e IntelliSense focados no subconjunto que você se importa - que é a principal alavanca que bases de código grandes têm para manter o tempo de carga da IDE sob controle. Até o Preview 3 a CLI podia tranquilamente `build` um filtro mas não editá-lo.

## Os novos comandos

A superfície espelha os verbos existentes do `dotnet sln`. Você pode criar um filtro, adicionar e remover projetos, e listar o que está incluído no momento:

```bash
# Create a filter that points at the current .sln
dotnet new slnf --name MyApp.slnf

# Target a specific parent solution
dotnet new slnf --name MyApp.slnf --solution-file ./MyApp.sln

# Add and remove projects
dotnet sln MyApp.slnf add src/Lib/Lib.csproj
dotnet sln MyApp.slnf add src/Api/Api.csproj src/Web/Web.csproj
dotnet sln MyApp.slnf remove src/Lib/Lib.csproj

# Inspect what the filter currently loads
dotnet sln MyApp.slnf list
```

Os comandos aceitam as mesmas formas de glob e multi-argumento que o `dotnet sln` já suporta para arquivos `.sln`, e escrevem JSON `.slnf` que bate com o que o Visual Studio emite, então um filtro que você edita pela CLI abre limpo na IDE.

## Por que isso importa pra monorepos

Dois fluxos de trabalho ficam muito mais baratos. O primeiro é CI: um pipeline pode fazer checkout do repo inteiro mas buildar apenas o filtro relevante aos paths alterados. Antes do Preview 3 a maioria dos times fazia isso com um script custom que escrevia JSON ou mantinha arquivos `.slnf` mantidos à mão ao lado do `.sln`. Agora o mesmo pipeline pode regenerar filtros na hora:

```bash
dotnet new slnf --name ci-api.slnf --solution-file MonoRepo.sln
dotnet sln ci-api.slnf add \
  src/Api/**/*.csproj \
  src/Shared/**/*.csproj \
  test/Api/**/*.csproj

dotnet build ci-api.slnf -c Release
```

O segundo é dev local. Repos grandes frequentemente entregam um punhado de filtros "starter" para que uma engenheira nova possa abrir o backend sem esperar os projetos de mobile e docs carregarem. Manter esses filtros precisos antes exigia abrir cada um no Visual Studio depois de uma movida de projeto, porque renames de `.sln` não atualizavam `.slnf` automaticamente. Com os novos comandos a atualização é um one-liner:

```bash
dotnet sln backend.slnf remove src/Legacy/OldService.csproj
dotnet sln backend.slnf add src/Services/NewService.csproj
```

## Uma nota rápida sobre paths

`dotnet sln` resolve paths de projeto relativos ao filtro, não ao chamador, o que bate com como a IDE os lê. Se o `.slnf` vive em `build/filters/` e aponta para projetos sob `src/`, o path armazenado será `..\..\src\Foo\Foo.csproj`, e `dotnet sln list` o mostra do mesmo jeito. Vale lembrar quando você scripta edições de filtro a partir de um diretório de trabalho diferente.

Combinado com [`dotnet run -e` para variáveis de ambiente inline](https://github.com/dotnet/sdk/pull/52664) e as [migrations de EF Core em passo único de antes](https://startdebugging.net/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), o Preview 3 continua lascando no conjunto de "preciso abrir o Visual Studio pra fazer isso". A lista completa está nas [notas do SDK do .NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md).
