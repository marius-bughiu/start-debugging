---
title: "GitHub Copilot remove Claude Sonnet 4 de todas as superfícies"
description: "O GitHub descontinuou o claude-sonnet-4 em 6 de maio de 2026 no Copilot Chat, edições inline, modos ask e agent, e autocompletar de código. O alvo de migração recomendado é o Claude Sonnet 4.6. O que procurar com grep no seu repositório antes que a próxima seleção de modelo fixada quebre silenciosamente."
pubDate: 2026-05-10
tags:
  - "github-copilot"
  - "ai-agents"
  - "claude"
lang: "pt-br"
translationOf: "2026/05/copilot-deprecates-claude-sonnet-4-may-2026"
translatedBy: "claude"
translationDate: 2026-05-10
---

O GitHub [removeu o Claude Sonnet 4 de todas as superfícies do Copilot em 6 de maio de 2026](https://github.blog/changelog/2026-05-07-claude-sonnet-4-deprecated/). Não apenas do seletor de modelo no Chat. A descontinuação cobre Copilot Chat, edições inline, modo ask, modo agent e autocompletar de código. O alvo de migração recomendado é o Claude Sonnet 4.6 (`claude-sonnet-4-6`).

O changelog em si tem dois parágrafos curtos. A parte interessante é o que ele não diz.

## O que o anúncio realmente cobre

Textualmente: "We have deprecated the following model across all GitHub Copilot experiences (including Copilot Chat, inline edits, ask and agent modes, and code completions) on May 6, 2026."

Essa é a lista completa de superfícies nomeadas. O Copilot CLI não está enumerado. As instruções personalizadas também não. Se requisições fixadas em `claude-sonnet-4` são redirecionadas automaticamente para um sucessor ou se falham diretamente, não está especificado. "Please update your workflows and integrations to use supported models" é a única orientação de migração oferecida.

Se você está rodando o Sonnet 4 em qualquer lugar onde ele era selecionável, trate-o como removido e planeje de acordo. Não assuma que há um redirecionamento automático ativo.

## Onde o Sonnet 4 se esconde em um repositório típico

O seletor de modelo no IDE escolhe um lugar. O modelo fixado na configuração do seu repositório escolhe outro, e esse é o que silenciosamente para de funcionar. Três locais para rodar grep antes de você enviar a próxima mudança:

```bash
# 1. VS Code workspace and user settings
grep -R "claude-sonnet-4" .vscode/ "$HOME/.config/Code/User/settings.json" 2>/dev/null

# 2. Copilot custom agent / skill manifests
grep -R "claude-sonnet-4" .github/copilot/ .github/agents/ 2>/dev/null

# 3. Workflow files that invoke Copilot CLI or the Copilot agent
grep -R "claude-sonnet-4" .github/workflows/
```

A string a procurar é o id literal do modelo `claude-sonnet-4`. Não `claude-sonnet-4-5`, não `claude-sonnet-4-6`, ambos ainda suportados. Um localizar e substituir com fronteira de palavra é a jogada segura:

```bash
# Replace only the bare id, leave 4-5 and 4-6 alone
git ls-files | xargs sed -i 's/\bclaude-sonnet-4\b/claude-sonnet-4-6/g'
```

Em um arquivo de skill de agente Copilot ou de instrução personalizada, a mudança geralmente se parece com isto:

```yaml
# .github/copilot/agents/review.yml
- name: code-review
-   model: claude-sonnet-4
+   model: claude-sonnet-4-6
    instructions: |
      Review the diff against the project conventions.
```

## Por que o Sonnet 4.6 é o padrão certo, não o Opus 4.7

O Sonnet 4.6 é da mesma família, com perfil de latência similar, e notavelmente mais forte nos benchmarks de contexto longo e loop de agente nos quais o Sonnet 4 foi ajustado. Para revisão de PR, edições inline e loops de modo agent onde você dispara muitas chamadas baratas, o Sonnet 4.6 é o substituto direto. Recorra ao [Claude Opus 4.7 somente no trabalho que justifica o gasto](/pt-br/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), como diffs críticos para segurança ou refatorações difíceis.

Se você mantém um rollout do Copilot para um time, envie o link do anúncio, rode o grep e atualize o modelo fixado no mesmo PR. Descontinuações silenciosas que "funcionam na maior parte do tempo porque ninguém fixou o id" são as que te mordem numa terça de manhã quando o pipeline de um engenheiro é de repente o único build vermelho.
