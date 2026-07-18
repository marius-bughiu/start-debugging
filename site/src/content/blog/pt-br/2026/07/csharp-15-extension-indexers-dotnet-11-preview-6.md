---
title: "Os indexadores de extensão do C# 15 completam os membros de extensão no .NET 11 Preview 6"
description: "Os indexadores de extensão chegaram no .NET 11 Preview 6 e permitem adicionar acesso this[...] a tipos que você não controla. Eles completam a história dos membros de extensão que começou com métodos e propriedades no C# 14."
pubDate: 2026-07-18
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "extension-members"
lang: "pt-br"
translationOf: "2026/07/csharp-15-extension-indexers-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-18
---

O .NET 11 Preview 6 foi lançado em 2026-07-14, e escondida na seção de C# das notas de versão está a peça que finalmente faz os membros de extensão parecerem completos: os indexadores de extensão. Os métodos de extensão existem desde o C# 3.0, as propriedades de extensão chegaram com o [bloco de extensão no C# 14](/pt-br/2026/06/how-to-declare-extension-properties-in-csharp-14/), e agora você pode adicionar acesso `this[...]` a um tipo que não controla.

## O que faltava até agora

A solução óbvia sempre foi um método de extensão comum. Se você quisesse semântica de índice a partir do fim sobre um `IReadOnlyList<T>`, que não carrega um indexador que entenda `Index`, você escrevia algo assim:

```csharp
public static class ReadOnlyListExtensions
{
    public static T At<T>(this IReadOnlyList<T> list, Index index)
        => list[index.GetOffset(list.Count)];
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log.At(^1));   // done
Console.WriteLine(log.At(^2));   // work
```

Funciona, mas o ponto de chamada é lido como `log.At(^1)` em vez da sintaxe `log[^1]` que qualquer outro tipo parecido com uma lista oferece. Você perde a notação de colchetes, e a perde também nos padrões de lista.

## A versão com indexador de extensão

O C# 15 permite declarar o indexador dentro de um bloco `extension`, exatamente como você declararia um indexador de instância:

```csharp
public static class ReadOnlyListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public T this[Index index] => list[index.GetOffset(list.Count)];
    }
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log[^1]);   // done
Console.WriteLine(log[^2]);   // work
```

O receptor capturado pelo cabeçalho `extension<T>(IReadOnlyList<T> list)` está no escopo dentro do corpo, então o indexador encaminha diretamente para `list`. O ponto de chamada agora usa sintaxe de indexador real e, como o compilador o trata como um indexador, ele participa dos padrões de lista e das expressões de intervalo do mesmo jeito que um indexador embutido faria.

Os indexadores de extensão não se limitam à forma de um único parâmetro e somente leitura. Eles aceitam vários parâmetros e os acessadores `get` e `set`, então você pode projetar uma busca bidimensional sobre um armazenamento plano ou expor uma visão de escrita sobre um tipo que só oferece acesso baseado em métodos.

## Como habilitar

Isso ainda é um recurso de linguagem em versão prévia, então ele não é ativado na versão de linguagem padrão. Adicione o seguinte ao seu `.csproj`:

```xml
<LangVersion>preview</LangVersion>
```

Os indexadores de extensão são o último dos três tipos clássicos de membros a chegar aos blocos de extensão, o que significa que o modelo mental agora é uniforme: métodos, propriedades e indexadores são declarados da mesma forma dentro de `extension(...)`. Se você vinha recorrendo a tipos invólucro ou a auxiliares `.At()` desajeitados para contornar um indexador ausente, o Preview 6 é a versão que permite eliminá-los. Consulte a [seção de C# das notas de versão do Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/csharp.md) para a análise completa.
