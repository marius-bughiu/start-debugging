---
title: "Operadores de atribuição composta definidos pelo usuário no C# 14: += in-place sem a alocação extra"
description: "C# 14 deixa você sobrecarregar +=, -=, *= e companhia como métodos de instância void que mutam o receptor in-place, cortando alocações para holders de valor grandes como buffers estilo BigInteger e tensores."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "performance"
  - "operators"
lang: "pt-br"
translationOf: "2026/04/csharp-14-user-defined-compound-assignment-operators"
translatedBy: "claude"
translationDate: 2026-04-24
---

Uma das adições mais silenciosas do C# 14 está finalmente sendo asfaltada na referência da linguagem: operadores de atribuição composta definidos pelo usuário. Até o .NET 10, escrever `x += y` num tipo customizado sempre compilava para `x = x + y`, o que significava que seu `operator +` tinha que alocar e retornar uma instância nova até quando o chamador ia jogar a antiga fora. Com C# 14 você agora pode sobrecarregar `+=` direto como um método de instância `void` que muta o receptor in-place.

A motivação é simples: para tipos que carregam muitos dados (um buffer estilo `BigInteger`, um tensor, um acumulador de bytes com pool), produzir um destino novo, percorrê-lo e copiar memória é a parte cara de cada `+=`. Se o valor original não é usado depois da atribuição, essa cópia é puro desperdício. A [especificação do recurso](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/user-defined-compound-assignment) deixa isso explícito.

## Como o novo operador é declarado

Um operador de atribuição composta no C# 14 não é estático. Aceita um único parâmetro, retorna `void` e vive na instância:

```csharp
public sealed class Accumulator
{
    private readonly List<int> _values = new();

    public int Sum { get; private set; }

    // Classic binary operator, still required if you want x + y to work.
    public static Accumulator operator +(Accumulator left, int value)
    {
        var result = new Accumulator();
        result._values.AddRange(left._values);
        result._values.Add(value);
        result.Sum = left.Sum + value;
        return result;
    }

    // New in C# 14: instance operator, no allocation, no static modifier.
    public void operator +=(int value)
    {
        _values.Add(value);
        Sum += value;
    }
}
```

O compilador emite o método de instância sob o nome `op_AdditionAssignment`. Quando o chamador escreve `acc += 5`, a linguagem agora prefere o operador de instância se houver um disponível; se não, a antiga reescrita `x = x + y` continua sendo o fallback. Isso significa que código existente continua compilando, e você pode adicionar uma sobrecarga de `+=` depois sem quebrar a sobrecarga de `+`.

## Quando importa

O ganho aparece em tipos por referência que possuem buffers internos e em tipos struct usados através de um local de armazenamento mutável. Um `Matrix operator +(Matrix, Matrix)` ingênuo precisa alocar uma matriz nova inteira a cada chamada `m += other` em um loop quente. A versão de instância pode somar em `this` e não retornar nada:

```csharp
public sealed class Matrix
{
    private readonly double[] _data;
    public int Rows { get; }
    public int Cols { get; }

    public void operator +=(Matrix other)
    {
        if (other.Rows != Rows || other.Cols != Cols)
            throw new ArgumentException("Shape mismatch.");

        var span = _data.AsSpan();
        var otherSpan = other._data.AsSpan();
        for (int i = 0; i < span.Length; i++)
            span[i] += otherSpan[i];
    }
}
```

`++` e `--` prefixados seguem o mesmo padrão com `public void operator ++()`. `x++` postfixado ainda passa pela versão estática quando o resultado é usado, porque o valor pré-incremento não pode ser produzido após uma mutação in-place.

## Coisas que vale saber

A linguagem não força consistência entre `+` e `+=`, então você pode entregar um sem o outro. O LDM [olhou isso em abril de 2025](https://github.com/dotnet/csharplang/blob/main/meetings/2025/LDM-2025-04-02.md) e decidiu contra o pareamento obrigatório. Variantes `checked` funcionam igual: declare `public void operator checked +=(int y)` ao lado do regular. `readonly` é permitido em structs mas, como nota a spec, raramente faz sentido dado que o ponto inteiro do método é mutar a instância.

O recurso entrega com o C# 14 no .NET 10, utilizável hoje no Visual Studio 2026 ou no SDK do .NET 10. Para bibliotecas existentes que expõem tipos por valor com muitos dados, adicionar retroativamente um `+=` de instância é um dos ganhos de performance mais baratos disponíveis neste release. Veja a visão geral completa em [Novidades do C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14).
