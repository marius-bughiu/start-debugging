---
title: "O Visual Studio 18.9 deixa você definir o esforço de raciocínio por modelo"
description: "O Visual Studio 18.9 Insiders 2 adiciona um controle de esforço de raciocínio por modelo, com níveis de Low a Max, expondo o mesmo parâmetro que as APIs dos modelos já recebem."
pubDate: 2026-07-30
tags:
  - "visual-studio"
  - "ai-agents"
  - "dotnet"
  - "copilot"
lang: "pt-br"
translationOf: "2026/07/visual-studio-18-9-thinking-effort-control-per-model"
translatedBy: "claude"
translationDate: 2026-07-30
---

Em 2026-07-29, Rachel Kang publicou [Tell your model when to think harder](https://devblogs.microsoft.com/visualstudio/tell-your-model-when-to-think-harder/), e o recurso descrito ali é mais interessante do que o título sugere. A partir do **Visual Studio 18.9 Insiders 2**, os modelos compatíveis vêm com um controle de esforço de raciocínio, e ele é definido por modelo, não por requisição.

## Escolher o modelo e escolher a profundidade do raciocínio deixaram de ser a mesma decisão

Até agora, escolher um modelo no Visual Studio escolhia duas coisas ao mesmo tempo: quais pesos respondem à sua pergunta e quanto raciocínio você recebe antes da resposta chegar. Se um modelo raciocinava profundamente, todo prompt do tipo "renomeie esta variável" pagava por isso.

Separar as duas coisas significa que você pode manter o mesmo modelo por uma sessão inteira e mover o dial no lugar disso. Os níveis são:

- **Low**: "Quick responses with minimal reasoning", e consome menos créditos de IA.
- **Medium**: "Balanced reasoning and speed, and usually the default."
- **High**: raciocínio mais profundo, para um algoritmo complicado, uma decisão de arquitetura ou um bug que você não consegue localizar.
- **Extra High** e **Max**: "The most reasoning some models offer, for the gnarliest problems."

Modelos que não expõem um controle de raciocínio mostram um traço e continuam funcionando exatamente como antes, então o controle é aditivo em vez de uma mudança de comportamento em toda a linha.

## Onde ele fica

Abra o seletor de modelos, clique em **Manage models** para abrir a janela ampliada de gerenciamento de modelos e ajuste ali o nível de raciocínio de cada modelo. Não está enterrado em Tools > Options e não é uma chave por prompt.

## A escada é do provedor, não do Visual Studio

Low, Medium, High, Extra High, Max não são cinco nomes que a Microsoft inventou para um slider. É o parâmetro de esforço de raciocínio que as APIs dos modelos já recebem, exposto na IDE. Na API da Anthropic, o esforço fica dentro de `output_config` e aceita exatamente `low`, `medium`, `high`, `xhigh` e `max`:

```csharp
using Anthropic;
using Anthropic.Models.Messages;

AnthropicClient client = new();

var response = await client.Messages.Create(new MessageCreateParams
{
    Model = "claude-opus-5",
    MaxTokens = 16000,
    Thinking = new ThinkingConfigAdaptive(),
    OutputConfig = new OutputConfig { Effort = Effort.High },
    Messages = [new() { Role = Role.User, Content = "Why does this query deadlock?" }],
});
```

No fio isso é `"output_config": { "effort": "high" }`, com `xhigh` entre `high` e `max`. Observe que `Effort` está aninhado sob `OutputConfig` e não é uma propriedade de nível superior, que é o erro que vale a pena evitar se você for construir o mesmo controle nas suas próprias ferramentas.

Dois detalhes importam quando você raciocina sobre o que a configuração da IDE realmente faz. O esforço é um teto para a profundidade do raciocínio e para o gasto total de tokens, não um orçamento fixo: nos modelos Claude atuais, o raciocínio adaptativo continua decidindo por requisição quanto raciocinar, e o esforço o limita. E a abordagem antiga de nomear um orçamento rígido de tokens de raciocínio não existe mais nesses modelos, que é exatamente por isso que uma escada de cinco degraus nomeados é o que uma IDE consegue colocar na sua frente.

## A parte que aparece na sua fatura

"Higher thinking levels do more reasoning, which consumes more credits. Lower levels use fewer." Isso faz do controle uma alavanca de custo tanto quanto de qualidade, o que combina com os [limites de créditos de IA por sessão na CLI e no SDK do Copilot](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/): um limita o teto, o outro define a taxa por requisição.

Se você está no 18.9 Insiders, a calibração mais rápida é deixar seu modelo habitual selecionado, baixá-lo para Low por um dia de edições rotineiras e ver o quão pouco você sente falta.
