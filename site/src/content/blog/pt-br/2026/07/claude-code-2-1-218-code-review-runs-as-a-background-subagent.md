---
title: "Claude Code 2.1.218 executa /code-review como um subagente em segundo plano"
description: "A versão 2.1.218 move /code-review para fora da sua conversa principal, para um subagente em segundo plano, e as skills com contexto fork agora rodam em segundo plano por padrão. Veja o que mudou e como desativar."
pubDate: 2026-07-23
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "pt-br"
translationOf: "2026/07/claude-code-2-1-218-code-review-runs-as-a-background-subagent"
translatedBy: "claude"
translationDate: 2026-07-23
---

O Claude Code 2.1.218, lançado em 23 de julho de 2026, muda onde o `/code-review` roda. Em vez de expandir uma revisão longa dentro da conversa e empurrar o seu trabalho real para cima e para fora da vista, a revisão agora roda como um subagente em segundo plano. A sua conversa continua sendo sua. A revisão acontece ao lado, e você a consulta quando quiser.

## O que muda na 2.1.218

A manchete é pequena no changelog e grande no uso diário: o `/code-review` agora roda como um subagente em segundo plano. Três coisas decorrem disso.

A saída da revisão não enche mais a sua conversa. Uma revisão de código pode produzir dezenas de achados em muitos arquivos. Antes tudo isso caía na transcrição principal, soterrando o thread em que você estava trabalhando. Agora ele vive no subagente.

Os comandos slash empilhados permanecem como o alvo da revisão. Se você enfileirar `/code-review` atrás de outros comandos, a revisão ainda sabe o que deve examinar em vez de perder o alvo quando passa para segundo plano.

A navegação ganhou uma proteção. Pressionar `Esc` na visão do agente retorna você à conversa da qual a revisão foi enviada para segundo plano, então você não perde o seu lugar. A mesma versão também corrigiu a tecla de seta para a esquerda descartando silenciosamente uma conversa sem desfazer. Agora ela pede confirmação.

## O fim de uma mudança que começou na 2.1.215

Isso não surgiu do nada. Alguns builds antes, a 2.1.215 (19 de julho) parou de deixar o Claude rodar `/verify` e `/code-review` por conta própria. Você os invoca quando quer. A 2.1.218 estende a mesma ideia à pesquisa: `/deep-research` agora só começa quando você o invoca manualmente, e o Claude não o lança mais por conta própria.

Juntas, a mensagem é consistente. Skills longas, barulhentas e caras são opcionais e fora de banda. Elas não disparam automaticamente, e quando você as dispara, elas não tomam conta da sua sessão. Esse é o mesmo instinto por trás dos subagentes [rodando em segundo plano por padrão](/pt-br/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/) desde a 2.1.198.

## Skills com contexto fork agora rodam em segundo plano por padrão

Há uma mudança complementar que vale conhecer se você escreve skills. Skills com `context: fork` agora rodam em segundo plano por padrão. Isso combina com o comportamento do `/code-review` para as suas próprias skills que iniciam um contexto isolado.

Se você quer que uma skill fork fique em primeiro plano, desative por skill com um sinalizador no frontmatter:

```yaml
---
name: my-review-skill
context: fork
background: false
---
```

O parser de booleanos também ficou mais amigável na 2.1.218: `yes`, `no`, `on`, `off`, `1` e `0` agora são aceitos junto com `true` e `false` para os booleanos do frontmatter de skills e plugins, sem diferenciar maiúsculas.

## Por que isso importa

A conversa principal é onde você pensa. Qualquer coisa que despeje uma parede de saída nela custa a sua atenção, não apenas tokens. Mover a revisão e a pesquisa para subagentes em segundo plano mantém a transcrição legível e deixa o trabalho lento rodar sem bloquear você. Se você tem memória muscular do `/code-review` inundando a tela, atualize-a: rode, continue trabalhando, e consulte a visão do agente quando ele terminar.

Todos os detalhes estão no [changelog do Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
