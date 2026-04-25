---
title: "Os tipos union do C# 15 chegaram: type unions são entregues no .NET 11 Preview 2"
description: "C# 15 introduz a palavra-chave union para type unions com correspondência de padrões exaustiva e conversões implícitas. Disponível agora no .NET 11 Preview 2."
pubDate: 2026-04-08
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/04/csharp-15-union-types-dotnet-11-preview-2"
translatedBy: "claude"
translationDate: 2026-04-25
---

Depois de anos de propostas, workarounds, e bibliotecas de terceiros como `OneOf`, C# 15 entrega a palavra-chave `union` no [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/csharp-15-union-types/). Estes são **type unions**: eles compõem tipos existentes em um único tipo fechado com correspondência de padrões exaustiva forçada pelo compilador. Sem classes base, sem padrão visitor, sem adivinhação em runtime.

## Como se parecem os type unions

Um union declara que um valor é exatamente um de um conjunto fixo de tipos:

```csharp
public union Shape(Circle, Rectangle, Triangle);
```

`Shape` pode conter um `Circle`, um `Rectangle`, ou um `Triangle`, e nada mais. O compilador gera conversões implícitas a partir de cada tipo caso, então a atribuição é direta:

```csharp
Shape shape = new Circle(Radius: 5.0);
```

Sem cast explícito, sem método de fábrica. A conversão simplesmente funciona.

## Correspondência de padrões exaustiva

O verdadeiro retorno vem no consumo. Uma expressão `switch` sobre um union deve lidar com cada caso, ou o compilador dá erro:

```csharp
double Area(Shape shape) => shape switch
{
    Circle c    => Math.PI * c.Radius * c.Radius,
    Rectangle r => r.Width * r.Height,
    Triangle t  => 0.5 * t.Base * t.Height,
};
```

Sem necessidade de ramo default. Se você depois adicionar `Polygon` ao union, cada `switch` que não o trate quebrará em tempo de compilação. Essa é a garantia de segurança que hierarquias de classe e `OneOf<T1, T2>` não podem fornecer no nível da linguagem.

## Unions podem carregar lógica

Você não está limitado a uma declaração de uma única linha. Unions suportam métodos, propriedades, e genéricos:

```csharp
public union Result<T>(T, ErrorInfo)
{
    public string Describe() => Value switch
    {
        T val       => $"Success: {val}",
        ErrorInfo e => $"Error {e.Code}: {e.Message}",
    };
}
```

A propriedade `Value` dá acesso à instância subjacente. Combinada com genéricos, isso faz com que padrões `Result<T>` sejam de primeira classe sem dependências externas.

## Como isto difere da proposta anterior

Em janeiro de 2026, [cobrimos a proposta de unions discriminadas](/2026/01/csharp-proposal-discriminated-unions/) que definia membros dentro do próprio union (mais próximo aos enums de F# ou Rust). O design entregue do C# 15 toma uma direção diferente: **type unions compõem tipos existentes** em vez de declarar novos inline. Isso significa que seus `Circle`, `Rectangle`, e `Triangle` são classes ou records regulares que você já tem. O union apenas os agrupa.

## Começando

Instale o [SDK do .NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0), mire `net11.0`, e defina `<LangVersion>preview</LangVersion>` no seu arquivo de projeto. Note que no Preview 2, o `UnionAttribute` e a interface `IUnion<T>` ainda não estão no runtime: você precisa declará-los no seu projeto. Previews posteriores os incluirão de fábrica.

Type unions são a maior adição ao sistema de tipos do C# desde os tipos de referência anuláveis. Se você tem modelado relações "um-de" com árvores de herança ou hacks de tupla, agora é um bom momento para prototipar com a coisa de verdade.
