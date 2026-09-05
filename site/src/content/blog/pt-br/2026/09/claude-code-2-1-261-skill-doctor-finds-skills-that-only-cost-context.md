---
title: "Claude Code 2.1.261 adiciona /skill-doctor: encontre as skills que só custam contexto"
description: "O corpo de uma skill carrega sob demanda, mas o nome e a descrição ficam em uma listagem que está sempre no prompt, limitada a 1% da janela de contexto. O Claude Code 2.1.261 adiciona /skill-doctor para dizer quais skills carregadas nunca são usadas e quanto cada uma custa, para você podá-las antes que o orçamento comece a despejar as que você realmente usa."
pubDate: 2026-09-05
tags:
  - "claude-code"
  - "agent-skills"
  - "ai-agents"
  - "context-window"
lang: "pt-br"
translationOf: "2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context"
translatedBy: "claude"
translationDate: 2026-09-05
---

O Claude Code 2.1.261 saiu em 4 de setembro com um comando pequeno que responde a uma pergunta que quase ninguém com um diretório `~/.claude/skills` cheio conseguiu responder: `/skill-doctor` mostra quais skills carregadas ficam sem uso e quanto custam em contexto, para você podá-las. O comando ainda não está na [referência de comandos](https://code.claude.com/docs/en/commands), mas o mecanismo sobre o qual ele reporta está documentado, e vale entendê-lo antes de ler a saída.

## Uma skill que você nunca invoca não é de graça

O modelo mental comum é que skills são baratas porque carregam de forma preguiçosa. Isso é meia verdade. O corpo de um `SKILL.md` só entra na conversa quando a skill é invocada. O nome e a descrição, não: o Claude Code carrega no contexto uma listagem com o nome e a descrição de cada skill para o modelo saber o que existe.

Essa listagem tem um orçamento fixo. Segundo a [documentação de skills](https://code.claude.com/docs/en/skills), ela "scales at 1% of the model's context window", e o texto combinado de cada entrada é limitado a 1.536 caracteres de qualquer forma. Quando a listagem estoura o orçamento, o Claude Code começa a descartar descrições, a partir das skills que você menos invoca.

Ou seja, uma skill sem uso custa mais do que os próprios tokens. Ela disputa um orçamento compartilhado com as skills das quais você depende, e uma descrição cortada perde exatamente as palavras-chave de que o modelo precisa para casar com a sua solicitação. O resultado é uma skill que para de disparar silenciosamente, sem nenhum erro para explicar o motivo. O `/doctor` já estimava o custo total da listagem e seus maiores contribuintes; o 2.1.261 separa em relatório próprio a visão por skill, usadas contra não usadas.

## Transformando o relatório em configuração

Depois de saber quais entradas são peso morto, `skillOverrides` em `.claude/settings.json` muda a visibilidade sem mexer no `SKILL.md` de um repositório compartilhado:

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "user-invocable-only",
    "old-migration-helper": "off"
  }
}
```

`"name-only"` mantém a skill listada mas remove a descrição, liberando orçamento. `"user-invocable-only"` esconde a skill do modelo e deixa `/deploy` disponível para você digitar. `"off"` esconde dos dois. Para uma skill sua, o equivalente no frontmatter é `disable-model-invocation: true`, que tira a descrição do contexto por completo. Vale lembrar que skills de plugins ignoram `skillOverrides`; essas você gerencia com `/plugin`.

Se o relatório disser que toda skill merece seu lugar, aumente o teto em vez de cortar: `skillListingBudgetFraction` recebe uma fração (`0.02` para 2%), `SLASH_COMMAND_TOOL_CHAR_BUDGET` recebe uma contagem fixa de caracteres e `skillListingMaxDescChars` move o limite de 1.536 caracteres por entrada. Depois confirme na linha Skills do `/context`, que desde a v2.1.196 reporta o tamanho da listagem já com o orçamento aplicado, e não o texto completo.

A mesma versão traz outros dois controles de contexto que valem a pena: `bashOutputMaxChars` e `taskOutputMaxChars` aumentam quanta saída de comandos e de tarefas em segundo plano o Claude recebe inline antes de ela ir para um arquivo, até 128K caracteres, e `--append-subagent-system-prompt-file` lê o prompt de sistema de um subagente de um arquivo quando ele é grande demais para a linha de comando. Se você está atrasado no trem de versões, [o 2.1.259 adicionou managedMcpServers](/pt-br/2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm/) dois dias antes.

Todos os detalhes no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
