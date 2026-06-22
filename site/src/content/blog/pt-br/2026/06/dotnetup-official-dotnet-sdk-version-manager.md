---
title: "dotnetup: o .NET finalmente ganha um gerenciador de versoes do SDK no estilo rustup"
description: "A Microsoft esta construindo o dotnetup, uma ferramenta multiplataforma oficial para instalar, rastrear e alternar entre SDKs e runtimes do .NET. Veja o que ele faz e em que ponto esta em junho de 2026."
pubDate: 2026-06-22
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
lang: "pt-br"
translationOf: "2026/06/dotnetup-official-dotnet-sdk-version-manager"
translatedBy: "claude"
translationDate: 2026-06-22
---

Durante anos, gerenciar os SDKs do .NET significou fazer malabarismo com tres coisas distintas: os instaladores independentes da pagina de download, os scripts `dotnet-install` para CI e a ferramenta `dotnet-core-uninstall` para limpar a pilha de versoes antigas que ficam para tras. Nunca existiu um unico comando que instale, rastreie e alterne entre SDKs como o `rustup` faz para Rust ou o `nvm` para Node. A partir de junho de 2026, isso esta mudando. A Microsoft esta construindo o `dotnetup`, e ele ja esta integrado a forma como o SDK do .NET se compila.

## O que o dotnetup realmente e

O `dotnetup` e um gerenciador de versoes oficial e multiplataforma para SDKs e runtimes do .NET. Sua unica tarefa e instalar componentes em um diretorio com escopo de usuario sem exigir elevacao, rastrear o que voce instalou em um manifesto e alternar a versao ativa de forma limpa. Sem solicitacao de administrador, sem MSI, sem cirurgia no registro.

Os comportamentos principais:

- Instala SDKs e runtimes por usuario, entao voce nunca precisa de `sudo` nem de um terminal elevado.
- Le o `global.json` para resolver e instalar o SDK exato que um repositorio fixa.
- Rastreia os componentes instalados em um manifesto para atualizacoes auditaveis e desinstalacoes limpas.
- Suporta multiplos runtimes lado a lado para cenarios de multi-targeting.
- E distribuido como um binario compilado com AOT e assinado, para inicializacao rapida e seguranca da cadeia de suprimentos.

O unico comando confirmado no issue de acompanhamento do `dotnet/sdk` e o caminho de instalacao, usado aqui para obter um SDK previo em um script de build:

```bash
dotnetup sdk install preview
```

O conjunto mais amplo de comandos (listar versoes instaladas, definir um padrao, desinstalar) ainda esta sendo finalizado abertamente, entao trate qualquer exemplo mais longo como ilustrativo, e nao como definitivo.

## Por que o global.json e a verdadeira vantagem

A parte dolorosa do trabalho com .NET em multiplos repositorios hoje e a divergencia do `global.json`. Voce clona um repositorio, executa `dotnet build` e recebe um erro porque ele fixa um SDK que voce nao tem instalado. Suas unicas opcoes sao cacar o instalador correto ou editar o arquivo.

```json
{
  "sdk": {
    "version": "10.0.301",
    "rollForward": "latestPatch"
  }
}
```

Com um gerenciador de versoes que entende esse arquivo, a resolucao vira um unico passo: aponte o `dotnetup` para o repositorio e deixe que ele obtenha o SDK fixado no seu perfil de usuario. Essa e a mesma ergonomia que os desenvolvedores de Rust tem ha anos com o `rust-toolchain.toml`.

## Em que ponto ele esta agora

O `dotnetup` esta em versao previa interna. Ainda nao ha um instalador de uma linha no site do .NET, e a forma pratica de experimenta-lo hoje e compila-lo a partir do codigo-fonte. Uma versao previa publica esta planejada para os proximos meses. Vale notar que o branch `main` do `dotnet/sdk` ja usa o `dotnetup` como parte de seu proprio build, o que e um sinal forte de que este e o futuro pretendido para a instalacao do .NET, e nao um experimento.

Se voce mantem pipelines de CI ou integra desenvolvedores a repositorios com SDKs fixados de forma estrita, esta e a ferramenta a observar. Acompanhe o progresso no [issue do dotnet/sdk sobre o uso do dotnetup em scripts de build](https://github.com/dotnet/sdk/issues/52699) e no [issue de conscientizacao que aponta que o branch main agora compila com ele](https://github.com/dotnet/sdk/issues/54601).
