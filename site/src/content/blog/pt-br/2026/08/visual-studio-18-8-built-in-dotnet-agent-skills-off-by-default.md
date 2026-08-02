---
title: "Visual Studio 18.8 traz skills de agente para .NET embutidas, e depois desliga todas"
description: "O Visual Studio 2026 18.8 coloca skills de agente para .NET e Azure escritas por especialistas no seletor de ferramentas, em uma categoria Built-in e desativadas por padrão. O padrão é justamente a parte interessante."
pubDate: 2026-08-02
tags:
  - "visual-studio"
  - "dotnet"
  - "ai-agents"
  - "agent-skills"
  - "github-copilot"
lang: "pt-br"
translationOf: "2026/08/visual-studio-18-8-built-in-dotnet-agent-skills-off-by-default"
translatedBy: "claude"
translationDate: 2026-08-02
---

O Visual Studio 2026 versão 18.8 mudou discretamente o lugar onde mora a expertise do agente. As skills escritas pelos times de .NET e Azure agora acompanham a IDE, em vez de serem algo que você precisa procurar, instalar e conectar sozinho. Em 2026-07-28 Mark Downie incorporou a mudança em [Visual Studio July Update, Meet the New Agent](https://devblogs.microsoft.com/visualstudio/visual-studio-july-update-meet-the-new-agent-powered-by-copilot-sdk/), e o GitHub registrou o fato no [changelog do Copilot](https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-july-update/) em 2026-07-30.

As skills aparecem em uma categoria **Built-in** no seletor de ferramentas, e somente quando a carga de trabalho correspondente está instalada. Se você nunca instalou a carga de trabalho do Azure, nunca vê as skills do Azure. E todas ficam desligadas até você ligar.

## Duas skills de .NET para ativar primeiro

`dotnet-webapi` orienta a criação e a modificação de endpoints HTTP do ASP.NET Core: códigos de status corretos, metadados de OpenAPI no próprio endpoint em vez de acoplados depois, e tratamento de erros que não reduz tudo a um 500.

`analyzing-dotnet-performance` é a que vale usar em uma base de código existente. Ela varre cerca de 50 antipadrões de desempenho em assíncrono, memória, strings, coleções, LINQ, regex, serialização e E/S, e classifica os achados por severidade em vez de despejar uma lista plana. O formato do que ela caça é exatamente aquilo que passa na revisão de código porque parece correto:

```csharp
// Materializes every matching row just to ask a yes/no question
if (db.Orders.Where(o => o.CustomerId == id).ToList().Count > 0)
{
    // ...
}

// One EXISTS query, no allocation, no blocking
if (await db.Orders.AnyAsync(o => o.CustomerId == id, ct))
{
    // ...
}
```

Do lado do Azure vem uma cadeia de implantação em três etapas (`azure-prepare` gera Bicep ou Terraform mais `azure.yaml` e a configuração de identidade gerenciada, `azure-validate` roda verificações prévias, `azure-deploy` executa a implantação), além de `azure-kusto` para KQL no Azure Data Explorer e `microsoft-foundry` para implantação e avaliação de modelos.

## Desligadas por padrão é uma decisão de contexto, não timidez

Teria sido fácil habilitar todas e deixar o agente se virar. Entregá-las apagadas é a decisão melhor, e o motivo é o orçamento de contexto. Cada skill habilitada é um conjunto de instruções competindo pela mesma janela que o seu código de verdade. Quem desenvolve APIs web em .NET e instalou a carga de trabalho do Azure por causa de uma única tarefa de implantação não quer seis skills do Azure enviesando cada resposta pelo resto do ano.

É a mesma disciplina que o plugin `dotnet-test` exige, [o que está por trás do agente de testes unitários da semana passada](/pt-br/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/): carregue a skill do trabalho, não o catálogo.

## Você não precisa do Visual Studio para nada disso

As skills de .NET são públicas em [dotnet/skills](https://github.com/dotnet/skills) e as do Azure em [microsoft/azure-skills](https://github.com/microsoft/azure-skills). Os mesmos plugins se instalam no Copilot CLI, Claude Code, VS Code e Cursor:

```bash
/plugin marketplace add dotnet/skills
```

O que o 18.8 realmente entrega é descoberta. Ninguém ia encontrar `analyzing-dotnet-performance` navegando por um repositório. Achar isso em um seletor, ao lado da carga de trabalho que você já instalou, é outra história, o que faz do botão desligado por padrão o único atrito que sobra, e esse vale a pena manter.
