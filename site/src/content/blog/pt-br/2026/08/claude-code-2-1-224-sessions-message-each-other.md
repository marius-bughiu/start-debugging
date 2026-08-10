---
title: "Claude Code 2.1.224 deixa uma sessão mandar mensagem para outra"
description: "A mensageria entre sessões chegou em 2026-08-07. ListAgents e SendMessage movem texto puro entre suas sessões, e crossSessionInbound decide o que realmente chega."
pubDate: 2026-08-10
tags:
  - "claude-code"
  - "ai-agents"
  - "developer-tools"
lang: "pt-br"
translationOf: "2026/08/claude-code-2-1-224-sessions-message-each-other"
translatedBy: "claude"
translationDate: 2026-08-10
---

Dois terminais, o mesmo repositório. O que está rodando a migração acabou de renomear uma coluna contra a qual o outro ainda escreve consultas. Até semana passada, a correção era você, copiando e colando entre janelas. O Claude Code 2.1.224, publicado em 2026-08-07, fecha esse ciclo: uma sessão pode entregar uma mensagem a outra sessão na mesma máquina.

## ListAgents encontra, SendMessage entrega

Duas ferramentas fazem o trabalho, e você não chama nenhuma delas. `ListAgents` enumera os agentes que uma sessão consegue alcançar, `SendMessage` endereça um deles pelo nome. Você descreve a intenção:

```text
Tell the session working on the payments API that the tenant_id column landed
```

O Claude escreve o texto da mensagem sozinho. Para ver a lista você mesmo, execute `/list-agents`, que também tem o alias `/peers`. Uma sessão atende pelo nome que você definiu com `--name` ou `/rename`; sem nenhum, o Claude Code deriva um nome do diretório de trabalho, como `myapp-3f`.

A entrega dentro da mesma máquina passa por um socket Unix por sessão e nunca atravessa os servidores da Anthropic. `/status` mostra o caminho em uma linha `Peer address`, e hooks e comandos Bash o recebem como `CLAUDE_CODE_MESSAGING_SOCKET`, que é por onde um script escreve de volta para a sessão que o iniciou.

Os requisitos são estreitos: v2.1.224 ou posterior, macOS ou Linux (WSL 2 conta, Windows nativo não), e nada de Amazon Bedrock, Google Cloud's Agent Platform ou Microsoft Foundry.

## O que o canal se recusa a carregar

Uma mensagem é texto puro. Não é histórico de conversa, nem arquivos, nem permissões. Na chegada, o Claude Code avisa a sessão receptora de que o texto veio de outro agente e não de você, e esse enquadramento tem dentes: a mensagem não pode responder a um pedido de permissão pendente, não pode convencer o receptor a reescrever o `CLAUDE.md` ou suas regras de permissão, e um `/compact` no corpo chega como texto inerte em vez de comando.

O tratamento do que entra é uma configuração, `crossSessionInbound`, com três valores: `accept`, `hold` e `refuse`. Sem nada definido, o Claude Code decide mensagem a mensagem comparando as classes de modo de permissão das duas sessões. Uma sessão em `bypassPermissions` retém tudo que vem de uma sessão que pergunta, e uma sessão que pergunta retém tudo que vem de uma que pula as perguntas. Mensagens retidas abrem um diálogo de aprovação que expira em cinco minutos, ajustável via `dialogExpiry`.

Esse padrão explica por que um worker headless fica em silêncio. Uma sessão `claude -p` abre um socket de caixa de entrada e aparece na listagem, mas não consegue renderizar um diálogo de aprovação, então a mensagem retida continua retida. Dê a ela um accept explícito no valor de `--settings`:

```json
{
  "crossSessionInbound": "accept"
}
```

Desligar é a imagem espelhada, e administradores podem impor isso pelas configurações gerenciadas:

```json
{
  "permissions": {
    "deny": ["SendMessage", "ListAgents"]
  },
  "crossSessionInbound": "refuse"
}
```

Negar `SendMessage` também remove a mensageria para subagentes e para colegas de um time de agentes, já que a mesma ferramenta serve aos dois casos. Se você depende do [aninhamento de três camadas que a 2.1.219 reabriu](/pt-br/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/), essa regra de negação custa mais do que parece.

## Entre máquinas, um dia depois

A versão 2.1.225, publicada em 2026-08-08, estende o alcance. Segundo o [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), o `SendMessage` agora pode iniciar uma conversa pelo nome com suas sessões de Remote Control em outras máquinas, e o `ListAgents` as mostra como `name [ref]`. Antes disso, o tráfego entre máquinas era só de resposta, que é como a [documentação](https://code.claude.com/docs/en/cross-session-messaging) ainda descreve.

Essas mensagens de fato passam pelos servidores da Anthropic sobre a conexão de Remote Control, então existe um interruptor para isso. Definir `isolatePeerMachines` como `true` exige sua aprovação explícita antes que qualquer coisa saia da máquina, mesmo no modo `bypassPermissions`, e um `true` vindo de qualquer escopo de configuração prevalece.

A tagarelice descontrolada é limitada pelo transporte, não pelo bom comportamento: repetições têm limite de taxa por remetente, as idênticas dentro de uma janela curta são descartadas, e no máximo 50 mensagens aceitas ficam na fila de uma sessão que ainda não as leu.
