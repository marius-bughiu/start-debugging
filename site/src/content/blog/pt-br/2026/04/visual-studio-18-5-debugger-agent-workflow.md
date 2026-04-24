---
title: "O Debugger Agent do Visual Studio 18.5 transforma o Copilot num parceiro vivo de caça a bugs"
description: "Visual Studio 18.5 GA traz um workflow guiado de Debugger Agent no Copilot Chat que forma uma hipótese, coloca breakpoints, acompanha um repro, valida contra estado em runtime e propõe um fix."
pubDate: 2026-04-21
tags:
  - "visual-studio"
  - "debugging"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/04/visual-studio-18-5-debugger-agent-workflow"
translatedBy: "claude"
translationDate: 2026-04-24
---

O time do Visual Studio lançou [um novo workflow de Debugger Agent](https://devblogs.microsoft.com/visualstudio/stop-hunting-bugs-meet-the-new-visual-studio-debugger-agent/) no Visual Studio 18.5 GA em 15 de abril de 2026. Se você passou o último ano perguntando ao Copilot "por que isso é null" e recebendo um palpite confiante que contradizia o call stack real, essa release é a correção. O agent não é mais um chatbot que lê seus arquivos fonte. Ele dirige uma sessão de debug interativa, coloca os próprios breakpoints e raciocina contra estado de runtime vivo.

## Análise estática não bastava

Iterações anteriores do [Debug with Copilot](https://devblogs.microsoft.com/visualstudio/visual-studio-2026-debugging-with-copilot/) eram úteis para assistência de exceções e prompts no estilo "explique esse stack frame", mas operavam sobre um snapshot congelado do seu código. Quando a falha real vivia numa race entre duas continuations async, ou num estado que só existia depois do décimo-quinto clique, uma leitura estática de `MyService.cs` simplesmente não conseguia ver. VS 18.5 fecha essa lacuna deixando o agent participar do repro real.

## O loop de quatro fases

Uma vez que sua solution está aberta, você troca o Copilot Chat para modo Debugger e passa uma descrição do bug. O workflow então caminha por quatro fases em ordem:

1. **Hipótese e preparação.** O agent analisa a descrição mais o código e propõe uma teoria de causa raiz. Então coloca "intelligent breakpoints" nos caminhos suspeitos e se oferece para lançar o projeto. Se seu startup é incomum, pode lançar manualmente e deixar que ele se anexe.
2. **Reprodução ativa.** O agent fica na linha enquanto você clica pelo repro. Está observando estado de runtime a cada breakpoint que bate, não relendo o arquivo.
3. **Validação em tempo real.** A cada parada, avalia locals e o call stack para confirmar ou eliminar a hipótese. Palpites errados são descartados por evidência em vez de defendidos.
4. **O fix final.** Quando o agent está confiante de que achou a causa, propõe uma mudança de código. Se você aprovar, aplica a edição e rerrerda a sessão para verificar que o bug sumiu.

Os cenários suportados no drop do 18.5 GA são "exceptions, logic inconsistencies, and state corruption." Regressões de performance e bugs puros de concorrência ainda não estão nessa lista.

## Como é uma sessão

Um walkthrough mínimo para um null-ref clássico parece com:

```text
You: The app throws NullReferenceException when saving a new invoice
     with no line items. Repro: open /invoices/new, click Save.

Agent: Hypothesis - Invoice.Total() dereferences LineItems before the
       collection is initialised for empty invoices.
       Setting breakpoints at InvoiceService.cs:42 and Invoice.cs:18.
       Launching IIS Express on https://localhost:7080 ...
```

Você roda o repro. O breakpoint em `Invoice.cs:18` bate, o agent lê `this.LineItems` do stack frame, vê `null` em vez de uma lista vazia, e confirma a hipótese sem te pedir para stepar em nada. Então oferece:

```csharp
public decimal Total() =>
    (LineItems ?? []).Sum(li => li.Quantity * li.UnitPrice);
```

Aprovado, e rerroda o cenário para confirmar que a exceção foi.

## Por que importa

A mudança interessante aqui é que o agent está aterrado na verdade do runtime. Você ainda pode sobrepujar, ignorar os breakpoints e debugar na mão, o que é o default certo para qualquer coisa sensível a segurança ou em código desconhecido. Mas para a long tail de "tenho um repro e um stack trace e preciso bissecar estado", o loop do bug report ao fix verificado encurta drasticamente. Espere gastar mais do seu tempo de debug revisando a evidência do agent em vez de colocando breakpoints à mão.

A feature está no VS 18.5 GA hoje. Se você ainda está no 17.x ou num preview 18.x anterior, o estilo chat antigo do Debug with Copilot é o que você tem. O workflow guiado exige 18.5.
