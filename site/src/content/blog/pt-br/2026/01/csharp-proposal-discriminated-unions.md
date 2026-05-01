---
title: "Proposta do C#: discriminated unions"
description: "Um olhar sobre a proposta de discriminated unions do C#: a palavra-chave union, correspondência de padrões exaustiva e como ela pode substituir bibliotecas OneOf e hierarquias de classes."
pubDate: 2026-01-02
updatedDate: 2026-01-04
tags:
  - "csharp"
  - "csharp-proposals"
lang: "pt-br"
translationOf: "2026/01/csharp-proposal-discriminated-unions"
translatedBy: "claude"
translationDate: 2026-05-01
---
O "santo graal" dos recursos do C# vem sendo discutido há anos. E depois de tanto tempo dependendo de bibliotecas de terceiros como `OneOf` ou de hierarquias de classes verbosas, parece que finalmente podemos ter suporte nativo a **discriminated unions (DUs)** em uma futura versão do C#.

## O problema: representar "um de"

Se você quisesse que uma função retornasse _ou_ um resultado genérico de `Success` _ou_ um `Error` específico, você tinha opções ruins:

1.  **Lançar exceções** (caro como fluxo de controle).
2.  **Retornar `object`** (perda de segurança de tipos).
3.  **Usar uma hierarquia de classes** (verbosa e permite outros herdeiros).

## A solução: tipos `union`

A proposta introduz a palavra-chave `union`, permitindo definir hierarquias de tipos fechadas em que o compilador conhece todos os casos possíveis.

```cs
// Define a union
public union Result<T>
{
    Success(T Value),
    Error(string Message, int Code)
}
```

Isso gera, por baixo dos panos, um layout de struct altamente otimizado, similar ao funcionamento dos enums em Rust.

## Correspondência de padrões exaustiva

O real poder das DUs surge na hora de consumi-las. A expressão switch **deve** ser exaustiva. Se você esquecer um caso, o código não compila.

```cs
public string HandleResult(Result<int> result) => result switch
{
    Result.Success(var val) => $"Got value: {val}",
    Result.Error(var msg, _) => $"Failed: {msg}",
    // Compiler Error: No default case needed, but all cases must be covered!
};
```

## Por que isso importa

Se aceito, esse recurso mudaria fundamentalmente o tratamento de erros no .NET. Você poderia modelar estados de domínio com precisão (por exemplo, `Loading`, `Loaded`, `Error`) sem a sobrecarga de runtime de alocações de classe nem a carga cognitiva de padrões visitor complexos.
