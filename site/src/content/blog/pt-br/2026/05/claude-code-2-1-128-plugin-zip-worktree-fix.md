---
title: "Claude Code 2.1.128 carrega plugins de arquivos .zip e para de descartar commits não enviados"
description: "Claude Code v2.1.128 (4 de maio de 2026) adiciona suporte de --plugin-dir para arquivos .zip, faz com que EnterWorktree crie o branch a partir do HEAD local e impede que o CLI vaze seu próprio endpoint OTLP para subprocessos do Bash."
pubDate: 2026-05-05
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/05/claude-code-2-1-128-plugin-zip-worktree-fix"
translatedBy: "claude"
translationDate: 2026-05-05
---

Claude Code v2.1.128 chegou em 4 de maio de 2026 com três mudanças que silenciosamente corrigem problemas de fluxo de trabalho que muitos de nós enfrentamos sem perceber: plugins agora podem ser carregados diretamente de um `.zip`, `EnterWorktree` finalmente cria o branch a partir do `HEAD` local em vez de `origin/<default>`, e subprocessos não herdam mais as variáveis de ambiente `OTEL_*` do próprio CLI. Nenhuma é chamativa, mas todas eliminam uma classe inteira de "espera aí, por que isso aconteceu?".

## `--plugin-dir` agora aceita arquivos zipados de plugins

Até v2.1.128, `--plugin-dir` só aceitava um diretório. Se você quisesse compartilhar um plugin interno com um colega ou fixar uma versão, tinha que enviar para um marketplace, comprometer a árvore descompactada no repositório ou escrever um script wrapper que descompactasse antes de iniciar. Nada disso escalava além de um ou dois plugins.

O novo comportamento é exatamente o que você espera:

```bash
# Old: had to point at an unpacked directory
claude --plugin-dir ./plugins/my-team-tooling

# New in v2.1.128: zip works directly
claude --plugin-dir ./plugins/my-team-tooling-1.4.0.zip

# Mix and match in the same launch
claude \
  --plugin-dir ./plugins/local-dev \
  --plugin-dir ./dist/release-bundle.zip
```

Há também uma correção nesta versão que combina com isso. O painel `/plugin` Components costumava mostrar "Marketplace 'inline' not found" para plugins carregados via `--plugin-dir`. v2.1.128 corrige isso. E o JSON `init.plugin_errors` do modo headless agora reporta falhas de carregamento de `--plugin-dir` (zip corrompido, manifest ausente) junto com os erros existentes de rebaixamento de dependência, para que scripts de CI possam falhar ruidosamente em vez de silenciosamente entregar um conjunto de plugins quebrado.

## `EnterWorktree` não descarta mais seus commits não enviados

Esta é uma correção de bug real disfarçada de mudança de comportamento. `EnterWorktree` é a ferramenta que Claude Code usa para criar um worktree isolado para uma tarefa de um agente. Antes desta versão, o novo branch era criado a partir de `origin/<default-branch>`, o que parece razoável até você perceber o que significa: qualquer commit que você tivesse local em `main` mas ainda não tivesse enviado simplesmente não fazia parte do worktree que o agente via.

Em v2.1.128, `EnterWorktree` cria o branch a partir do `HEAD` local, que é o que a documentação já afirmava. Concretamente:

```bash
# You're on main with a local-only commit
git log --oneline -2
# a1b2c3d feat: WIP rate limiter (NOT pushed)
# 9876543 chore: bump deps (origin/main)

# Agent calls EnterWorktree
# v2.1.126 and earlier: branch starts at 9876543, your WIP commit is GONE
# v2.1.128: branch starts at a1b2c3d, the agent sees your WIP
```

Se você já teve uma tarefa longa de um agente que silenciosamente pulou a mudança que você fez cinco minutos atrás, esta provavelmente é a razão.

## Variáveis de ambiente OTEL não vazam mais para subprocessos

O próprio Claude Code é instrumentado com OpenTelemetry e lê `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` e companhia do ambiente. Até v2.1.128 essas variáveis eram herdadas por cada subprocesso que o CLI lançava: chamadas da ferramenta Bash, hooks, servidores MCP, processos LSP. Se você rodasse uma aplicação .NET via ferramenta Bash que também fosse instrumentada com OTel, ela alegremente enviava seus traces para o coletor do CLI.

A correção em v2.1.128 remove `OTEL_*` do ambiente antes do exec. Suas aplicações agora usam o endpoint OTLP com o qual foram configuradas, não o que o seu editor por acaso reporta. Se você genuinamente quer que um processo filho compartilhe o coletor do CLI, defina a variável explicitamente no seu script de execução.

Alguns outros itens notáveis: o `/color` puro agora escolhe uma cor de sessão aleatória, `/mcp` mostra a contagem de ferramentas por servidor e sinaliza os que se conectaram com zero ferramentas, chamadas paralelas a ferramentas de shell não cancelam mais chamadas irmãs quando um comando somente leitura (`grep`, `git diff`) falha, e os resumos de progresso de subagentes finalmente atingem o cache de prompts para aproximadamente 3x menor custo de `cache_creation` em execuções multi-agente carregadas. O modo Vim também recebeu uma correção pequena mas correta: `Space` em modo NORMAL move o cursor para a direita, combinando com o comportamento real do vi.

Isso continua a tendência que a [versão v2.1.126 com project purge](/pt-br/2026/05/claude-code-2-1-126-project-purge/) iniciou: mudanças pequenas e direcionadas no CLI que tiram instrumentos contundentes das mãos do usuário. As notas completas estão na [página da versão v2.1.128](https://github.com/anthropics/claude-code/releases/tag/v2.1.128).
