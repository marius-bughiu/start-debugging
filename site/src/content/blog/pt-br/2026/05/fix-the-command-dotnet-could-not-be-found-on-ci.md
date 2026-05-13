---
title: "Correção: The command 'dotnet' could not be found no CI"
description: "Seu runner de CI não consegue resolver dotnet porque o SDK não está instalado para esse passo, ou está instalado mas fora do PATH. Use actions/setup-dotnet, fixe um global.json e exporte DOTNET_ROOT e ~/.dotnet/tools."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "ci"
  - "github-actions"
  - "azure-pipelines"
lang: "pt-br"
translationOf: "2026/05/fix-the-command-dotnet-could-not-be-found-on-ci"
translatedBy: "claude"
translationDate: 2026-05-13
---

A correção: um passo de CI está rodando `dotnet` em um shell onde o SDK ou não está instalado, ou não está no `PATH`, ou está fixado em uma versão que o seu `global.json` proíbe. No GitHub Actions, adicione um passo `actions/setup-dotnet@v4` antes de qualquer invocação de `dotnet`, comite um `global.json` que case com o SDK que você pediu e, em contêineres Linux, exporte `DOTNET_ROOT` e `$HOME/.dotnet/tools`. O erro quase nunca é bug da imagem do runner.

```text
/bin/bash: line 1: dotnet: command not found
##[error]Process completed with exit code 127.
```

ou em runners Windows:

```text
dotnet : The term 'dotnet' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ dotnet build
+ ~~~~~~
    + CategoryInfo          : ObjectNotFound: (dotnet:String) [], CommandNotFoundException
```

ou, no Ubuntu após `dotnet-install.sh`:

```text
Command 'dotnet' not found, but can be installed with:
sudo apt install dotnet-host
```

Este guia foi escrito contra .NET 11 (SDK 11.0.100), `actions/setup-dotnet@v4.0.1`, a task `UseDotNet@2` do Azure DevOps versão 2.213.x e o `dotnet-install.sh` publicado em `https://dot.net/v1/dotnet-install.sh` em maio de 2026. As causas raiz não mudaram desde o .NET Core 3.1; só mudaram as versões das actions.

## Por que shells de CI perdem o `dotnet`

São quatro causas raiz. Elas se confundem fácil porque todas mostram a mesma linha `command not found`, então vale saber qual delas você está olhando antes de remendar o YAML.

1. **A imagem do runner não tem SDK nenhum.** Imagens de contêiner como `ubuntu:24.04`, `alpine:3.20` ou `mcr.microsoft.com/devcontainers/base:ubuntu` não trazem o SDK do .NET. Os runners hospedados pelo GitHub (`ubuntu-latest`, `windows-latest`) trazem, mas a versão em cache é a que o runner cozinhou na imagem, não a que o seu repositório precisa.
2. **O SDK está instalado, mas não está no `PATH` para este passo.** Cada passo do GitHub Actions roda em um shell novo. Adicionar uma linha em `~/.bashrc` de um passo anterior não persiste. Fazer `export` de `PATH` dentro de um bloco `run:` não vaza para o próximo bloco `run:`.
3. **O SDK está no `PATH`, mas o `global.json` fixa uma versão que não está instalada.** Quando o `dotnet` inicia, ele lê o `global.json` mais próximo subindo a árvore de diretórios e resolve um SDK que case com `version` e `rollForward`. Se nada casar, você recebe `error NETSDK1045` ou uma falha do host que aparece, dependendo do caso, com cara de "command not found" no script wrapper.
4. **O SDK foi instalado pelo `dotnet-install.sh` em `$HOME/.dotnet`, mas `DOTNET_ROOT` e `PATH` nunca foram definidos.** Essa é a falha mais comum em runners auto-hospedados Linux e dentro de contêineres Docker. O script instala direitinho, e nenhum passo seguinte exporta as variáveis.

## Uma reprodução mínima no CI

Salve isto como `.github/workflows/build.yml` e dê push em um repositório com um `.csproj`:

```yaml
# .github/workflows/build.yml -- .NET 11, GitHub Actions May 2026
name: build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    container: ubuntu:24.04   # no SDK is preinstalled here
    steps:
      - uses: actions/checkout@v4
      - run: dotnet --info     # fails: dotnet: command not found
```

A chave `container:` troca o SO do runner por uma imagem Ubuntu crua. O runner padrão `ubuntu-latest` tem o SDK, então remover `container:` faz esse snippet funcionar. A maioria dos times bate nisso ao mover um job para um contêiner por reprodutibilidade e esquecer de levar o `setup-dotnet` junto.

## Correção 1: instale o SDK no mesmo job, depois use

A correção canônica no GitHub Actions é o `actions/setup-dotnet`. Coloque antes de qualquer passo que chame `dotnet`. Ele baixa o SDK para um cache por runner, prefixa o `PATH` em todos os passos seguintes e exporta `DOTNET_ROOT` para ferramentas que precisam do diretório de instalação do SDK diretamente.

```yaml
# .github/workflows/build.yml -- setup-dotnet@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "11.0.x"
      - run: dotnet --info
      - run: dotnet build -c Release
```

Dois detalhes que mordem:

- **`dotnet-version` aceita curinga**, mas mesmo assim comite um `global.json` para que build local e CI batam. Sem ele, um desenvolvedor com SDK 11.0.5 instalado local e CI no 11.0.7 podem produzir `obj/project.assets.json` diferentes e se surpreender.
- **`global-json-file:` sobrescreve `dotnet-version`** no `setup-dotnet@v4`. Se você passar os dois, o JSON vence. Isso é recurso, não bug, mas já vi gente adicionar `dotnet-version: "8.0.x"` a um workflow com `global.json` apontando para 11 e ficar se perguntando por que ainda instala .NET 11.

No Azure DevOps, o equivalente é `UseDotNet@2`:

```yaml
# azure-pipelines.yml -- Azure DevOps, UseDotNet@2
steps:
  - task: UseDotNet@2
    inputs:
      packageType: sdk
      version: "11.0.x"
  - script: dotnet build -c Release
```

No GitLab CI ou Buildkite, o caminho mais limpo é uma imagem base com o SDK já cozido (`mcr.microsoft.com/dotnet/sdk:11.0`). Evite rodar `dotnet-install.sh` no próprio job a menos que precise: funciona, mas todo job paga o custo de download.

## Correção 2: comite um `global.json` que case com o CI

Quando o CI roda `dotnet build`, ele usa o SDK que vence a resolução do `global.json`, não o último SDK instalado. Uma falha comum tem essa cara:

```text
A compatible .NET SDK was not found.
Requested SDK version: 11.0.200
global.json file: /home/runner/work/myrepo/myrepo/global.json
Installed SDKs:
  8.0.412 [/usr/share/dotnet/sdk]
  11.0.100 [/usr/share/dotnet/sdk]
```

O runner tem 11.0.100; o `global.json` pede 11.0.200. O script wrapper sai com código diferente de zero, e dependendo do host, você vê "command not found" propagado de um `if` em Bash que engoliu o erro real.

Mantenha o `global.json` honesto:

```json
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

`rollForward: latestFeature` deixa um desenvolvedor com 11.0.103 trabalhar sem ter que subir o arquivo a cada release de patch. `latestMajor` é permissivo demais para CI; `disable` é rígido demais para local. Faça `version` casar com o que o `dotnet-version` do `actions/setup-dotnet` vai instalar.

## Correção 3: quando você precisa usar `dotnet-install.sh`

Dentro de um contêiner enxuto, ou num runner auto-hospedado onde você não pode usar `setup-dotnet`, instale com o script oficial e exporte as variáveis explicitamente em cada passo seguinte.

```yaml
# self-hosted runner or restrictive container -- .NET 11
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Install .NET 11 SDK
        run: |
          curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
          chmod +x dotnet-install.sh
          ./dotnet-install.sh --channel 11.0 --install-dir "$HOME/.dotnet"
          echo "$HOME/.dotnet" >> "$GITHUB_PATH"
          echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
          echo "DOTNET_ROOT=$HOME/.dotnet" >> "$GITHUB_ENV"
      - run: dotnet --info
      - run: dotnet tool restore && dotnet build -c Release
```

As duas linhas `echo` escrevem em arquivos especiais que o GitHub Actions lê entre passos: `GITHUB_PATH` prefixa uma entrada no `PATH` em todos os passos seguintes do job, e `GITHUB_ENV` exporta uma variável de ambiente da mesma forma. `export PATH=...` dentro do mesmo bloco `run:` não funcionaria para o próximo passo, que é a armadilha em que as pessoas caem ao traduzir um script de shell literalmente.

`DOTNET_ROOT` importa mesmo que o `PATH` esteja configurado. O host (o binário `dotnet`) usa `DOTNET_ROOT` para encontrar as pastas `shared/Microsoft.NETCore.App` e `sdk/`. Se você só corrigir o `PATH`, pode acabar com `dotnet --info` funcionando, mas `dotnet build` falhando com erro de host sobre um runtime faltando. Segundo a Microsoft Learn, `DOTNET_ROOT` é lido pelo host no Linux e macOS, e no Windows quando a instalação está fora do local padrão.

Adicione também o diretório `tools`. Sem `$HOME/.dotnet/tools` no `PATH`, qualquer chamada `dotnet tool install --global` tem sucesso mas a ferramenta fica inacessível, produzindo o erro relacionado: `dotnet-ef: command not found`.

## Correção 4: imagem do SDK pré-construída, sem passo de instalação

Para CI baseado em Docker, o caminho de menor atrito é começar de uma imagem que já tem o SDK:

```yaml
# .gitlab-ci.yml -- pinned SDK image, no install step
build:
  image: mcr.microsoft.com/dotnet/sdk:11.0
  script:
    - dotnet --info
    - dotnet build -c Release
```

Replique isto no Buildkite, CircleCI, agentes Jenkins em Docker e qualquer plataforma cuja primitiva de CI seja "um contêiner mais um script". Você troca flexibilidade (uma imagem, um SDK) pela garantia de que `dotnet` está no `PATH` desde o primeiro comando.

## Variantes comuns e parecidos

Buscas que caem nesta página às vezes querem um erro um pouco diferente. Vale desambiguar logo no começo para não perseguir a correção errada.

- **`dotnet-ef: command not found`**. A ferramenta global foi instalada mas `$HOME/.dotnet/tools` não está no `PATH`. Adicione como mostrado acima, ou use um manifesto local `dotnet-tools.json` e chame `dotnet tool restore && dotnet ef`.
- **`Could not execute because the specified command or file was not found`**. `dotnet` está no `PATH`, mas o subcomando (`dotnet foo`) não é built-in nem está instalado como ferramenta. Outro erro, outra causa raiz.
- **`error NETSDK1045: The current .NET SDK does not support targeting .NET 11.0`**. O SDK está no `PATH`, mas é velho demais para o `TargetFramework` do projeto. Suba o `dotnet-version` do `setup-dotnet` (ou o `global.json`), não instale um segundo SDK ao lado do primeiro esperando que a resolução multi-target resolva.
- **`/usr/bin/env: 'dotnet': No such file or directory`**. Mesma causa raiz de "command not found", outro shell. A correção é idêntica.
- **`A fatal error occurred. The required library libhostfxr.so could not be found`**. `dotnet` está no `PATH`, mas o `DOTNET_ROOT` aponta para um diretório vazio, ou o SDK foi instalado parcialmente. Rode `dotnet-install.sh` de novo e confirme que `DOTNET_ROOT` casa com o diretório de instalação real.

## Coisas que parecem correções mas não são

- **Rodar `apt install dotnet-host`** no CI. Isso instala só o host, não o SDK, e puxa um `.deb` assinado pela Microsoft que pode estar semanas atrás do canal do SDK. Use `setup-dotnet` ou `dotnet-install.sh`.
- **Adicionar `dotnet` ao `PATH` no `~/.bashrc`** dentro de um passo `run:`. Passos de CI usam shells não interativos; `~/.bashrc` não é carregado. Use `GITHUB_PATH` (GitHub Actions), `task.prependpath` (Azure DevOps), ou um prefixo `PATH=...` por passo.
- **`sudo` num runner hospedado**. Runners hospedados já rodam como usuário com `sudo` sem senha, mas o SDK é instalado em `/usr/share/dotnet` e o wrapper em `/usr/bin/dotnet` já está lá. Se você se pegar dando `sudo` para fazer funcionar, quase com certeza está faltando `setup-dotnet`, não privilégio.
- **Fixar `actions/setup-dotnet` num major antigo** porque "v4 nos quebrou". v4 mudou diretórios de cache e passou a parsear `global.json` com mais rigor. A quebra é quase sempre um `global.json` apontando para um SDK indisponível. Conserte o JSON; não fique fixado em v3 para sempre.

## Verificando a correção no CI

Antes de seguir, rode dois passos de diagnóstico. Eles são baratos e poupam você de caçar fantasmas na saída de `dotnet build`.

```yaml
- run: which dotnet || command -v dotnet || true
- run: dotnet --info
```

`which dotnet` (ou `where dotnet` no Windows) confirma qual binário o shell resolve. `dotnet --info` imprime o runtime, a lista de SDKs e o `global.json` resolvido. Se `--info` tem sucesso mas `build` falha com "command not found", a falha está dentro de um wrapper que engole erros, não no `dotnet`. Esse é o momento de ler o wrapper, não de reinstalar.

Quando a saída de `--info` mostrar o SDK que você pediu, apontar `Base Path:` para o diretório esperado e listar `global.json file: <seu caminho>`, você terminou. Qualquer outra coisa é configuração errada de verdade que vale corrigir.

## Relacionados

- Para o panorama maior de rodar ferramentas em lanes paralelas de CI, veja [como mirar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), que usa o mesmo truque do `GITHUB_PATH` para trocar SDKs por job de matriz.
- Se o build falhar depois do SDK ser encontrado, olhe [por que um app publicado falha ao carregar assemblies](/pt-br/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) para a história de trim e runtime packs.
- Para falhas específicas de cópia em build, [a correção do MSB3027 com retry-count](/pt-br/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) cobre antivírus e bloqueio de arquivo.
- Para uma ferramenta de EF Core que resolve mas falha ao se anexar ao host, veja [corrigir dotnet ef migrations add quando o DbContext não pode ser criado](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).
- Para testes de integração baseados em contêiner quando você quer um banco real no mesmo job, [testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) percorre um pipeline funcional.

## Fontes

- [README do `actions/setup-dotnet`](https://github.com/actions/setup-dotnet), documentação `v4.0.x` de `dotnet-version`, `global-json-file` e `cache`.
- [Instalar .NET no Linux sem gerenciador de pacotes](https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual), Microsoft Learn, cobre `dotnet-install.sh`, `DOTNET_ROOT` e `PATH`.
- [Variáveis de ambiente usadas pelo SDK e CLI do .NET](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables), Microsoft Learn, sobre `DOTNET_ROOT`.
- [Visão geral do `global.json`](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json), Microsoft Learn, para as regras de `rollForward`.
- [Comandos de workflow para o GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-system-path), GitHub Docs, sobre `GITHUB_PATH` e `GITHUB_ENV`.
- [Issue 5267 de `dotnet/core`](https://github.com/dotnet/core/issues/5267), a thread upstream de longa data sobre "command 'dotnet' not found, but can be installed with".
