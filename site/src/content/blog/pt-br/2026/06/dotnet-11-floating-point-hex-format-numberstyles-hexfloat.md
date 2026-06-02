---
title: ".NET 11 converte um double em hex e recupera bit a bit"
description: "O Preview 4 do .NET 11 ensina double, float e Half a formatar com o especificador X e a fazer parse com NumberStyles.HexFloat, produzindo o mesmo texto hex IEEE-754 que o printf(\"%a\") do C."
pubDate: 2026-06-02
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat"
translatedBy: "claude"
translationDate: 2026-06-02
---

As [notas das bibliotecas do .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) trouxeram um recurso que parece de nicho até o dia em que você precisa dele: `double`, `float` e `Half` agora podem ser escritos e lidos de volta na forma hexadecimal IEEE-754. É a mesma notação que C e C++ emitem com `printf("%a", ...)`, e ela expõe cada bit do valor diretamente no texto.

## O especificador X antes lançava exceção em um double

Até agora a string de formato `"X"` era apenas para inteiros. Chame-a em um valor de ponto flutuante e você recebia uma `FormatException`:

```csharp
double value = Math.PI;
string hex = value.ToString("X"); // .NET 10: throws FormatException
```

A partir do .NET 11, essa mesma chamada retorna a representação hex do float:

```csharp
using System.Globalization;

double value = Math.PI;

string hex = value.ToString("X"); // "0X1.921FB54442D18P+1"
double round = double.Parse(hex, NumberStyles.HexFloat);

Console.WriteLine(round == value); // True, exact round-trip
```

O novo flag `NumberStyles.HexFloat` é o que avisa o `Parse` e o `TryParse` para lerem essa forma de volta. O `0X1.` inicial é a mantissa, e `P+1` é o expoente binário, então o que você está vendo é o layout literal dos bits, não uma aproximação decimal dele.

## O round-trip decimal já funcionava, então por que se preocupar

Vale a pena ser preciso aqui. Desde o .NET Core 3.0 o formatador de ida e volta mais curto garante que `double.Parse(value.ToString())` devolve exatamente o mesmo `double`. Então o hex não corrige um bug de correção no round-trip decimal.

O que o hex oferece é transparência e interoperabilidade. O texto decimal de um `double` muda de forma conforme o valor e é opaco sobre quais bits estão ativos. A forma hex é canônica: cada `double` distinto mapeia para uma única string hex, e essa string é comparável byte a byte entre plataformas e linguagens. Se você está fixando valores esperados em um teste com arquivo de referência, um desvio de um caractere na última casa decimal é uma dor de cabeça real. O hex torna a comparação exata e óbvia.

## Onde ele faz a diferença

A vantagem mais clara é a interoperabilidade entre linguagens. Uma biblioteca nativa que registra floats com `%a`, ou uma suíte de testes numéricos compartilhada com uma base de código C++, produz hex que o .NET agora pode consumir diretamente:

```csharp
// From a C++ component that printed with %a
string fromNative = "0X1.5BF0A8B145769P+1"; // ~2.718281828...
double e = double.Parse(fromNative, NumberStyles.HexFloat);
```

`Half` e `float` recebem o mesmo tratamento, então valores de meia precisão que saem de um pipeline de ML ou de um buffer de GPU fazem o round-trip sem um salto com perda através de texto decimal. Baixe o [SDK do Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), aponte para `net11.0` e, na próxima vez que precisar serializar um float para uma fixture de teste ou um dump de depuração, use `"X"` em vez de montar na mão uma dança com `BitConverter.DoubleToInt64Bits`.
