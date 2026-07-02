---
title: "Rode o Binlog MCP Server no CI para diagnosticar falhas de build automaticamente"
description: "Em 2026-06-30 a Microsoft mostrou o Binlog MCP Server rodando sem supervisão em um GitHub Agentic Workflow, para que um agente leia o .binlog e comente a causa raiz assim que um build de CI falha."
pubDate: 2026-07-02
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
  - "ci"
lang: "pt-br"
translationOf: "2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures"
translatedBy: "claude"
translationDate: 2026-07-02
---

Em 2026-06-30 o time do .NET publicou [MCP Beyond the Chat Window: Build Diagnostics in CI](https://devblogs.microsoft.com/dotnet/mcp-build-diagnostics-workflows/), e ele tira o Binlog MCP Server do seu editor e o coloca dentro do seu pipeline. Duas semanas atrás esse servidor era algo para o qual você apontava o Claude ou o Copilot na mão, a partir de um `.binlog` local (cobri essa configuração em [O Binlog MCP Server deixa uma IA ler seus logs do MSBuild](/pt-br/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/)). A nova demonstração o roda sem supervisão no GitHub Actions: o build falha, um agente lê o log e um comentário com a causa raiz aparece no pull request antes de alguém baixar qualquer coisa.

## Por que o CI é o melhor lugar para um binlog

A história interativa é boa, mas a dor de verdade está no CI. Um build fica vermelho, você puxa um log binário de vários megabytes do runner, abre o MSBuild Structured Log Viewer e percorre targets aninhados procurando o único erro que importa. Mover o parser para o pipeline elimina todo esse ciclo. O `.binlog` nunca sai do runner, e o modelo faz a leitura.

Você ainda gera o log da mesma forma. Adicione `/bl` a qualquer comando baseado em MSBuild:

```bash
dotnet build /bl
dotnet test /bl
dotnet pack /bl
```

## Ligando isso a um GitHub Agentic Workflow

A diferença principal é que o servidor é distribuído como uma imagem de contêiner, então o workflow monta o log em modo somente leitura e deixa o agente consultá-lo. O repositório `microsoft/testfx` usa mais ou menos este formato:

```yaml
mcp-servers:
  binlog-mcp:
    container: "mcr.microsoft.com/dotnet-buildtools/prereqs:azurelinux-3.0-binlog-mcp-amd64"
    mounts:
      - "/tmp/build.binlog:/data/build.binlog:ro"
    allowed: ["*"]
```

O job roda o build com um log binário, e somente quando o build falha ele acorda o agente. Nada roda no verde, então você não paga nenhum custo de tokens pelos builds que passam.

## binlog_diagnose faz a primeira passada

A ferramenta que torna isso prático é `binlog_diagnose`. Em vez de o agente encadear `binlog_errors`, `binlog_search` e `binlog_target_reasons` por conta própria, `binlog_diagnose` lê o log, agrupa os erros, identifica a provável causa raiz e sugere uma correção em uma única chamada. O resto do conjunto (`binlog_overview`, `binlog_compare`, `binlog_task_details` e uma lista crescente de outras que cobrem desempenho, grafos de dependência e introspecção de builds incrementais) continua ali quando o agente precisa se aprofundar.

Na própria avaliação da Microsoft, dar essas ferramentas ao agente moveu a pontuação de qualidade do diagnóstico de 3,25 para 3,68 em relação a uma linha de base sem ferramentas, e ele terminou cerca de 44% mais rápido (196s vs 350s de tempo total). Mais rápido e melhor é uma combinação rara, e vem do agente consultar dados estruturados em vez de fazer grep em texto de log cru.

Se você tem um build de CI instável que continua produzindo um log que ninguém quer abrir, esta é a versão da configuração que de fato economiza tempo do seu time: a triagem acontece automaticamente, no PR, enquanto a falha ainda está fresca.
