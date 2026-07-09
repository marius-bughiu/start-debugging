---
title: "VS Code 1.128 adiciona sessões agent-host do Claude com vários chats"
description: "O VS Code 1.128 (8 de julho de 2026) permite que uma única sessão agent-host do Claude mantenha vários chats em paralelo, cada um com seu próprio histórico, título e modelo. Veja o que chat.agentHost.enabled realmente libera e como as peças de quick chat e BYOK se encaixam."
pubDate: 2026-07-09
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "pt-br"
translationOf: "2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions"
translatedBy: "claude"
translationDate: 2026-07-09
---

O VS Code 1.128 foi lançado em 8 de julho de 2026, e o destaque não é um recurso do Copilot. É que uma única sessão agent-host do Claude agora pode manter vários chats relacionados ao mesmo tempo, cada um com seu próprio histórico, título e seleção de modelo, todos agrupados sob uma sessão principal. O modo agent-host funciona com o Claude Agent SDK da Anthropic rodando diretamente dentro do VS Code, e esta versão o transforma de uma experiência de thread única em algo mais parecido com uma bancada de trabalho.

## Por que uma sessão com vários chats importa

Antes da 1.128, explorar duas abordagens para o mesmo problema significava ou destruir seu contexto ao pivotar no meio do thread, ou iniciar uma sessão totalmente nova e perder a configuração compartilhada. Os chats múltiplos resolvem isso. Você pode ramificar a partir de um turno anterior, manter o chat original intacto e executar ambos em paralelo. Cada chat acompanha seu próprio modelo, então você pode colocar um modelo mais barato contra um mais forte na mesma tarefa e comparar os diffs lado a lado sem sair da sessão.

Isso depende do modo agent-host. Ative-o em `settings.json`:

```json
{
  "chat.agentHost.enabled": true
}
```

Com isso configurado, a janela **Agents** se torna o centro. Novos chats aparecem em uma seção **Chats** sob a sessão principal, e você foca a janela com o comando `workbench.action.openAgentsWindow`.

## Os quick chats dispensam a exigência de um espaço de trabalho

A segunda mudança que remove atrito são os quick chats. Agora você pode iniciar uma conversa a partir da janela Agents sem abrir uma pasta primeiro. Isso parece pequeno até você perceber com que frequência quer perguntar algo a um agente que não tem nada a ver com o projeto aberto no momento, e antes precisava abrir um espaço de trabalho temporário para isso. Os quick chats só são compatíveis com as sessões agent-host, então usam o mesmo interruptor `chat.agentHost.enabled`.

Os subagentes também são mencionados: o agent-host pode delegar a um subagente, e você vê a transcrição do subagente em modo somente leitura, de forma que uma delegação não polui o histórico do chat principal.

## Trazendo suas próprias chaves de modelo

Há também uma configuração experimental para equipes que querem rotear pelo seu próprio provedor de modelos em vez do caminho embutido:

```json
{
  "chat.agentHost.byokModels.enabled": true
}
```

O suporte a BYOK está marcado como experimental na 1.128, então trate-o como uma versão prévia e não como algo para padronizar em uma equipe esta semana. Combine-o com `chat.byokUtilityModelDefault` se quiser controlar qual modelo cuida das chamadas utilitárias mais baratas.

Fechando a versão, o Copilot Vision passou a estar disponível de forma geral, então colar, arrastar ou soltar imagens e PDFs no Chat não é mais uma versão prévia, e o agente pode acessar esses anexos por meio de uma chamada de ferramenta.

A peça dos chats múltiplos é a que vale a pena testar primeiro. Se você já executa o agent-host do Claude no VS Code, ative `chat.agentHost.enabled`, abra a janela Agents e ramifique um chat em vez de reiniciar um. As notas completas estão nas [notas da versão VS Code 1.128](https://code.visualstudio.com/updates/v1_128).
