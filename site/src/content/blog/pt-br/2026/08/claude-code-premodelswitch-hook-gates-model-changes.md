---
title: "PreModelSwitch: o Claude Code agora pode vetar uma troca de modelo"
description: "O Claude Code 2.1.251 adiciona os eventos de hook PreModelSwitch e PostModelSwitch. O matcher dispara com o nome canônico do modelo para o qual você troca, e o código de saída 2 cancela a troca."
pubDate: 2026-08-30
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "pt-br"
translationOf: "2026/08/claude-code-premodelswitch-hook-gates-model-changes"
translatedBy: "claude"
translationDate: 2026-08-30
---

Todos os eventos de hook que o Claude Code havia lançado antes desta semana vigiavam algo que o modelo faz: `PreToolUse` vê um comando Bash antes de ele rodar, `PermissionRequest` vê a solicitação antes de você respondê-la, `PreCompact` vê a transcrição antes de ela ser resumida. A versão 2.1.251, lançada em 2026-08-28, adicionou o primeiro par que vigia o próprio modelo. `PreModelSwitch` e `PostModelSwitch` disparam quando a sessão muda quais pesos estão respondendo.

## Por que uma troca de modelo merece um portão

O modelo de uma sessão não é uma preferência, é uma entrada. Troque Opus por Haiku no meio de uma refatoração e a próxima chamada de ferramenta será planejada por outro raciocinador sobre a mesma transcrição. As equipes se importam com isso por três motivos distintos: custo (uma troca de `/model` para cima pode multiplicar a conta dos turnos restantes), reprodutibilidade (um relato de bug que diz "o Claude fez X" é infalsificável se o modelo mudou no meio da sessão) e política (algumas organizações só têm autorização para enviar código a modelos específicos).

Até a 2.1.251 não havia costura alguma para aplicar nada disso. Agora há.

## Bloqueando uma troca

Registre o hook em `settings.json`. Aqui o matcher não é um nome de ferramenta: ele casa com o nome canônico do modelo *para o qual* a sessão está trocando:

```json
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-5",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-model-switch.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Matchers são expressões regulares, então tanto `claude-opus-4-6|claude-opus-5` quanto `.*opus.*` funcionam se você quiser pegar uma família inteira em vez de um único ID.

O hook lê o evento pelo stdin. `PreModelSwitch` e `PostModelSwitch` recebem `from_model` e `to_model` no lugar dos campos usuais de ferramenta, junto com `session_id`, `prompt_id`, `transcript_path` e `cwd`:

```bash
#!/usr/bin/env bash
to_model=$(jq -r '.to_model')

if [ -n "$OPUS_BUDGET_EXHAUSTED" ]; then
  cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Opus budget for this repo is spent. Staying on $to_model is blocked until the cycle resets."
  }
}
JSON
fi
exit 0
```

Sair com código 2 também bloqueia a troca, que é a versão de uma linha caso você não queira emitir JSON. Uma aresta afiada que vale conhecer: um hook `PreModelSwitch` cancelado no seu `timeout` também bloqueia a troca. Esse evento falha em modo fechado, ao contrário da maior parte do ciclo de vida.

## PostModelSwitch dispara quando você não pediu

`PostModelSwitch` é a metade de auditoria, e cobre mais do que as suas próprias chamadas de `/model`. Segundo a documentação, ele roda "after the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session". Esse é exatamente o caso que torna difícil responder depois "qual modelo escreveu isto", então acrescentar `from_model`, `to_model` e `session_id` a um arquivo de log aqui é a observabilidade mais barata que você vai adicionar na semana inteira.

A mesma versão também corrigiu as requisições do Opus 5 que falhavam com "effort is not supported when thinking is disabled" em effort xhigh ou max, e fechou [quatro formas distintas de contornar a verificação de permissão](/pt-br/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/). Todos os detalhes estão na [referência de hooks](https://code.claude.com/docs/en/hooks).
