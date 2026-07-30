---
title: "Visual Studio 18.9 te deja definir el esfuerzo de razonamiento por modelo"
description: "Visual Studio 18.9 Insiders 2 agrega un control de esfuerzo de razonamiento por modelo, con niveles de Low a Max, que expone el mismo parámetro que ya reciben las APIs de los modelos."
pubDate: 2026-07-30
tags:
  - "visual-studio"
  - "ai-agents"
  - "dotnet"
  - "copilot"
lang: "es"
translationOf: "2026/07/visual-studio-18-9-thinking-effort-control-per-model"
translatedBy: "claude"
translationDate: 2026-07-30
---

El 2026-07-29 Rachel Kang publicó [Tell your model when to think harder](https://devblogs.microsoft.com/visualstudio/tell-your-model-when-to-think-harder/), y la funcionalidad que describe es más interesante de lo que sugiere el título. A partir de **Visual Studio 18.9 Insiders 2**, los modelos compatibles traen un control de esfuerzo de razonamiento, y se configura por modelo, no por solicitud.

## Elegir modelo y elegir profundidad de razonamiento dejaron de ser la misma decisión

Hasta ahora, elegir un modelo en Visual Studio elegía dos cosas a la vez: qué pesos responden tu pregunta y cuánto razonamiento obtienes antes de que llegue la respuesta. Si un modelo razonaba en profundidad, cada prompt del tipo "renombra esta variable" lo pagaba.

Separar ambas cosas significa que puedes mantener el mismo modelo durante toda una sesión y mover el dial en su lugar. Los niveles son:

- **Low**: "Quick responses with minimal reasoning", y consume menos créditos de IA.
- **Medium**: "Balanced reasoning and speed, and usually the default."
- **High**: razonamiento más profundo, para un algoritmo complicado, una decisión de arquitectura o un bug que no logras acorralar.
- **Extra High** y **Max**: "The most reasoning some models offer, for the gnarliest problems."

Los modelos que no exponen un control de razonamiento muestran un guion y siguen funcionando exactamente como antes, así que el control se suma en lugar de cambiar el comportamiento de todo.

## Dónde está

Abre el selector de modelos, haz clic en **Manage models** para abrir la ventana ampliada de administración de modelos y ajusta ahí el nivel de razonamiento de cada modelo. No está enterrado en Tools > Options y no es un interruptor por prompt.

## La escalera es del proveedor, no de Visual Studio

Low, Medium, High, Extra High, Max no son cinco nombres que Microsoft inventó para un deslizador. Es el parámetro de esfuerzo de razonamiento que ya reciben las APIs de los modelos, expuesto en el IDE. En la API de Anthropic, el esfuerzo vive dentro de `output_config` y acepta exactamente `low`, `medium`, `high`, `xhigh` y `max`:

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

Sobre el cable eso es `"output_config": { "effort": "high" }`, con `xhigh` ubicado entre `high` y `max`. Nota que `Effort` está anidado bajo `OutputConfig` y no es una propiedad de nivel superior, que es el error que vale la pena evitar si vas a construir el mismo control en tus propias herramientas.

Dos detalles importan cuando razonas sobre lo que hace en realidad la configuración del IDE. El esfuerzo es un techo para la profundidad del razonamiento y para el gasto total de tokens, no un presupuesto fijo: en los modelos Claude actuales, el razonamiento adaptativo sigue decidiendo por solicitud cuánto razonar, y el esfuerzo lo acota. Y el enfoque anterior de nombrar un presupuesto duro de tokens de razonamiento desapareció en esos modelos, que es exactamente por lo que una escalera con cinco peldaños nombrados es lo que un IDE puede poner frente a ti.

## La parte que aparece en tu factura

"Higher thinking levels do more reasoning, which consumes more credits. Lower levels use fewer." Eso convierte al control en una palanca de costo tanto como de calidad, y encaja con los [límites de créditos de IA por sesión en la CLI y el SDK de Copilot](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/): uno acota el techo, el otro fija la tasa por solicitud.

Si estás en 18.9 Insiders, la calibración más rápida es dejar seleccionado tu modelo habitual, bajarlo a Low durante un día de ediciones rutinarias y ver qué poco extrañas.
