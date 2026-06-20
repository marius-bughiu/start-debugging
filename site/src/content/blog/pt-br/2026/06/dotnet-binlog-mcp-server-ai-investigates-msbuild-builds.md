---
title: "O servidor MCP de Binlog deixa uma IA ler seus logs do MSBuild"
description: "A Microsoft lançou o Microsoft.AITools.BinlogMcp em 2026-06-17, um servidor MCP que expõe 15 ferramentas para que o Claude ou o Copilot diagnostiquem falhas de build e targets lentos direto de um arquivo .binlog."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds"
translatedBy: "claude"
translationDate: 2026-06-20
---

Em 2026-06-17 a Microsoft lançou o [servidor MCP de Binlog](https://devblogs.microsoft.com/dotnet/msbuild-binlog-mcp-server/), um servidor MCP que analisa os logs binários do MSBuild e entrega a um assistente de IA 15 ferramentas especializadas para investigá-los. A proposta é simples: em vez de abrir um `.binlog` de vários megabytes no MSBuild Structured Log Viewer e vasculhar targets aninhados na mão, você pergunta "por que meu build falhou?" e o modelo vai e lê o log por você.

## Por que um binlog é a superfície certa

Um log binário é o registro de maior fidelidade que o MSBuild produz. Ele captura cada target, tarefa, avaliação de propriedade e item, além dos arquivos-fonte que foram incorporados no momento do build. Esse detalhe é exatamente o que o torna doloroso de ler manualmente, e exatamente o que um modelo faz bem ao consultar. Ao colocar o analisador atrás do Model Context Protocol, o mesmo log funciona em qualquer cliente MCP: Claude Code, Copilot no VS Code ou Visual Studio.

Gere um da forma habitual:

```bash
dotnet build /bl:build-a.binlog
```

## Conectando ao cliente MCP

O servidor é publicado como a ferramenta dotnet `Microsoft.AITools.BinlogMcp`. No VS Code você aponta o `mcp.json` para ele via stdio:

```json
{
  "servers": {
    "binlog-mcp": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["tool", "run", "Microsoft.AITools.BinlogMcp"]
    }
  }
}
```

Se você quiser que o modelo abra um log específico na inicialização, passe-o após o separador `--`:

```json
{
  "args": ["tool", "run", "Microsoft.AITools.BinlogMcp", "--", "--binlog", "msbuild.binlog"]
}
```

O Visual Studio e o VS Code também podem incorporá-lo através do plugin `dotnet-msbuild` do marketplace `dotnet/skills`, que descobre o servidor automaticamente para que você pule o JSON por completo.

## As 15 ferramentas, agrupadas pelo que você de fato pergunta

As ferramentas se dividem em quatro tarefas. Para diagnosticar um build em vermelho há o `binlog_overview` (status, duração, contagem de erros e projetos), `binlog_errors`, `binlog_warnings` filtrável por código e `binlog_search`, que executa consultas de texto completo no DSL do StructuredLog. O destaque é o `binlog_explain_property`: ele rastreia de onde o valor de uma propriedade realmente veio, então uma pergunta como "por que `TargetFramework` está definido como net8.0 aqui?" recebe uma cadeia de avaliação em vez de um palpite.

Para builds lentos, `binlog_expensive_projects`, `binlog_expensive_targets` e `binlog_expensive_tasks` ordenam por tempo de relógio. E o `binlog_compare` faz o diff de dois logs, que é o que eu espero que justifique seu valor:

> Compare `build-a.binlog` e `build-b.binlog`. Quais propriedades do MSBuild e versões de pacotes mudaram?

Esse único prompt substitui a tediosa varredura lado a lado que você faz quando um build funciona na sua máquina e falha no CI.

Isso faz parte de um padrão mais amplo da Microsoft de envolver os diagnósticos do .NET em MCP para que os agentes possam operá-los. O servidor vive em [`dotnet/skills`](https://github.com/dotnet/skills); reporte os problemas lá. Se você tem um build de CI instável preso em um log que ninguém quer abrir, esta é a forma de menor esforço de apontar um modelo para ele.
