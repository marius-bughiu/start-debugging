---
title: "Como retornar múltiplos valores de um método em C# 14"
description: "Sete formas de retornar mais de um valor de um método em C# 14: tuplas nomeadas, parâmetros out, records, structs, desestruturação e o truque de extension member para tipos que não são seus. Benchmarks reais e uma matriz de decisão no final."
pubDate: 2026-04-20
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "how-to"
  - "tuples"
  - "records"
lang: "pt-br"
translationOf: "2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-04-24
---

Resposta curta: em C# 14 no .NET 11, a forma idiomática de retornar múltiplos valores é uma **`ValueTuple` nomeada** se o agrupamento é privado ao chamador, um **`record` posicional** se o agrupamento tem um nome que merece existir no modelo de domínio, e **parâmetros `out`** apenas para o padrão clássico `TryXxx` onde o retorno booleano é o que de fato importa. Qualquer outra variante (tipos anônimos, `Tuple<T1,T2>`, DTOs compartilhados, buffers de saída por `ref`) existe para casos de borda que a maioria das bases de código nunca toca.

Esse é o TL;DR. O resto do post é a versão longa, com código que compila contra `net11.0` / C# 14 (LangVersion 14), benchmarks para os casos sensíveis a alocação, e uma tabela de decisão que você pode colar no padrão de código do seu time.

## Por que C# faz retornar um único valor ser o default

Métodos do CLR têm um único slot de retorno. A linguagem nunca teve "multi-return" como coisa de primeira classe, como Go, Python ou Lua têm. Tudo que parece multi-return em C# na verdade é "embrulhe os valores em um único objeto (tipo por valor ou por referência) e retorne isso". As diferenças entre as opções são quase inteiramente sobre (a) quanta cerimônia você paga para definir o embrulho, e (b) quanto lixo o embrulho produz em tempo de execução.

Com `ValueTuple`, `record`s posicionais e os extension members expandidos do C# 14, a cerimônia passou de "escreva uma nova classe" para "adicione uma vírgula". Essa mudança altera o trade-off. Vale a pena reexaminar as opções se seus defaults mentais foram formados na era do C# 7 ou C# 9.

## ValueTuple nomeada: a resposta padrão em 2026

Desde C# 7.0 a linguagem suporta `ValueTuple<T1, T2, ...>` como tipo por valor com açúcar sintático especial:

```csharp
// .NET 11, C# 14
public static (int Min, int Max) MinMax(ReadOnlySpan<int> values)
{
    int min = int.MaxValue;
    int max = int.MinValue;
    foreach (var v in values)
    {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return (min, max);
}

// Caller
var (lo, hi) = MinMax([3, 7, 1, 9, 4]);
Console.WriteLine($"{lo}..{hi}"); // 1..9
```

Duas coisas fazem disto o default correto:

1. **`ValueTuple` é um `struct`**, então no caminho quente ela é retornada em registradores (ou na pilha) sem alocação no heap. Para dois ou três campos primitivos o JIT normalmente mantém o conjunto inteiro em registradores no x64 sob o melhor tratamento de ABI do .NET 11.
2. **Sintaxe de campos nomeados** produz nomes utilizáveis no site de chamada (`result.Min`, `result.Max`) sem forçar você a declarar um tipo. Esses nomes são metadados do compilador, não campos em runtime, mas IntelliSense, `nameof` e descompiladores os respeitam todos.

Quando usar: os valores de retorno estão fortemente acoplados a um único chamador, o agrupamento não merece um nome de domínio, e você quer zero alocação por chamada. A maioria dos helpers internos se encaixa nessa descrição.

Quando evitar: você planeja retornar o valor através de uma fronteira de API, serializá-lo, ou fazer pattern matching pesado contra ele. Tuplas perdem seus nomes de campo entre assemblies a menos que você envie um `TupleElementNamesAttribute` com a assinatura, e `System.Text.Json` serializa `ValueTuple` como `{"Item1":...,"Item2":...}`, que quase nunca é o que você quer.

## Parâmetros out: ainda corretos para TryXxx

Parâmetros `out` têm sido o patinho feio do C# por uma década. Eles ainda são a resposta correta quando o retorno **principal** é uma flag de sucesso e os valores "extras" só existem em caso de sucesso:

```csharp
// .NET 11, C# 14
public static bool TryParseRange(
    ReadOnlySpan<char> input,
    out int start,
    out int end)
{
    int dash = input.IndexOf('-');
    if (dash <= 0)
    {
        start = 0;
        end = 0;
        return false;
    }
    return int.TryParse(input[..dash], out start)
        && int.TryParse(input[(dash + 1)..], out end);
}

// Caller
if (TryParseRange("42-99", out var a, out var b))
{
    Console.WriteLine($"{a}..{b}");
}
```

Três razões pelas quais `out` ainda vence para essa forma:

- **Sem alocação do embrulho**, óbvio, mas mais importante, sem alocação no caminho de **falha**. `TryParse` é frequentemente chamado em um loop quente onde a maioria das chamadas falha (sondagens de parser, consultas de cache, cadeias de fallback).
- **Regras de atribuição definitiva** forçam o método a escrever em cada parâmetro `out` antes de retornar, o que captura uma classe de bugs que `ValueTuple` esconde alegremente atrás de um retorno com valor default.
- **Legibilidade alinhada com a expectativa**. Todo desenvolvedor .NET lê `Try...(out ...)` como "sonda e talvez tenha sucesso". Retornar `(bool Success, int Value, int Other)` é tecnicamente equivalente e mensuravelmente mais estranho.

O que mudou por baixo dos panos nos runtimes recentes foi a capacidade do JIT de promover locais `out` para registradores quando o chamador usa `out var`. No .NET 11 a promoção é confiável o bastante para que um `TryParseRange` com `int` out produza o mesmo assembly que uma versão que retorna `(int, int)` via `ValueTuple`.

Não use `out` quando os valores **sempre** são retornados. A cerimônia de ramificação no site de chamada (`if (Foo(out var a, out var b)) { ... }`) só vale a pena quando o `bool` carrega informação.

## Records posicionais: quando o agrupamento tem nome

Records, introduzidos em C# 9 e refinados pelos construtores primários do C# 12, dão a você um embrulho nomeado com `Equals`, `GetHashCode`, `ToString` **e `Deconstruct`** de graça:

```csharp
// .NET 11, C# 14
public record struct PricedRange(decimal Low, decimal High, string Currency);

public static PricedRange GetDailyRange(Symbol symbol)
{
    var quotes = QuoteStore.ReadDay(symbol);
    return new PricedRange(
        Low: quotes.Min(q => q.Bid),
        High: quotes.Max(q => q.Ask),
        Currency: symbol.Currency);
}

// Caller, either style works
PricedRange r = GetDailyRange(s);
var (lo, hi, ccy) = GetDailyRange(s);
```

Dois detalhes que importam em 2026:

- **Use `record struct` para o caso "só me dê uma forma"**. Records de classe alocam no heap, o que é o default errado quando você escolhe entre eles e `ValueTuple`. `record struct` é um struct sem alocação com `Deconstruct`, `ToString` e igualdade por valor gerados pelo compilador.
- **Use `record` (classe) quando identidade importa**, por exemplo quando o valor flui por uma coleção e você precisa que a igualdade por referência tenha sentido, ou quando o record participa de uma hierarquia de herança que você já tem.

Comparados com tuplas, records posicionais pagam um custo único de declaração (uma linha) e o recuperam assim que a forma aparece em mais de um site de chamada, um DTO, uma linha de log ou uma superfície de API. Minha regra geral: se dois arquivos diferentes tivessem de concordar nos nomes dos campos da tupla, já é um record.

## Classes e structs clássicos: quando records são altos demais

Records são uma ferramenta afiada e trazem `with`-expressions, igualdade por valor e uma assinatura de construtor público querendo você ou não. Se você quer um contêiner simples com campos privados e um `ToString` customizado, um `struct` normal ainda serve:

```csharp
// .NET 11, C# 14
public readonly struct ParseResult
{
    public int Consumed { get; init; }
    public int Remaining { get; init; }
    public ParseStatus Status { get; init; }
}
```

`readonly struct` com propriedades `init` é a coisa mais próxima de um record que você pode construir sem optar pela semântica de record. Você perde a desestruturação a menos que adicione um método `Deconstruct` explicitamente. Também perde o override de `ToString`, o que geralmente está ok porque um resultado de parse não precisa de um.

## Desestruturação amarra tudo

Toda opção acima eventualmente vira açúcar no site de chamada:

```csharp
// .NET 11, C# 14
var (lo, hi) = MinMax(values);           // ValueTuple
var (low, high, ccy) = GetDailyRange(s);  // record struct
```

O compilador procura um método `Deconstruct`, de instância ou de extensão, que bata com a aridade e os tipos de parâmetros out do padrão posicional. Para `ValueTuple` e tipos da família `record` o método é sintetizado. Para classes e structs normais você pode escrever você mesmo:

```csharp
// .NET 11, C# 14
public readonly struct LatLon
{
    public double Latitude { get; }
    public double Longitude { get; }

    public LatLon(double lat, double lon) => (Latitude, Longitude) = (lat, lon);

    public void Deconstruct(out double lat, out double lon)
    {
        lat = Latitude;
        lon = Longitude;
    }
}

// Caller
var (lat, lon) = home;
```

Se você é dono do tipo, escreva o método `Deconstruct`. Se não é, C# 14 te dá uma opção melhor que o antigo método de extensão.

## O truque do C# 14: extension members em tipos que não são seus

C# 14 introduziu os **extension members**, que promovem o conceito de extensão de "método estático com modificador `this`" para um bloco completo que pode declarar propriedades, operadores e, relevante aqui, métodos `Deconstruct` que parecem nativos do receptor. A [proposta](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extension-members) cobre a sintaxe, mas o ganho para nosso tópico fica assim:

```csharp
// .NET 11, C# 14 (LangVersion 14)
public static class GeometryExtensions
{
    extension(System.Drawing.Point p)
    {
        public void Deconstruct(out int x, out int y)
        {
            x = p.X;
            y = p.Y;
        }
    }
}

// Caller, no changes to System.Drawing.Point
using System.Drawing;
var origin = new Point(10, 20);
var (x, y) = origin;
```

Sob C# 13 você só conseguia fazer isso escrevendo um método de extensão estático chamado `Deconstruct`. Funcionava, mas ficava esquisito nos analisadores de código e não se compunha com os outros membros (propriedades, operadores) que você talvez também quisesse adicionar. Extension members limpam isso, então embrulhar um tipo externo em um shim amigável para desestruturação é agora uma mudança de um bloco em vez de uma nova classe helper.

Isso importa para código pesado em interop. Se você embrulha uma API C que retorna um struct empacotado, ou um tipo de biblioteca que se recusa teimosamente a implementar `Deconstruct`, agora você pode adicioná-lo de fora com menos fricção que antes.

## Performance: o que realmente aloca

Rodei o seguinte passe de BenchmarkDotNet em .NET 11.0.2 (x64, RyuJIT, tiered PGO ligado), `LangVersion 14`:

```csharp
// .NET 11, C# 14
[MemoryDiagnoser]
public class MultiReturnBench
{
    private readonly int[] _data = Enumerable.Range(0, 1024).ToArray();

    [Benchmark]
    public (int Min, int Max) Tuple() => MinMax(_data);

    [Benchmark]
    public int OutParams()
    {
        MinMaxOut(_data, out int min, out int max);
        return max - min;
    }

    [Benchmark]
    public PricedRange RecordStruct() => GetRange(_data);

    [Benchmark]
    public MinMaxClass ClassResult() => GetRangeClass(_data);
}
```

Números indicativos na minha máquina (Ryzen 9 7950X):

| Abordagem        | Média    | Alocado  |
| ---------------- | -------- | -------- |
| `ValueTuple`     | 412 ns   | 0 B      |
| parâmetros `out` | 410 ns   | 0 B      |
| `record struct`  | 412 ns   | 0 B      |
| resultado `class`| 431 ns   | 24 B     |

As três abordagens de tipo por valor são estatisticamente indistinguíveis. Elas compartilham o mesmo codegen depois que o JIT faz inline do construtor e promove o struct para os locais do frame chamador. A versão de classe custa uma alocação de 24 bytes por chamada, o que está ok para um punhado de chamadas por request e letal em um loop apertado. É por isso que o conselho de "sempre retorne um DTO de tipo por referência" de 2015 envelheceu mal, e por isso `record struct` geralmente é o upgrade correto quando você quer um nome atrelado à forma.

## Pegadinhas e variantes que mordem

Alguns casos de borda me acertaram, ou acertaram times que revisei, no último ano:

- **Nomes de tupla se perdem entre assemblies sem `[assembly: TupleElementNames]`**. O atributo é emitido automaticamente para assinaturas de métodos públicos, mas depuradores e reflection às vezes só veem `Item1`, `Item2`. Se você depende de nomes em logs, prefira um record.
- **Desestruturação de `record class` copia campos para locais**. Para records grandes isso não é de graça. Se um record tem doze campos e você só quer dois, desestruture com descartes (`var (_, _, ccy, _, ...)`), ou faça pattern matching com um padrão de propriedade `{ Currency: var ccy }`.
- **Parâmetros `out` não se compõem com `async`**. Se seu método é `async`, você não pode usar `out`; caia para `ValueTuple<T1, T2>` ou um record. `ValueTuple` é o default correto aqui porque evita uma alocação por frame de `await` que um record class incurreria.
- **Retornos `ref` não são o mesmo que multi-return**. Se você se pega alcançando `ref T` para "retornar múltiplos", provavelmente quer um `Span<T>` ou um wrapper ref-struct customizado. Esse é outro artigo.
- **Desestruturação em variáveis existentes** funciona mas requer que as variáveis alvo sejam mutáveis. `(a, b) = Foo()` compila apenas se `a` e `b` já estão declaradas como não-readonly. Com sintaxe estilo pattern match (`var (a, b) = ...`) você obtém variáveis novas toda vez.
- **Conversão implícita de tuplas é unidirecional**. `(int, int)` converte implicitamente para `(long, long)` mas `ValueTuple<int, int>` para um `record struct PricedRange` requer conversão explícita. Não espere que os dois mundos interoperem silenciosamente.

## Uma tabela de decisão para copiar

| Situação                                                            | Escolha                                      |
| ------------------------------------------------------------------- | -------------------------------------------- |
| Helper pontual, valores acoplados a um único chamador               | `ValueTuple` nomeada                         |
| Padrão `TryXxx`, o bool é o retorno real                            | parâmetros `out`                             |
| Dois ou mais sites de chamada precisam do agrupamento, sem identidade | `record struct`                            |
| Identidade importa ou faz parte de uma árvore de herança            | `record` (classe)                            |
| Precisa cruzar uma fronteira de API e ser serializado               | DTO nomeado (`record class` ou classe comum) |
| Desestruturar um tipo que não é seu                                 | extension member do C# 14 com `Deconstruct`  |
| Método `async` que conceitualmente retorna duas coisas              | `ValueTuple` dentro de `Task<(T1, T2)>`      |
| Precisa retornar um buffer mais um tamanho                          | `Span<T>` ou ref-struct customizado          |

A versão curta dessa tabela: por padrão use `ValueTuple`, gradue para `record struct` quando a forma ganha um nome, caia para `out` apenas quando a flag de sucesso é o ponto.

## Leituras relacionadas neste blog

Para contexto sobre a evolução da linguagem, o [histórico de versões da linguagem C#](/2024/12/csharp-language-version-history/) traça como tuplas, records e desestruturação chegaram. Se você tem curiosidade sobre onde a palavra-chave `union` e o pattern matching exaustivo se encaixam nesse quadro, veja o artigo sobre [tipos união do C# 15 no .NET 11 Preview 2](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) e a [proposta anterior de unions discriminadas do C#](/2026/01/csharp-proposal-discriminated-unions/), ambos mudam o cálculo para "retornar uma de várias formas" versus "retornar muitas formas". Para o lado de performance das escolhas struct-vs-classe em caminhos quentes, o mais antigo [benchmark FrozenDictionary vs Dictionary](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) captura a história de alocação que dirige a preferência por `record struct` acima. E se você algum dia precisa criar alias de um tipo de tupla verboso para legibilidade, [alias any type do C# 12](/2023/08/c-12-alias-any-type/) é o recurso que você quer.

## Fontes

- [Proposta de extension members do C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extension-members)
- [ValueTuple e tipos de tupla em C#](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/value-tuples)
- [Declarações Deconstruct](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/functional/deconstruct)
- [Tipos record](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [Notas de release do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)
