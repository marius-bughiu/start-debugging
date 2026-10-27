---
title: "Como percorrer duas coleções em paralelo sem alocações no heap em C#"
description: "Enumerable.Zip aloca 144-208 bytes por chamada e roda cerca de 10x mais devagar que um loop simples. Para arrays e listas, um loop for sobre dois spans fatiados com o mesmo comprimento não aloca nada e é a opção mais rápida; para a sintaxe foreach, um pequeno enumerador zip em ref struct fica a 25% dele. Medido no .NET 10.0.10 e no .NET 11 RC 3."
pubDate: 2026-10-27
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "linq"
  - "memory"
lang: "pt-br"
translationOf: "2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Resposta curta:** se as duas fontes são arrays, listas ou qualquer coisa da qual você consiga obter um `ReadOnlySpan<T>`, pegue o menor comprimento, fatie os dois spans até ele e rode um único loop `for` com um só índice. Isso não aloca nada e é o formato mais rápido que o JIT conhece. Se você quer a sintaxe `foreach (var (x, y) in ...)` sem o custo, escreva um enumerador zip em `ref struct` de 20 linhas que verifica os dois comprimentos em `MoveNext`. Se as fontes não são indexáveis (um `HashSet<T>`, um `Dictionary<TKey, TValue>`), conduza os enumeradores struct delas manualmente, com duas chamadas a `GetEnumerator()` nos tipos concretos. Evite `Enumerable.Zip` em caminhos críticos: no .NET 10.0.10 e no .NET 11 RC 3 ele aloca de 144 a 208 bytes por chamada e, no benchmark abaixo, rodou cerca de 10x mais devagar que o loop simples.

Tudo neste post foi medido com C# 14 no .NET 10.0.10 (SDK 10.0.302) e no .NET 11.0.0-rc.3.26522.148 em um Apple M4. Os números de alocação foram idênticos nos dois runtimes.

## De onde vêm os bytes do Enumerable.Zip

`Enumerable.Zip` é a resposta óbvia para "percorrer duas sequências juntas", e desde o .NET Core 3.0 ele tem uma sobrecarga que retorna tuplas, então o código fica legível:

```csharp
// .NET 10, C# 14
long sum = 0;
foreach (var (x, y) in first.Zip(second))
    sum += (long)x * y;
```

O problema é que cada peça desse pipeline é um tipo de referência atrás de uma interface. `Zip` recebe dois parâmetros `IEnumerable<T>`, então chama `GetEnumerator()` pela interface em cada fonte. Para um `List<T>`, isso faz boxing do seu `List<T>.Enumerator` struct; para um array, aloca um objeto enumerador de array. Depois, o próprio `Zip` retorna um objeto iterador que guarda os dois. Seu `foreach` conversa com esse iterador por meio de `IEnumerator<(T1, T2)>`, então cada `MoveNext` e cada `Current` é uma chamada de interface que o JIT normalmente não consegue fazer inline.

Medi as alocações em regime estável com `GC.GetAllocatedBytesForCurrentThread()` depois de deixar cada método subir para o Tier 1 com PGO dinâmico, usando duas fontes `int` de 1.000 elementos:

| Abordagem | Alocado por chamada (.NET 10.0.10 e 11 RC 3) |
|---|---|
| Loop `for` com um índice sobre arrays | 0 B |
| Loop `for` sobre dois `ReadOnlySpan<int>` fatiados | 0 B |
| `CollectionsMarshal.AsSpan` em dois `List<int>` | 0 B |
| Enumerador zip em `ref struct` com `foreach` | 0 B |
| Dois `List<int>.Enumerator` conduzidos manualmente | 0 B |
| Dois `IEnumerator<int>`, fontes tipadas como `IEnumerable<int>` sobre arrays | 64 B |
| Dois `IEnumerator<int>`, fontes tipadas como `IEnumerable<int>` sobre listas | 80 B |
| `Enumerable.Zip`, sobrecarga com tupla, arrays | 144 B |
| `Enumerable.Zip` com um seletor de resultado estático, arrays | 160 B |
| `Enumerable.Zip`, sobrecarga com tupla, listas | 160 B |
| `Enumerable.Zip` com três fontes, arrays | 208 B |

O custo é por chamada, não por elemento, então não importa para um loop que você roda uma vez na inicialização. Importa quando o loop em paralelo fica dentro de um handler de requisição, de um tick de jogo, de um parser ou de qualquer outra coisa que rode milhões de vezes. Algumas centenas de bytes por chamada, multiplicadas pela taxa de chamadas, são exatamente a rotatividade de Gen0 que aparece em um trace.

Note que o lambda estático na sobrecarga com seletor não ajudou: o delegate fica em cache, mas o iterador e os dois enumeradores continuam sendo alocados.

## A versão mais rápida: um índice, dois spans fatiados

Quando as duas fontes são memória contígua, você não precisa de enumeradores. Um único índice percorre as duas:

```csharp
// .NET 10, C# 14
static long DotProduct(ReadOnlySpan<int> a, ReadOnlySpan<int> b)
{
    int n = Math.Min(a.Length, b.Length);
    a = a[..n];
    b = b[..n];

    long sum = 0;
    for (int i = 0; i < a.Length; i++)
        sum += (long)a[i] * b[i];
    return sum;
}

int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];
long total = DotProduct(prices, quantities); // 100
```

O fatiamento não é enfeite. A condição do loop é `i < a.Length`, o que permite ao JIT remover a verificação de limites em `a[i]`. Depois de `b = b[..n]` com o mesmo `n`, o JIT também sabe que `b.Length == a.Length`, então pode remover a verificação em `b[i]` também. Sem a fatia, `b[i]` mantém uma verificação de limites em toda iteração, porque nada no loop prova que `b` é pelo menos tão longo quanto `a`. É a mesma regra de "fazer do comprimento o limite do loop" que abordei em [o que é Span<T> e quando ele realmente deixa o código mais rápido](/pt-br/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

Arrays se convertem implicitamente para `ReadOnlySpan<T>`, então os pontos de chamada continuam limpos. Para `List<T>`, pegue o span sobre o array interno com `CollectionsMarshal.AsSpan`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

List<int> prices = [10, 20, 30];
List<int> quantities = [3, 2, 1];

long total = DotProduct(
    CollectionsMarshal.AsSpan(prices),
    CollectionsMarshal.AsSpan(quantities));
```

`CollectionsMarshal.AsSpan` é gratuito: retorna um span sobre o array interno da lista, limitado a `Count`. O porém é que o span não sabe mais nada sobre a lista. Se você fizer `Add` na lista enquanto segura o span e a lista crescer, o span continua apontando para o array antigo, e você vai ler dados desatualizados sem nenhuma exceção. Não altere o tamanho da lista enquanto o span estiver vivo. A comparação [List<T> vs Span<T> vs ReadOnlySpan<T>](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) trata do restante desse trade-off.

Para escrever em uma das sequências enquanto lê a outra, faça do destino um `Span<T>` em vez de um `ReadOnlySpan<T>`. O padrão não muda.

## Mantendo a sintaxe foreach com um enumerador zip em ref struct

O loop com índice é rápido, mas não é bonito, e quando o corpo tem mais de uma linha, `a[i]` e `b[i]` viram ruído. O `foreach` do C# é baseado em padrão: ele não exige `IEnumerable<T>`, apenas um método `GetEnumerator()` que retorne algo com `MoveNext()` e `Current`. Esse algo pode ser uma `ref struct`, o que significa que pode guardar spans e nunca sofrer boxing:

```csharp
// .NET 10, C# 14
public ref struct SpanZip<T1, T2>
{
    private readonly ReadOnlySpan<T1> _first;
    private readonly ReadOnlySpan<T2> _second;
    private int _index;

    public SpanZip(ReadOnlySpan<T1> first, ReadOnlySpan<T2> second)
    {
        _first = first;
        _second = second;
        _index = -1;
    }

    public SpanZip<T1, T2> GetEnumerator() => this;

    public bool MoveNext()
    {
        int i = _index + 1;
        if ((uint)i < (uint)_first.Length && (uint)i < (uint)_second.Length)
        {
            _index = i;
            return true;
        }
        return false;
    }

    public (T1 First, T2 Second) Current => (_first[_index], _second[_index]);
}

public static class SpanZipExtensions
{
    public static SpanZip<T1, T2> ZipSpan<T1, T2>(
        this ReadOnlySpan<T1> first, ReadOnlySpan<T2> second) => new(first, second);
}
```

O uso parece LINQ:

```csharp
// .NET 10, C# 14
int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];

long total = 0;
foreach (var (price, quantity) in prices.ZipSpan(quantities))
    total += (long)price * quantity;
```

A tupla retornada é uma `ValueTuple`, uma struct, então desconstruí-la não custa nada no heap. Chamar um método de extensão de `ReadOnlySpan<T>` diretamente em um `int[]`, com os argumentos de tipo inferidos, depende das conversões de span de primeira classe do C# 14; no C# 13 você escreveria `prices.AsSpan()` antes. Com um `List<T>`, chame-o em `CollectionsMarshal.AsSpan(list)`.

O formato de `MoveNext` importa mais do que parece. Minha primeira versão fatiava os dois spans até o comprimento comum no construtor e só comparava `_index` com `_first.Length` em `MoveNext`. Estava correto, mas rodava a quase exatamente 2x o custo do loop simples. Verificar os dois comprimentos em `MoveNext` baixou para 1,23x. Minha leitura do resultado é que, uma vez que `MoveNext` e `Current` são feitos inline, o JIT vê as duas comparações logo antes das duas chamadas ao indexador e pode usá-las para remover verificações de limites; uma fatia feita em outro método não lhe dá esse fato. De qualquer forma, a diferença medida é grande, então mantenha as duas verificações.

Duas restrições vêm junto com `ref struct`: você não pode usar `SpanZip` atravessando um `await` ou `yield return`, e não pode armazená-la em um campo de uma classe normal. Se o compilador reclamar de tempo de vida, as regras são as descritas em [como o C# decide o ref-safe-context](/pt-br/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/).

## Quando as fontes não são indexáveis

`HashSet<T>`, `Dictionary<TKey, TValue>`, `Queue<T>`, `LinkedList<T>` e companhia não conseguem fornecer um span, mas todos expõem um enumerador struct público quando você chama `GetEnumerator()` no tipo concreto. Conduza dois deles você mesmo:

```csharp
// .NET 10, C# 14
static long SumProducts(List<int> a, List<int> b)
{
    long sum = 0;
    using var ea = a.GetEnumerator();   // List<int>.Enumerator, a struct
    using var eb = b.GetEnumerator();
    while (ea.MoveNext() && eb.MoveNext())
        sum += (long)ea.Current * eb.Current;
    return sum;
}
```

Isso mediu 0 B por chamada. O detalhe importante é o tipo estático dos parâmetros. Troque `List<int>` por `IEnumerable<int>` e exatamente o mesmo corpo aloca 80 B por chamada (duas instâncias de `List<int>.Enumerator` com boxing), ou 64 B quando os objetos em tempo de execução são arrays. O `var` esconde isso: `ea` é `List<int>.Enumerator` em uma versão e `IEnumerator<int>` na outra.

Enumeradores struct também mantêm as verificações de segurança da própria coleção. `List<T>.Enumerator` lança `InvalidOperationException` se a lista for modificada durante a enumeração, algo que as versões baseadas em span não conseguem fazer.

A ordem é a outra armadilha aqui. Um percurso em paralelo sobre duas instâncias de `HashSet<T>` ou `Dictionary<TKey, TValue>` emparelha elementos pela ordem interna dos buckets, que não é a ordem de inserção e não é estável entre instâncias diferentes com o mesmo conteúdo. Só faça zip de coleções ordenadas. Se você na verdade está tentando casar itens por chave, isso é um join ou uma busca em dicionário, não um zip.

## O que a alocação na pilha do .NET 10 resolve e o que não resolve

O .NET 10 ensinou o JIT a desvirtualizar métodos de interface de arrays e, por meio de análise de escape condicional, a alocar enumeradores na pilha "em certos cenários", como diz a página [What's new in .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime#array-enumeration-de-abstraction). É razoável esperar que isso torne as versões com interface gratuitas. Nas minhas execuções, não tornou:

- As variantes de `Enumerable.Zip` alocaram os mesmos bytes no .NET 10.0.10 e no .NET 11 RC 3. Os enumeradores são criados dentro do iterador do `Zip`, que escapa para quem chamou, então a análise de escape não tem com o que trabalhar.
- Dois `IEnumerator<int>` sobre arrays alocaram 64 B na minha medição em regime estável e 32 B no BenchmarkDotNet. Isso sugere que o JIT alocou na pilha um dos dois enumeradores em algumas compilações e nenhum em outras. É uma otimização na qual você não pode confiar, e nunca chega a zero.

O trabalho de desabstração é real e ajuda, sim, o `foreach` de sequência única sobre um array tipado como `IEnumerable<T>`. Se você quer o contexto, [a alocação na pilha de arrays pequenos do .NET 10](/pt-br/2025/04/net-10-stack-allocation-of-arrays-of-value-types/) cobre o trabalho relacionado com arrays. Ele só ainda não cobre o caso de duas fontes.

## Os números

BenchmarkDotNet 0.15.8, `[MemoryDiagnoser]`, toolchain in-process, .NET 10.0.10 Arm64 RyuJIT, Apple M4, dois arrays (ou listas) de 1.000 valores `int`, calculando uma soma de produtos:

| Método | Média | Razão | Alocado |
|---|---:|---:|---:|
| `for` com um índice sobre arrays | 247.9 ns | 1.00 | 0 B |
| `for` sobre dois `ReadOnlySpan<int>` fatiados | 249.7 ns | 1.01 | 0 B |
| `CollectionsMarshal.AsSpan` em duas listas | 250.9 ns | 1.01 | 0 B |
| `SpanZip` com os dois comprimentos verificados em `MoveNext` | 310.0 ns | 1.23 | 0 B |
| `SpanZip` fatiado no construtor (primeiro rascunho) | 489.6 ns | 1.97 | 0 B |
| Dois `List<int>.Enumerator` conduzidos manualmente | 652.5 ns | 2.63 | 0 B |
| Dois `IEnumerator<int>` sobre arrays | 1,621.2 ns | 6.54 | 32 B |
| `Enumerable.Zip` com um seletor estático | 2,535.9 ns | 10.23 | 160 B |
| `Enumerable.Zip`, sobrecarga com tupla | 2,613.6 ns | 10.54 | 144 B |

A linha de `SpanZip` com as duas verificações vem de uma segunda execução da mesma classe de benchmark, em que a linha de base `for` mediu 251,4 ns, então a razão é calculada contra a linha de base dessa execução. A toolchain in-process foi necessária porque o BenchmarkDotNet não consegue gerar seu projeto separado habitual para um app baseado em arquivo `dotnet run bench.cs`.

Duas leituras da tabela. Primeiro, tudo que tem formato de span fica dentro do ruído do loop escrito à mão; `CollectionsMarshal.AsSpan` não acrescenta nada mensurável. Segundo, "sem alocação" e "rápido" são propriedades diferentes: os enumeradores struct manuais não alocam nada, mas ainda custam 2,6x, porque `List<T>.Enumerator.MoveNext` carrega uma verificação de versão e uma verificação de limites por elemento. Se sua preocupação é pressão no GC, qualquer linha com zero alocação resolve. Se sua preocupação é throughput, use spans.

## Escolhendo entre eles

- As duas fontes são arrays, listas, `ImmutableArray<T>`, `Memory<T>` ou buffers na pilha: use o loop `for` com spans fatiados, ou `SpanZip` se você prefere `foreach` e pode abrir mão de cerca de 20% em um loop numérico apertado. Para um corpo de loop que faz trabalho de verdade, esses 60 ns por mil elementos desaparecem.
- As fontes são outras coleções da BCL: guarde-as pelo tipo concreto e conduza os enumeradores struct. Nunca deixe que elas passem antes por um parâmetro `IEnumerable<T>`.
- Os comprimentos podem diferir e isso é um bug: verifique `a.Length != b.Length` e lance uma exceção antes do loop. `Enumerable.Zip`, o loop com span acima e `SpanZip` param silenciosamente na sequência mais curta, e a BCL não tem um zip estrito; conferi os reference assemblies do .NET 11 RC 3 e `Enumerable.Zip` continua sendo o único zip disponível.
- Três ou mais fontes: o loop com span se estende trivialmente (fatie as três até o comprimento mínimo). A sobrecarga de três fontes do `Enumerable.Zip`, adicionada no .NET 6, custa 208 B por chamada.
- Código frio, entradas pequenas ou um pipeline LINQ que já aloca: mantenha `Enumerable.Zip`. É a versão mais clara e os bytes não importam ali.

Se você está migrando muito LINQ para spans, lembre que o C# 14 mudou como argumentos de array se ligam a sobrecargas com span; [as conversões implícitas de span no C# 14](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) explicam por que uma chamada que antes escolhia uma sobrecarga `IEnumerable<T>` agora pode escolher uma com span.

### Leia a seguir

- [O que é Span<T> em C#, e quando ele realmente deixa seu código mais rápido?](/pt-br/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)
- [List<T> vs Span<T> vs ReadOnlySpan<T> em C#](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [O que é ref-safe-context em C#, e como o compilador o decide para ref locals?](/pt-br/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/)
- [.NET 10: alocação na pilha de arrays de tipos de valor](/pt-br/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)

### Fontes

- [Método Enumerable.Zip](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.zip) (Microsoft Learn)
- [Método CollectionsMarshal.AsSpan](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan) (Microsoft Learn)
- [A instrução foreach e a enumeração baseada em padrão](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/iteration-statements#the-foreach-statement) (referência da linguagem C#)
- [Tipos ref struct](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/ref-struct) (referência da linguagem C#)
- [What's new in .NET 10 runtime: desabstração da enumeração de arrays e alocação na pilha](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime)
- [Planos de desabstração do .NET 10, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
