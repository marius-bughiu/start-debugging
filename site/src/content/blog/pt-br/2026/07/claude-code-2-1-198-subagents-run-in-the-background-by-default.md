---
title: "Claude Code 2.1.198 executa os subagentes em segundo plano por padrão"
description: "Claude Code v2.1.198 (2026-07-01) muda os subagentes para execução em segundo plano por padrão, de modo que o agente principal continua trabalhando enquanto eles rodam, e agentes em segundo plano que mexem em código agora fazem commit, push e abrem um draft PR automaticamente ao terminar."
pubDate: 2026-07-06
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default"
translatedBy: "claude"
translationDate: 2026-07-06
---

Claude Code v2.1.198 saiu em 2026-07-01 e muda o modelo de execução padrão dos subagentes. Até agora, iniciar um subagente (a ferramenta Task, agentes personalizados, times de agentes) bloqueava o loop principal: você delegava um pedaço do trabalho, o agente pai ficava em silêncio e você esperava o filho retornar antes que qualquer outra coisa avançasse. A partir da 2.1.198, os subagentes rodam em segundo plano por padrão e o agente principal continua trabalhando enquanto eles rodam.

## Por que bloquear era o padrão errado

O objetivo de um subagente é o isolamento. Você entrega a ele um trabalho autocontido (varrer um diretório, verificar uma afirmação, redigir uma migração) com sua própria janela de contexto para que o pai não se afogue em despejos de arquivos. Mas se iniciar um congela o pai até ele terminar, você perde a outra metade do benefício: o paralelismo. Duas buscas independentes que poderiam ter rodado ao mesmo tempo rodavam uma após a outra, e o custo em tempo real era a soma, não o máximo.

Rodar em segundo plano por padrão corrige isso. O pai distribui o trabalho e continua na thread principal. Quando um filho termina, o resultado dele volta como uma notificação sobre a qual você pode agir, em vez de uma barreira atrás da qual você ficava esperando. Para qualquer coisa decomponível, essa é a diferença entre um pipeline e uma fila.

## Agentes em segundo plano que terminam o trabalho

A segunda metade da versão é o que os agentes em segundo plano fazem quando terminam. Se um agente em segundo plano fez trabalho de código em um git worktree, ele não para mais para perguntar o que fazer com o diff. Ele faz commit, push e abre um draft PR automaticamente, e então reporta de volta.

Essa é uma mudança real de fluxo de trabalho. O loop antigo era: iniciar o agente, esperar, revisar as mudanças propostas por ele, e então fazer commit e push você mesmo. O loop novo é: iniciar o agente, continuar trabalhando e encontrar um draft PR aguardando revisão quando ele chegar. O estado de rascunho é a trava de segurança: nada faz merge sozinho, mas o encanamento entre "o agente terminou" e "eu posso revisar um PR de verdade" desapareceu.

```bash
# Before 2.1.198: foreground subagent, main loop blocks until it returns.
# You then stage and push its changes by hand.

# 2.1.198+: subagent runs in the background, you keep working, and a
# code-writing background agent lands its work as a draft PR itself:
#   [background] agent "refactor-auth" finished
#   -> committed, pushed branch agent/refactor-auth, opened draft PR #482
```

Como o padrão mudou, vale a pena reler qualquer automação ou documentação que assumia que os subagentes eram síncronos. Passos que dependiam implicitamente de um subagente terminar antes de a próxima linha rodar agora precisam aguardar o resultado de forma explícita.

## O resto da 2.1.198

Outros dois itens vêm na mesma versão. Claude in Chrome agora está disponível de forma geral, tirando as ferramentas de controle do navegador da fase prévia. E há uma nova skill `/dataviz` para criar gráficos e dashboards. A versão também reforça a resiliência de rede diante de erros transitórios e corrige um lote de bugs de tarefas em segundo plano, times de agentes e Remote Control, o mesmo esforço de confiabilidade que continuou nas [correções de sessões em segundo plano da 2.1.200](/pt-br/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/).

Se você se apoia nos subagentes, mesmo que só um pouco, a manchete é pequena de enunciar e grande na prática: eles não fazem mais você esperar. As notas completas estão no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
