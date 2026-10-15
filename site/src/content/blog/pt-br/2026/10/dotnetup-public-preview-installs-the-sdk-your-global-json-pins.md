---
title: "dotnetup em versão prévia pública: um comando instala o SDK fixado no seu global.json"
description: "O dotnetup entrou em versão prévia pública em 15 de outubro de 2026. Execute dotnetup sdk install em um repositório e ele lê o global.json, mapeia rollForward para um canal de atualização e ainda pode gravar versões de patch mais novas de volta no arquivo."
pubDate: 2026-10-15
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
  - "global-json"
lang: "pt-br"
translationOf: "2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins"
translatedBy: "claude"
translationDate: 2026-10-15
---

Em 15 de outubro de 2026, a Microsoft [anunciou a versão prévia pública do dotnetup](https://devblogs.microsoft.com/dotnet/introducing-dotnetup/), o gerenciador de toolchain no estilo rustup para SDKs e runtimes do .NET. Quando [escrevi sobre ele pela primeira vez em junho](/pt-br/2026/06/dotnetup-official-dotnet-sdk-version-manager/), era preciso compilá-lo a partir do código-fonte e só `dotnetup sdk install preview` estava confirmado. Agora há um instalador de uma linha, uma [referência completa de comandos no Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnetup/) e uma resposta para a pergunta que mais me interessava: o que ele faz com o `global.json`.

## Instalando na máquina

O script de bootstrap baixa o build `preview` mais recente, verifica o checksum SHA-512 e o coloca em `~/.dotnetup`. Sem `sudo`.

```bash
# macOS / Linux (x64 and Arm64, glibc and musl)
curl -fsSL https://aka.ms/dotnetup/get-dotnetup.sh | bash

# then, non-interactively
dotnetup install latest
dotnetup env set shell
```

No Windows, o equivalente em PowerShell é `irm https://aka.ms/dotnetup/get-dotnetup.ps1 | iex`. Cuidado com os padrões do Windows. O `dotnetup init` sugere o modo `everywhere`, que altera o `PATH` do sistema e define `DOTNET_ROOT`. A instalação gerenciada passa a ter precedência sobre os SDKs instalados pelo Visual Studio, então um projeto que precise de um SDK instalado na máquina inteira que o dotnetup não tenha também deixará de compilar. Escolha `shell` ou `none`, a menos que você pretenda migrar tudo.

`none` é o modo mais interessante para experimentar. Ele não mexe em `PATH` nem em `DOTNET_ROOT` e, em vez disso, encaminha os comandos:

```bash
dotnetup env set none --dotnetup-on-path true
dotnetup dotnet -- --info
dotnetup dotnet build
```

## O global.json vira um requisito rastreado

Dentro de um repositório, execute `dotnetup sdk install` sem canal. Ele sobe a partir do diretório atual, usa o `global.json` mais próximo e recorre a `latest` se não existir nenhum. Um arquivo malformado faz o comando falhar. Ele não recorre silenciosamente a um diretório pai.

```json
{
  "sdk": {
    "version": "10.0.103",
    "rollForward": "latestPatch"
  }
}
```

O detalhe-chave é que o dotnetup não instala apenas `10.0.103`. Ele transforma `rollForward` em um canal que o `dotnetup update` continuará atualizando:

| `rollForward` | Canal rastreado |
| --- | --- |
| omitido ou `latestPatch` | `10.0.1xx` |
| `latestFeature` | `10.0` |
| `latestMinor` | `10` |
| `latestMajor` | `latest` |
| `disable`, `patch`, `feature`, `minor`, `major` | exato `10.0.103`, nunca atualizado |

`allowPrerelease` não afeta o canal. O `dotnetup list` mostra o caminho do `global.json` como origem de cada requisito, então dá para saber qual repositório mantém um SDK antigo vivo. Quando nada mais referencia um SDK, a próxima atualização o remove.

## Gravando patches de volta no global.json

Isto é novidade para mim e bem útil para repositórios que fixam versões de patch exatas para builds reproduzíveis:

```bash
dotnetup sdk install --update-global-json
# later, across every tracked repo
dotnetup sdk update --update-global-json
```

Ele instala o SDK mais novo no canal derivado e reescreve apenas `sdk.version`, preservando a formatação, as outras propriedades e a codificação de texto do arquivo. Isso substitui um PR no estilo Dependabot ou uma edição manual a cada Patch Tuesday.

## Arestas da versão prévia

- Se o `global.json` tem `sdk.paths`, o dotnetup instala na primeira entrada. Nesta versão prévia, ele trata `$host$` como um caminho literal e não ignora entradas vazias, então omita `sdk.paths` ou passe `--install-path`.
- `dotnetup sdk uninstall 10.0.1xx --source globaljson` remove todos os requisitos de `global.json` correspondentes na raiz de instalação, não apenas o do repositório atual.
- A integração de primeira classe com GitHub Actions e Azure DevOps ainda está no roadmap, embora os comandos já rodem de forma não interativa em CI.

Se você lida com vários repositórios fixados em diferentes faixas de recursos do .NET 10, `dotnetup sdk install` por repositório mais um `dotnetup update` semanal já é uma história melhor do que os scripts `dotnet-install`. O feedback vai para as [discussões do dotnetup em dotnet/sdk](https://github.com/dotnet/sdk/discussions/categories/dotnetup).
