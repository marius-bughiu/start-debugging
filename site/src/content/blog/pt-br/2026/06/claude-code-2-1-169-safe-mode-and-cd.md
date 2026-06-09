---
title: "Claude Code 2.1.169 adiciona --safe-mode e um /cd que mantém o cache de prompts aquecido"
description: "Claude Code v2.1.169 (8 de junho de 2026) traz uma flag --safe-mode que desativa todas as personalizações para depurar com clareza, e um comando /cd que move sua sessão para um novo diretório sem quebrar o cache de prompts no meio da execução."
pubDate: 2026-06-09
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/06/claude-code-2-1-169-safe-mode-and-cd"
translatedBy: "claude"
translationDate: 2026-06-09
---

Claude Code v2.1.169 chegou em 8 de junho de 2026 com duas mudanças que miram os dois momentos mais irritantes de uma sessão longa de agente: a espiral de depuração "é a minha configuração ou a ferramenta?" e a reinicialização do cache de prompts que você paga toda vez que precisa trabalhar em um diretório diferente. Ambas são flags pequenas. Ambas eliminam um custo real.

## `--safe-mode` dá a você uma base limpa para fazer a bissecção

Quando o Claude Code começa a se comportar de forma estranha, um hook dispara quando não deveria, um servidor MCP trava ao iniciar, uma skill sequestra um comando de barra, a pergunta difícil é se o erro está no CLI ou na sua própria pilha de personalizações. Até agora, responder isso significava mover o `CLAUDE.md` para o lado manualmente, comentar os hooks no `settings.json` e desativar plugins um por um.

A v2.1.169 condensa tudo isso em uma única flag:

```bash
# Start with CLAUDE.md, plugins, skills, hooks, and MCP servers all disabled
claude --safe-mode

# Same thing via env var, handy in CI or a wrapper script
CLAUDE_CODE_SAFE_MODE=1 claude
```

Se o problema desaparece no modo seguro, ele é seu, e você pode reativar as personalizações grupo por grupo até ele voltar. Se persiste, é do CLI, e você tem uma reprodução limpa para reportar. Esse é o equivalente, em um CLI de agente, a iniciar o Windows no modo seguro ou abrir um editor com `--disable-extensions`: não é uma correção, mas o caminho mais rápido para um veredito.

## `/cd` move a sessão sem reiniciar o cache

A outra mudança é mais sutil e economiza dinheiro de verdade em execuções longas. O Claude Code mantém em cache o prefixo da conversa com o cache de prompts da Anthropic, que tem um TTL curto e é o que mantém os turnos seguintes rápidos e baratos. Mudar seu diretório de trabalho costumava significar sair e reabrir, o que descartava esse cache. O turno seguinte relia todo o seu contexto sem cache: mais lento, e cobrado pela tarifa cheia de `cache_creation` em vez da tarifa barata de leitura de cache.

O novo comando `/cd` move uma sessão ativa para um novo diretório no lugar:

```text
# Working in the API project, now need to touch the shared library
/cd ../shared-lib

# Absolute paths work too
/cd C:\S\start-debugging\site
```

A sessão mantém seu histórico e seu cache aquecido, então o turno logo após o `/cd` ainda é um acerto de cache. Em uma tarefa multirrepo onde você pula entre uma árvore de backend e uma de frontend, essa é a diferença entre pagar por um contexto em cache e pagar por ele de novo a cada troca de diretório.

## Um terceiro botão que vale a pena conhecer

A mesma versão adiciona `disableBundledSkills` (e `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`), que oculta do modelo as skills, os workflows e os comandos de barra integrados do Claude Code. Se você tem o seu próprio conjunto bem definido e os integrados estão atrapalhando, esse é o seu interruptor de desligar.

Isso dá continuidade ao padrão das [correções de plugins e worktree da v2.1.128](/pt-br/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): mudanças discretas no CLI que removem uma classe de incômodos do fluxo diário. As notas completas estão na [página da versão v2.1.169](https://github.com/anthropics/claude-code/releases/tag/v2.1.169).
