---
title: "Cursor 3.3 traz Build in Parallel, Split PRs e uma revisão de PR unificada"
description: "Cursor 3.3 (7 de maio de 2026) lança subagentes assíncronos que trabalham em passos independentes de um plano ao mesmo tempo, uma ação rápida que divide um chat em vários pull requests, e um fluxo de revisão de PR redesenhado que mantém revisões, commits e mudanças em um só lugar."
pubDate: 2026-05-11
tags:
  - "cursor"
  - "ai-agents"
  - "pull-requests"
  - "subagents"
lang: "pt-br"
translationOf: "2026/05/cursor-3-3-build-in-parallel-split-prs"
translatedBy: "claude"
translationDate: 2026-05-11
---

Em 7 de maio de 2026, o Cursor lançou a [versão 3.3](https://cursor.com/changelog/05-07-26). É uma versão que reforça a mesma mudança que a [versão prévia do SDK TypeScript](/pt-br/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) já sugeria: agentes não são mais uma única linha de trabalho presa a um chat. Os recursos de destaque, "Build in Parallel", "Split PRs" e uma superfície redesenhada de revisão de PRs, empurram o editor para perto de uma IDE multiagente onde uma pessoa supervisiona várias execuções simultâneas.

## Build in Parallel transforma um plano em subagentes assíncronos

O planejamento já fazia parte do loop do Cursor: você esboça um plano e o agente percorre os passos. Na 3.3, uma nova ação "Build in Parallel" pega esse plano, identifica os passos independentes e dispara subagentes assíncronos que trabalham em cada um ao mesmo tempo. O Cursor ainda mantém os passos dependentes em sequência quando o plano implica uma ordem, então você não precisa marcar o grafo manualmente.

Se você preferir o sabor de CLI, existe um comando `/multitask` que controla a mesma maquinaria a partir do chat:

```text
/multitask
- Wire the Stripe webhook handler
- Add a Polly retry policy around the OpenAI client
- Rewrite the README install section
```

Cada item roda em seu próprio contexto de subagente. Os subagentes compartilham o workspace por meio de snapshots, não o mesmo buffer, então duas edições concorrentes no mesmo arquivo não brigam mais. O subagente Explore agora também aceita um seletor de modelo (`model: opus`, `model: parent` ou `disabled`), o que significa que o salto barato de "ache o código relevante" pode rodar em um modelo menor do que o escritor.

## Split PRs fatia um chat em vários

Qualquer um que tenha deixado um agente rodar por uma hora conhece a dor: quando você o para, o diff cobre quatro mudanças sem relação e revisar como um único PR é impossível. A nova ação rápida "Split into PRs" analisa a transcrição do chat, agrupa os commits por preocupação lógica e abre um PR por grupo. O Cursor mantém os PRs independentes a menos que detecte uma dependência real, e nesse caso os liga com uma nota "depends on".

Antes da divisão é criado um snapshot de segurança, e o Cursor pede aprovação antes de fazer push.

## PR Review unifica três abas em um único fluxo

A terceira peça é uma visão de PR redesenhada dentro do editor. Três abas substituem a antiga divisão entre o GitHub e o painel do agente:

- **Reviews**: threads de revisão em linha e comentários de PR de nível superior, com ações rápidas para responder ou aceitar.
- **Commits**: uma lista de commits focada no PR, para você percorrer passo a passo o histórico do agente.
- **Changes**: uma árvore de arquivos mais um seletor, a parte que você nota quando o PR toca quarenta arquivos.

Juntos, os três recursos esboçam a mesma direção que o [SDK TypeScript do Cursor](/pt-br/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) apontava: a unidade de trabalho não é mais "um prompt, um diff", é "um plano, muitos subagentes, muitos PRs".
