---
title: "Claude Code agora nomeia a causa provável de um miss no cache de prompt"
description: "Claude Code 2.1.260 adiciona um diagnóstico de causa provável à linha Prompt cache (main) do /usage e ao objeto prompt_cache da status line. Em vez de apenas contar os misses, ele diz se o conjunto de ferramentas mudou, se o system prompt mudou ou se o TTL expirou."
pubDate: 2026-09-07
tags:
  - "claude-code"
  - "ai-agents"
  - "prompt-caching"
  - "token-cost"
lang: "pt-br"
translationOf: "2026/09/claude-code-now-names-the-likely-cause-of-a-prompt-cache-miss"
translatedBy: "claude"
translationDate: 2026-09-07
---

Claude Code 2.1.260 trouxe um diagnóstico que fecha uma lacuna antiga na depuração de custos: quando o cache de prompt dá miss, agora ele diz por quê. A versão 2.1.251 já tinha adicionado uma linha `Prompt cache (main)` ao bloco Session do `/usage`, mas essa linha só contava os misses. Saber que você pagou por três releituras completas de uma conversa de 300k tokens não diz o que parar de fazer. A partir de 2.1.260, a linha nomeia uma causa provável, por exemplo `likely cause: tool definitions changed`.

## Por que um miss é caro e invisível

Claude Code reenvia a conversa inteira a cada turno, então o cache é o que mantém uma sessão longa viável. A API faz a correspondência pelo prefixo da requisição, e a correspondência é exata: uma mudança em qualquer ponto do prefixo recalcula tudo o que vem depois. Não existe cache por arquivo nem por segmento. É por isso que a [documentação de prompt caching](https://code.claude.com/docs/en/prompt-caching) lista um conjunto específico de ações que invalidam o cache, incluindo trocar de modelo, conectar ou desconectar um servidor MCP quando a busca de ferramentas não está adiando as ferramentas dele, negar uma ferramenta inteira com uma regra deny simples como `Bash`, e atualizar o próprio Claude Code.

O problema é que a maioria dessas ações é invisível. Um servidor MCP stdio cujo processo encerra silenciosamente, ou uma sessão HTTP que expira, muda suas definições de ferramentas no meio da sessão sem nenhuma mensagem no transcript. Você vê um turno lento e uma fatura.

Claude Code conta uma requisição como miss quando ela reprocessou mais de 5% e pelo menos 2.000 tokens do que poderia ter lido do cache, sem uma compactação ou limpeza de resultados de ferramentas que explique a diferença. Reconstruções causadas por compactação são contadas separadamente como expected rebuilds, o que mantém a contagem de misses honesta.

## Lendo a causa a partir de uma status line

A parte interessante para quem escreve scripts de status line é que o diagnóstico é estruturado, não apenas texto. O objeto `prompt_cache` ganhou `last_miss_cause` e `miss_causes` na 2.1.260. O array `causes` guarda nomes como `tools_changed`, `system_prompt_changed`, `ttl_expired_5m` ou `likely_server_side`, e dois deles carregam contagens: `tools_changed` vem com `tools_added` e `tools_removed`, e `system_prompt_changed` vem com `system_char_delta`.

```bash
#!/bin/bash
input=$(cat)
cause=$(echo "$input" | jq -r '.prompt_cache.last_miss_cause.causes[0] // empty')
ratio=$(echo "$input" | jq -r '.prompt_cache.hit_ratio // 0')
printf "cache %.0f%%" "$(echo "$ratio * 100" | bc -l)"
[ -n "$cause" ] && printf " | last miss: %s" "$cause"
```

`last_miss_cause` é `null` até o primeiro miss da sessão, e também sempre que Claude Code não consegue identificar uma causa, então proteja a leitura. `miss_causes` é o agregado: uma sessão que mostra `tools_changed` cinco vezes tem um servidor MCP instável, não um caso isolado.

As contagens vêm dos campos de token de cache na resposta da API, então tudo isso funciona no Bedrock, no Google Cloud's Agent Platform e através de um gateway. Cobre apenas a conversa principal, não os subagentes, e `/clear` reinicia a contagem.

A mesma versão também adicionou um painel `/diff` que abre ao lado da conversa em tela cheia e acompanha as mudanças não commitadas enquanto Claude edita. Se você está acompanhando a sequência de releases, [a 2.1.261 adicionou o /skill-doctor](/pt-br/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) no dia seguinte. As notas completas estão no [release v2.1.260](https://github.com/anthropics/claude-code/releases/tag/v2.1.260), e a referência de campos está na [documentação da status line](https://code.claude.com/docs/en/statusline#prompt-cache-fields).
