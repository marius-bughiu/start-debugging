---
title: "Claude Code 2.1.200 Renomeia o Modo de Permissão default para Manual"
description: "O Claude Code v2.1.200 (3 de julho de 2026) renomeia o modo de permissão 'default' para 'Manual' na CLI, no VS Code e no JetBrains, e faz com que os diálogos AskUserQuestion parem de continuar sozinhos. O valor de configuração continua sendo 'default', com 'manual' aceito como alias."
pubDate: 2026-07-04
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual"
translatedBy: "claude"
translationDate: 2026-07-04
---

O Claude Code v2.1.200 foi lançado em 3 de julho de 2026, e faz duas coisas que afetam qualquer pessoa que executa o agente de forma interativa: renomeia o modo de permissão que você vinha chamando de "default" para "Manual", e altera os diálogos `AskUserQuestion` para que eles não avancem mais por conta própria. Nenhum dos dois é um recurso enorme, mas ambos mudam a memória muscular e, no segundo caso, eliminam um pequeno risco.

## Por que "default" era um nome ruim

O modo de permissão que revisa cada ação e pergunta antes de executar qualquer coisa era historicamente rotulado como "default". Esse nome dizia onde ele ficava em uma lista, não o que ele fazia. Novos usuários liam "default" e presumiam que era uma configuração passiva em vez do modo que barra cada chamada de ferramenta atrás de um prompt de aprovação.

O 2.1.200 rerotula ele como "Manual" em todo lugar em que um humano lê: o seletor da CLI, o `claude --help`, e as extensões do VS Code e do JetBrains. A questão é que o nome agora descreve o comportamento, você aprova cada passo manualmente.

Fundamentalmente, o valor de configuração não mudou. Hooks, o SDK e o seu `settings.json` existente ainda usam `default`, então nada quebra:

```jsonc
// Both of these mean the same mode
{ "permissions": { "defaultMode": "default" } }
{ "permissions": { "defaultMode": "manual" } }
```

```bash
# manual is accepted as an alias wherever you type the value
claude --permission-mode manual
claude --permission-mode default   # still valid
```

Se você faz scripts com o Claude Code ou compartilha uma configuração versionada com uma equipe, mantenha `default`, é o valor estável e canônico. Recorra a `manual` apenas quando estiver digitando manualmente e quiser que o rótulo corresponda ao que a interface agora exibe.

## AskUserQuestion para de continuar automaticamente

A segunda mudança é a que vale a pena destacar em revisão de código. A ferramenta `AskUserQuestion`, que é como o agente apresenta a você uma decisão de múltipla escolha no meio de uma tarefa, costumava continuar automaticamente após um período de inatividade, escolhendo uma opção destacada se você se ausentasse. Isso é conveniente até o momento em que ela silenciosamente compromete você com um rumo de trabalho que você não leu.

No 2.1.200 esses diálogos não continuam mais automaticamente por padrão. O agente espera por você. Se você de fato quer o antigo comportamento de "sair e deixar rodando", você opta por um tempo limite de inatividade explicitamente através do `/config` em vez de recebê-lo tendo pedido ou não. Esse é o mesmo instinto de "não decidir coisas irreversíveis em nome do usuário" por trás do [2.1.183 bloqueando comandos destrutivos de git e IaC no modo automático](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/).

## O resto da versão

O 2.1.200 é pesado em confiabilidade de agentes em segundo plano. Ele corrige sessões em segundo plano parando silenciosamente após suspender/retomar, um `daemon.lock` obsoleto cujo PID reutilizado impedia os agentes de iniciarem novamente, e subagentes interrompidos por um limite de taxa retornando um resultado vazio em vez de falhar de forma limpa. Há também uma correção de travamento na inicialização para quando `disabledMcpServers` ou `enabledMcpServers` no `.claude.json` está definido como um valor que não é array, além de um lote de melhorias para leitores de tela e uma correção de tremulação na renderização com tmux 3.4+.

Se você mantém uma configuração compartilhada de equipe, a conclusão é pequena mas real: o seu modo de permissão não mudou, apenas o nome de exibição dele mudou, e os seus diálogos interativos agora estão um pouco menos ansiosos para avançar sem você. As notas completas estão no [changelog do v2.1.200](https://code.claude.com/docs/en/changelog).
