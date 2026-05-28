---
title: "O servidor MCP de Dart e Flutter: um comando para entregar seu app Flutter em execução ao Claude Code"
description: "Dart 3.12 traz o dart mcp-server, a ponte MCP oficial para o toolchain de Dart e Flutter. Registre uma vez no Claude Code, Cursor ou Codex CLI e seu agente ganha hot reload, busca no pub.dev e introspecção de widgets ao vivo sem copiar e colar uma URI do DTD."
pubDate: 2026-05-28
tags:
  - "dart"
  - "flutter"
  - "mcp"
  - "claude-code"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/05/dart-flutter-mcp-server-claude-code-cursor"
translatedBy: "claude"
translationDate: 2026-05-28
---

No Google I/O 2026 (19 e 20 de maio), a equipe do Dart anunciou o Dart 3.12 junto com algo mais discreto, porém mais útil no dia a dia: o `dart mcp-server` oficial. Ele vem com o SDK a partir do Dart 3.9 e permite que qualquer agente de codificação compatível com MCP (Claude Code, Cursor, Gemini CLI, Codex CLI, GitHub Copilot no VS Code) controle seu app Flutter em execução sem precisar copiar e colar uma URI do Dart Tooling Daemon de novo. O status ainda é "experimental" nos [docs oficiais](https://docs.flutter.dev/ai/mcp-server), mas o caminho de instalação é estável entre clientes e vale a pena conectar agora.

A fricção que ele elimina é real. Antes, pedir a um agente para "corrigir esse texto vermelho na árvore de widgets" significava rodar o app, abrir o DevTools, copiar a URI de conexão do DTD, colar em um prompt de ferramenta e torcer para o agente não perder na próxima rodada. Agora o servidor MCP descobre o DTD sozinho e o agente apenas chama `hot_reload`.

## O que o servidor realmente expõe

Conforme os docs do servidor MCP de Dart e Flutter, as ferramentas se dividem em quatro grupos:

- **Projeto**: analisa e corrige erros pelo analysis server, resolve símbolos, busca docs de pacotes, pesquisa no pub.dev, edita o `pubspec.yaml`, formata com `dart format`.
- **Testes**: roda tests, parseia falhas e traz stack traces ao contexto do agente.
- **Runtime**: conecta a um app em execução via DTD, lista widgets, inspeciona estado, tira uma captura da árvore de renderização.
- **Hot reload**: disparado automaticamente após a edição do agente, sem passo manual.

Cada ferramenta retorna resultados conscientes do Dart. `analyze_files` devolve os mesmos diagnósticos do analysis server, não uma regex sobre a saída do compilador. `pub_search` consulta o pub.dev com a mesma pontuação usada pelo site. `get_runtime_errors` extrai exceções ao vivo do app em execução, incluindo o widget que as lançou.

## Conecte ao Claude Code

Um comando, a partir da raiz do projeto Flutter:

```bash
claude mcp add --transport stdio dart -- dart mcp-server
```

Isso registra `dart` como servidor MCP por stdio no seu workspace atual do Claude Code. O servidor descobre o DTD ativo a partir da raiz do workspace, então enquanto `flutter run` estiver vivo em outro terminal, `hot_reload` e `take_screenshot` ficam disponíveis automaticamente.

Para o Cursor, coloque isto em `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dart": {
      "command": "dart",
      "args": ["mcp-server"]
    }
  }
}
```

Para o Codex CLI, o SDK ainda tem uma lacuna na detecção de roots em alguns shells, então passe a flag de fallback:

```bash
codex mcp add dart -- dart mcp-server --force-roots-fallback
```

Quem usa o Copilot no VS Code não precisa de nada disso. Defina `dart.mcpServer: true` nas configurações (Dart Code v3.116 ou mais novo) e a extensão conecta o mesmo binário automaticamente.

## A pegadinha que vale conhecer

O servidor MCP é por SDK do Dart. Se você tem vários canais do Flutter instalados e o agente pega o `master` enquanto o projeto está no `stable`, as chamadas de ferramenta vão funcionar, mas falando com o analysis server errado, e você recebe respostas confusas tipo "símbolo não encontrado" para código que compila normalmente. Fixe o binário explicitamente em máquinas com vários canais:

```bash
claude mcp add --transport stdio dart -- /path/to/flutter/bin/dart mcp-server
```

Uma segunda pegadinha: o servidor espera uma única raiz de workspace. Se você abre um monorepo melos e deixa o agente circular entre pacotes, o hot reload continua mirando o app iniciado com `flutter run`. Passe `--force-roots-fallback` para o servidor usar as roots anunciadas pelo cliente em vez de adivinhar.

Para o changelog completo, veja nosso post anterior sobre [os parâmetros nomeados privados do Dart 3.12 e os formais inicializadores](/pt-br/2026/05/dart-3-12-private-named-parameters-initializing-formals/). O servidor MCP é a parte mais silenciosa desse release e provavelmente a que mais muda o seu loop diário.
