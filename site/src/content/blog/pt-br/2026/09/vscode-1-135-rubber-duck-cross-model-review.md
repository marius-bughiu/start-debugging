---
title: "VS Code 1.135 traz /rubber-duck, e ele usa um modelo diferente de propósito"
description: "O comando experimental /rubber-duck do VS Code 1.135 entrega o plano, o código e os testes do agente a um modelo de outra família para revisão. GPT-5.4 critica o Claude, e essa escolha entre famílias é justamente o ponto."
pubDate: 2026-09-01
tags:
  - "ai-agents"
  - "github-copilot"
  - "llm"
  - "claude-code"
lang: "pt-br"
translationOf: "2026/09/vscode-1-135-rubber-duck-cross-model-review"
translatedBy: "claude"
translationDate: 2026-09-01
---

O VS Code 1.135 saiu em 2026-08-26, e o GitHub o incluiu no changelog "GitHub Copilot in VS Code, August 2026 releases" em 2026-08-31. Escondido no meio do trabalho de layout de sessões está o item mais interessante da versão: um comando experimental `/rubber-duck` que busca uma segunda opinião sobre o trabalho do agente em um modelo de outra família.

## A autorrevisão não encontra o que o modelo já deixou passar

Pedir que um modelo confira a própria saída é quase de graça, e por isso praticamente todo harness de agentes faz isso. Também é fraco. Os mesmos pesos que produziram o plano produzem a revisão, então os pontos cegos são correlacionados: se o modelo não pensou no caso de escrita concorrente ao escrever o código, ele também não pensa nisso ao revisar o código.

O Rubber Duck aposta no contrário. O orquestrador é qualquer modelo da família Claude escolhido no seletor de modelos, e o revisor é o GPT-5.4. A estratégia de modelo complementar é explícita, não acidental: o revisor é escolhido em uma família diferente da do modelo principal, de modo que uma sessão com Claude ganha um crítico GPT e uma sessão com GPT ganha o inverso. O GitHub é franco ao dizer que isso é um experimento, afirmando que está "explorando outras famílias de modelos para o orquestrador e para o Rubber Duck".

## Um crítico somente leitura com saída triada

O Rubber Duck não pode editar. Ele lê o plano, o diff e os testes, e procura problemas de fundo: erros de lógica, falhas de design, brechas de segurança, cobertura de testes ausente. O que volta vem triado, não despejado:

```text
> /rubber-duck

Blocking
  - RefreshTokenAsync writes the new token before the old one is revoked.
    A crash between the two leaves both valid.

Non-blocking
  - The retry loop has no jitter. Three clients failing together will
    stay in lockstep.

Suggestions
  - No test covers an expired token with a valid signature.
```

A divisão entre bloqueante, não bloqueante e sugestões é a parte que vale copiar se você constrói o seu próprio subagente de revisão. Uma lista sem hierarquia com doze observações é lida na diagonal; três itens bloqueantes são lidos de verdade.

## Ele dispara sozinho, com parcimônia

Você pode invocá-lo na mão, mas o Copilot também o chama em quatro momentos de maior retorno: depois de redigir um plano, depois de uma implementação complexa, depois de escrever testes mas antes de executá-los, e quando o agente fica preso em um laço. Esse último gatilho é o que mais se paga, já que um agente em laço é o sinal mais claro de que o modelo principal ficou sem ideias sobre a própria saída.

Por baixo dos panos ele roda pela ferramenta de tarefas que o Copilot já tinha, a mesma maquinaria dos demais subagentes. Isso significa que não é de graça: cada invocação automática é um turno completo de modelo contra o seu consumo premium, além dos tokens do agente principal. O VS Code 1.135 também adicionou contabilidade de tokens por modelo no rodapé de cada resposta do chat, que é como você vai descobrir quanto custa o patinho.

## Como ligar

No VS Code, `/rubber-duck` funciona dentro de uma sessão agent host do Copilot, o modo que executa o harness em um processo dedicado sobre o Agent Host Protocol. Se você ainda não habilitou as sessões agent host, esse é o mesmo conjunto de recursos que [estreou as sessões agent-host do Claude com vários chats no VS Code 1.128](/pt-br/2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions/). No GitHub Copilot CLI, você libera o recurso com o comando `/experimental`.

A disponibilidade é condicional: a sessão principal precisa estar em um modelo Claude ou GPT, e precisa haver um modelo complementar adequado. Se nenhuma das duas condições valer, o comando simplesmente não aparece.

Os detalhes completos estão nas [notas da versão do VS Code 1.135](https://code.visualstudio.com/updates/v1_135) e no texto do GitHub sobre [combinar famílias de modelos para uma segunda opinião](https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/).
