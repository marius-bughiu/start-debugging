---
title: "Azure MCP Server vem embutido no Visual Studio 2022 17.14.30, sem extensão necessária"
description: "Visual Studio 2022 17.14.30 embute o Azure MCP Server no workload de desenvolvimento Azure. Copilot Chat pode chegar a 230+ ferramentas Azure em 45 serviços sem instalar nada."
pubDate: 2026-04-22
tags:
  - "visual-studio"
  - "azure"
  - "mcp"
  - "github-copilot"
lang: "pt-br"
translationOf: "2026/04/azure-mcp-server-visual-studio-2022-17-14-30"
translatedBy: "claude"
translationDate: 2026-04-24
---

O [post do blog do Visual Studio](https://devblogs.microsoft.com/visualstudio/azure-mcp-tools-now-ship-built-into-visual-studio-2022-no-extension-required/) de 15 de abril de 2026 escondeu uma mudança discreta mas significativa: a partir do Visual Studio 2022 versão 17.14.30, o Azure MCP Server faz parte do workload de desenvolvimento Azure. Sem extensão de marketplace, sem `mcp.json` manual, sem onboarding por máquina. Se você tem o workload instalado e assinou tanto no GitHub quanto no Azure, o Copilot Chat já pode ver mais de 230 ferramentas Azure em 45 serviços.

## Por que embutir

Até o 17.14.30, colocar o Azure MCP Server na frente do Copilot Chat no VS 2022 significava uma instalação separada, uma config JSON por usuário, e uma dança de reautenticação toda vez que o server lançado via npx perdia o token. Empacotar o server com o workload remove o passo de instalação e amarra a auth ao account picker Azure existente da IDE, então o mesmo login que dirige o Cloud Explorer dirige as ferramentas MCP.

Também traz o VS 2022 para paridade com o VS 2026, que tem a integração Azure MCP desde novembro de 2025.

## Ligando

O server vem com o workload mas está desabilitado por padrão. Para acender:

1. Atualize o Visual Studio 2022 para 17.14.30 ou superior (Help, Check for Updates).
2. Abra o Visual Studio Installer e confirme que o workload de desenvolvimento Azure está instalado.
3. Assine na sua conta GitHub para o Copilot estar ativo, depois assine na sua conta Azure pelo account picker na barra de título.
4. Abra o Copilot Chat, clique no ícone de chave inglesa com a label "Select tools," e ative "Azure MCP Server."

Depois disso o server inicia sob demanda na primeira vez que o Copilot escolhe uma ferramenta Azure. Dá para verificar de um prompt de chat:

```text
> #azmcp list resource groups in subscription Production
```

O Copilot vai rotear pelo server embutido e retornar a lista ao vivo, escopada na conta em que você assinou. O mesmo diálogo da chave inglesa mostra ferramentas individuais, então você pode desabilitar as barulhentas (por exemplo, as de custo) sem desabilitar o server inteiro.

## O que você realmente ganha

O server embutido expõe a mesma superfície de ferramentas documentada em [aka.ms/azmcp/docs](https://aka.ms/azmcp/docs), agrupadas em quatro baldes:

- **Learn**: faça perguntas de forma de serviço ("qual tier do Azure SQL suporta private link com uma replica serverless") sem sair da IDE.
- **Design and develop**: pegue snippets de config e chamadas de SDK ancoradas nos recursos da sua subscription, não em samples genéricos.
- **Deploy**: provisione resource groups, deployments Bicep, e container apps do chat.
- **Troubleshoot**: puxe queries do Application Insights, streams de log do App Service, e status de pods AKS para dentro da conversa.

Um chat como "o app service de staging está retornando 502, puxe a última hora de falhas e me diga o que mudou" agora executa de ponta a ponta sem copy paste entre abas do portal.

## Quando o server standalone ainda faz sentido

O build embutido segue a cadência de servicing do VS, que atrasa em relação às releases upstream de `Azure.Mcp.Server`. Se você precisa de uma ferramenta que aterrissou semana passada, registre o server standalone ao lado do embutido no `mcp.json` e o Copilot vai mesclar as listas de ferramentas. Para todo mundo, apagar esse arquivo de config é agora a jogada certa.
