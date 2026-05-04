---
title: "Cursor lança um SDK em TypeScript que transforma seu agente de codificação em biblioteca"
description: "O novo beta público do @cursor/sdk expõe o mesmo runtime, harness e modelos que rodam o app desktop, a CLI e a web como um pacote TypeScript. Você ganha VMs em nuvem isoladas, subagentes, hooks, MCP e cobrança por tokens em poucas linhas de código."
pubDate: 2026-05-04
tags:
  - "cursor"
  - "ai-agents"
  - "typescript"
  - "mcp"
lang: "pt-br"
translationOf: "2026/05/cursor-typescript-sdk-programmatic-coding-agents"
translatedBy: "claude"
translationDate: 2026-05-04
---

Em 29 de abril de 2026, a Cursor abriu o beta público do `@cursor/sdk`, uma biblioteca TypeScript que empacota o mesmo runtime, harness e modelos que rodam o editor desktop, a CLI e o app web. A proposta é simples: o agente que vivia escondido dentro da interface do Cursor agora é um componente programável que você chama dos seus próprios serviços. O mesmo modelo Composer, o mesmo mecanismo de contexto, a mesma superfície de ferramentas, acessível a partir de um processo Node.

É a mesma transição que os SDKs da Anthropic e da OpenAI fizeram anos atrás, mas para um agente especializado em código em vez de um modelo de chat cru.

## O que vem em `@cursor/sdk`

Você instala como qualquer pacote:

```bash
npm install @cursor/sdk
```

O "criar um agente e rodar um prompt" mínimo fica assim na [documentação oficial](https://cursor.com/docs/sdk/typescript):

```typescript
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

O campo interessante é `local`. Passe-o e o agente opera contra o seu sistema de arquivos no diretório de trabalho atual. Remova-o e troque por `cloud: { ... }` e a mesma chamada agora roda dentro de uma VM isolada que a Cursor provisiona para você, com indexação do código, busca semântica e grep no lado remoto. O contrato de `Agent.create`, `agent.send` e o stream do run é idêntico entre os dois.

Essa simetria é a feature principal. Scripts de CI que precisam manter resultados locais podem continuar locais. Agentes hospedados que precisam executar prompts não confiáveis contra clones efêmeros podem migrar para o runtime em nuvem sem reescrever o harness.

## Subagentes, hooks, MCP e skills

O SDK não para em prompts de um único tiro. Ele expõe as mesmas primitivas que o app desktop usa:

- `Run` oferece streaming, espera e cancelamento. O stream emite eventos `SDKMessage`: tokens do assistente, chamadas de ferramentas, thinking e atualizações de status como uma união discriminada.
- Subagentes permitem que um run pai delegue uma subtarefa autocontida sem poluir a própria janela de contexto.
- Hooks disparam antes e depois de chamadas de ferramentas, então você pode negar escritas perigosas em arquivos, registrar cada comando de shell ou reescrever prompts conforme uma política.
- Servidores MCP se conectam via `stdio` ou `http`, o que significa que qualquer integração MCP existente (GitHub, Linear, seus dados internos) entra sem mudanças de código.
- O namespace `Cursor` cuida do plumbing em nível de conta: listar modelos, listar repositórios, gerenciar API keys.

Os erros são tipados: `AuthenticationError`, `RateLimitError`, `ConfigurationError` e companhia. Acabou o parse de strings de mensagem.

## Por que isso também importa para times de .NET

O SDK é só TypeScript por enquanto, mas o runtime em nuvem é agnóstico de linguagem, então você pode disparar a partir de um pequeno sidecar Node para o qual um serviço .NET faz shell-out. Combinado com o [Microsoft Agent Framework](/pt-br/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) no lado C#, o padrão realista de 2026 começa a ficar claro: orquestrar pelo .NET, empurrar tarefas de edição de código para um agente Cursor hospedado via SDK e consumir os resultados via MCP.

O preço é o consumo padrão por tokens, sem assento separado para uso do SDK, então o custo do experimento é o que o modelo queimar. O detalhe que você precisa monitorar é o ciclo de vida da VM em nuvem. Runs longos podem acumular dinheiro de verdade, e o SDK não cancela agentes ociosos automaticamente por você.

A documentação completa do beta vive em [cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript), e o post de lançamento é [cursor.com/blog/typescript-sdk](https://cursor.com/blog/typescript-sdk).
