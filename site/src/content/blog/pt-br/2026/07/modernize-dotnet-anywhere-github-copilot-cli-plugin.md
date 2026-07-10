---
title: "O agente de modernização do .NET agora roda na CLI do Copilot, não só no Visual Studio"
description: "O agente modernize-dotnet do GitHub Copilot foi lançado como plugin portátil em 2026-07-09. Ele agora roda no VS Code, na CLI do Copilot e no GitHub, com um fluxo de avaliar, planejar e executar cujos artefatos são registrados no seu repositório para revisão."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
lang: "pt-br"
translationOf: "2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin"
translatedBy: "claude"
translationDate: 2026-07-10
---

Durante boa parte do último ano, as ferramentas de modernização de .NET do GitHub Copilot tiveram apenas uma casa: o Visual Studio. Se sua equipe vivia no VS Code, na linha de comando ou revisava tudo por meio de pull requests, a experiência de "atualize meu aplicativo legado" ficava em um lugar onde você não trabalhava. Em 2026-07-09, a Microsoft [lançou o agente `modernize-dotnet` como um plugin portátil](https://devblogs.microsoft.com/dotnet/modernize-dotnet-anywhere-with-ghcp/) que roda em quatro superfícies: Visual Studio, VS Code, a CLI do GitHub Copilot e o próprio GitHub.

## Por que "em qualquer lugar" realmente importa aqui

A modernização não é um comando de um único passo. É avaliar, planejar e depois uma longa sequência de transformações de código que você acompanha. Forçar isso dentro de um único IDE significava que a pessoa conduzindo a atualização tinha que mudar de contexto para fora do seu ambiente normal em um trabalho que costuma durar vários dias. Mover o mesmo agente para a CLI permite que desenvolvedores que preferem o terminal o executem ao lado do seu ciclo de build e teste, e colocá-lo no GitHub permite que a atualização aconteça como uma unidade de trabalho revisável e colaborativa, em vez da sessão local de uma única pessoa.

O fluxo de trabalho é o mesmo em todos os lugares, e esse é o ponto. O agente segue um modelo de avaliar, planejar e executar e escreve três artefatos no seu repositório:

1. Uma **avaliação** que expõe o escopo e os bloqueios antes de qualquer mudança de código.
2. Um **plano de atualização** que sequencia o trabalho.
3. **Tarefas de atualização** que aplicam as transformações reais.

Como esses artefatos são registrados no repositório, sua equipe revisa o plano do mesmo jeito que revisa um PR, antes de a execução tocar em uma única linha de código.

## Executando pela CLI do Copilot

O caminho da CLI instala o agente como um plugin e depois o controla com linguagem natural. Os comandos são curtos:

```bash
# Add the plugin marketplace and install the agent
/plugin marketplace add dotnet/modernize-dotnet
/plugin install modernize-dotnet@modernize-dotnet-plugins

# Select the agent, then describe the job
/agent modernize-dotnet
upgrade my solution to a new version of .NET
```

A partir daí, o agente gera a avaliação, propõe o plano e aplica as tarefas com aprovação humana no loop a cada passo. Ele cuida das partes pouco glamorosas de uma atualização: subir o target framework, atualizar as dependências e corrigir os erros de compilação que uma mudança de `TargetFramework` deixa para trás.

## O que ele cobre hoje

As cargas de trabalho suportadas incluem ASP.NET Core, Blazor, Azure Functions, WPF, bibliotecas de classes e aplicativos de console, além de migrações do .NET Framework para o .NET moderno. Web Forms ainda não está no escopo. Se você experimentou a versão só para Visual Studio antes e achou difícil encaixá-la no fluxo de trabalho de uma equipe, este é o lançamento que corrige o modelo de entrega, não a capacidade.

O agente é desenvolvido de forma aberta em [dotnet/modernize-dotnet](https://github.com/microsoft/github-copilot-appmod), e a distribuição em quatro superfícies já está disponível. A mudança interessante não é que o Copilot consiga atualizar código .NET, é que a atualização agora é um artefato do repositório que você revisa, não uma caixa-preta dentro de um único editor.
