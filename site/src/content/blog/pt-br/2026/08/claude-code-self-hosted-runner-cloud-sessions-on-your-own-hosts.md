---
title: "As sessões na nuvem do Claude Code agora podem rodar nos seus próprios hosts"
description: "O Claude Code 2.1.224 adiciona claude self-hosted-runner, um beta público que executa sessões na nuvem em máquinas que você provisiona. Aqui está a configuração, a regra de um usuário por runner e o que ainda sai da sua rede."
pubDate: 2026-08-11
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "pt-br"
translationOf: "2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts"
translatedBy: "claude"
translationDate: 2026-08-11
---

As sessões na nuvem do Claude Code, aquelas que você inicia pelo claude.ai, pelos apps móvel e desktop, por uma rotina agendada ou pelo terminal com `claude --cloud`, sempre foram executadas na infraestrutura da Anthropic. O Claude Code 2.1.224, publicado em 2026-08-07, muda isso. Um novo subcomando, `claude self-hosted-runner`, transforma um host Linux ou macOS na máquina que de fato executa a sessão. É um beta público nos planos Team e Enterprise, e fica invisível até que um Owner ou admin ative "Allow self-hosted environments" na página administrativa Cloud environments.

## Ambiente, runner, sessão

Três peças fazem isso funcionar. Um **ambiente** é um destino nomeado criado nas configurações administrativas do claude.ai que aparece no seletor de ambientes ao lado das opções hospedadas pela Anthropic. Um **runner** é um processo de longa duração que você implanta dentro da sua rede. Uma **sessão** é uma tarefa, retirada da fila do ambiente por um runner, que clona o repositório e cria um processo `claude` filho para executar o trabalho.

A menor configuração funcional são três comandos mais o segredo do ambiente, que o claude.ai mostra exatamente uma vez na criação e que expira depois de 365 dias:

```bash
mkdir -p /etc/claude
(umask 077 && cat > /etc/claude/environment-secret)
mkdir -p /srv/claude-work

claude self-hosted-runner \
  --environment-secret-file '/etc/claude/environment-secret' \
  --base-dir '/srv/claude-work'
```

Se você omitir `--base-dir`, o runner cai para `/workspace`, que só funciona se esse caminho já existir e tiver permissão de escrita. Verifique o host antes com `claude self-hosted-runner --help`: em qualquer versão anterior à 2.1.224 o subcomando não é reconhecido e você recebe a saída geral do `claude --help`. Existe também um caminho guiado, `claude self-hosted-runner setup`, que percorre os passos da interface administrativa e escreve um resumo em `./runner-setup/CHEAT-SHEET.md`.

## Por que um runner atende exatamente um usuário

Essa é a decisão de projeto que define o tamanho da sua frota. A primeira sessão que um runner assume trava esse runner na conta do usuário que a iniciou e, a partir daí, ele só aceita trabalho daquela conta, até `--capacity` sessões concorrentes. A capacidade padrão é `1`. Portanto, o tamanho mínimo da sua frota é o número de usuários que você espera ter ativos ao mesmo tempo, não o número de sessões.

Runners também são descartáveis por padrão. O `--drain-grace-sec` tem padrão `0`, então um runner encerra assim que suas sessões ativas terminam, em vez de continuar consultando a fila, o que permite ao Kubernetes reiniciá-lo com um disco limpo pronto para qualquer conta. É assim que o isolamento do checkout por usuário é obtido sem apagar o estado entre usuários. A consulta à fila também funciona como heartbeat: pare de consultar por cerca de 60 segundos e o plano de controle recoloca a sessão na fila em outro lugar. Saúde e métricas do Prometheus ficam em `/healthz` e `/metrics` na `--health-port`, padrão `8080`.

## O que ainda vai para api.anthropic.com

Os checkouts do repositório, os artefatos de build, os segredos e qualquer arquivo que uma sessão escreva permanecem nas suas máquinas. A conversa não: prompts, respostas e resultados de ferramentas vão para `api.anthropic.com` para inferência, e a Anthropic armazena a transcrição para que a sessão possa ser retomada de outra superfície. Toda conexão é de saída, e a Anthropic nunca se conecta para dentro da sua rede.

Vale checar três limites antes de planejar uma adoção. Organizações com Zero Data Retention não podem usar isso. A inferência não pode ser roteada por Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry ou um gateway de LLM, porque as sessões se autenticam com um token com escopo de sessão emitido pela Anthropic. E sessões do Claude Tag, do Claude Security e do Code Review ainda não são roteadas para ambientes auto-hospedados.

A mesma versão também trouxe a [mensageria entre sessões](/pt-br/2026/08/claude-code-2-1-224-sessions-message-each-other/). As tabelas completas de flags estão na [referência de ambientes auto-hospedados](https://code.claude.com/docs/en/self-hosted-environments-reference).
