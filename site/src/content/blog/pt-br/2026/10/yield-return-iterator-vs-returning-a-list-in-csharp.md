---
title: "iterator com yield return vs retornar uma List<T>: quanto custa de verdade um método IEnumerable em C#"
description: "Um método com yield return custa um objeto de máquina de estados de 40 bytes por chamada, não importa quantos itens produza; uma List<T> custa todo o array interno de uma vez. Medido no .NET 10.0.10: o iterator vence em memória e em saída antecipada, a List<T> vence quando o chamador enumera mais de uma vez, precisa de Count ou chama ToList()."
pubDate: 2026-10-31
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "linq"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/yield-return-iterator-vs-returning-a-list-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-31
---

**Resposta curta:** um método com `yield return` aloca exatamente um objeto pequeno por chamada (40 bytes para um loop simples de `IEnumerable<int>` no .NET 10.0.10), seja produzindo 10 itens ou um milhão. Um método que monta e retorna uma `List<T>` aloca a lista mais um array interno dimensionado para o resultado, o que dá 4.056 bytes para 1.000 ints com a lista pré-dimensionada e 8.424 bytes sem isso. Escolha o iterator quando o chamador enumera uma vez (um único `foreach` sobre ele foi cerca de 2x mais rápido que preencher e ler uma lista com 1.000 itens), pode parar cedo, ou a sequência é grande ou ilimitada. Escolha `List<T>` (e deixe isso claro no tipo de retorno, `List<T>` ou `IReadOnlyList<T>`) quando o chamador precisa de `Count`, indexação, ou vai enumerar mais de uma vez, porque cada passada extra sobre um iterator reexecuta o corpo do seu método.

Tudo abaixo foi medido com C# 14 no .NET 10.0.10 (SDK 10.0.302) em um Apple M4, usando BenchmarkDotNet 0.15.8 para os tempos e `GC.GetAllocatedBytesForCurrentThread()` para as contagens de alocação por chamada.

## A comparação num relance

| | iterator com `yield return` | `List<T>` retornada como `IEnumerable<T>` |
| --- | --- | --- |
| Alocação por chamada (.NET 10.0.10, `int`) | 40 B, constante (às vezes 0 B quando o JIT faz inlining) | 32 B + array interno (4.056 B para 1.000 ints) |
| Trabalho feito no momento da chamada | nenhum, nem verificação de argumentos | todo ele |
| Trabalho feito se o chamador parar após 1 item | 1 item | todos os itens |
| Segundo `foreach` | reexecuta o corpo do método | lê os itens armazenados |
| `Count()` | percorre a sequência inteira | O(1) via `ICollection<T>` |
| `TryGetNonEnumeratedCount` | `false` | `true` |
| `ToList()` / `ToArray()` | cresce por duplicação / cópia de tamanho exato | uma cópia de tamanho exato |
| Exceções lançadas | no primeiro `MoveNext()` | no momento da chamada |
| Thread-safety do resultado | uma nova máquina de estados por enumeração | seguro para leitura por várias threads |

## No que o compilador transforma `yield return`

Este é o iterator usado ao longo do post:

```csharp
// .NET 10.0.10, C# 14
public static IEnumerable<int> Iterator(int n)
{
    for (int i = 0; i < n; i++)
        yield return i * 2;
}
```

O Roslyn reescreve o método em uma classe oculta, aqui chamada `<Iterator>d__0`, e o corpo do método passa a ser "aloque essa classe, guarde os argumentos, retorne-a". Reflection sobre o tipo gerado mostra exatamente o que existe dentro:

```text
Src+<Iterator>d__0
  field Int32 <>1__state
  field Int32 <>2__current
  field Int32 <>l__initialThreadId
  field Int32 n
  field Int32 <>3__n
  field Int32 <i>5__2
  implements IEnumerable`1, IEnumerable, IEnumerator`1, IDisposable, IEnumerator
```

Seis campos `int` mais o cabeçalho de 16 bytes do objeto e o ponteiro da tabela de métodos dão os 40 bytes. Toda variável local que sobrevive a um `yield return` vira um campo (`<i>5__2` é a variável do loop), e todo parâmetro é armazenado duas vezes: `<>3__n` guarda o valor original para que a sequência possa ser enumerada de novo, `n` é a cópia de trabalho. Um método com um parâmetro `string` e uma variável local `DateTime` tem campos maiores, mas a forma nunca depende de quantos itens você produz. Esse é o ponto central: a memória é O(1) na quantidade de itens.

O mesmo objeto é ao mesmo tempo o `IEnumerable<T>` e, na primeira chamada de `GetEnumerator()` feita pela thread criadora, o `IEnumerator<T>`. Assim, um simples `foreach (var x in Iterator(n))` custa uma alocação, não duas.

A versão com `List<T>` é o código que a maioria das pessoas escreve primeiro:

```csharp
// .NET 10.0.10, C# 14
public static List<int> ListCap(int n)
{
    var list = new List<int>(n);
    for (int i = 0; i < n; i++)
        list.Add(i * 2);
    return list;
}
```

Aqui o custo é o objeto `List<int>` de 32 bytes mais um `int[]` de `n` elementos (24 bytes de cabeçalho e tamanho, depois 4 bytes por item). Se você tirar o `n` do construtor, a lista cresce 4, 8, 16, ..., 1024, deixando cada array intermediário para o GC.

## Alocações por chamada, medidas

Cada caso foi executado 200.000 vezes para chegar ao código tier-1 e depois calculada a média de 1.000 chamadas:

| Itens | Iterator, `foreach` | `List<T>(n)`, `foreach` | `List<T>()`, `foreach` | Iterator `.ToList()` | Iterator `.ToArray()` |
| --- | --- | --- | --- | --- | --- |
| 0 | 40 B | 32 B | 32 B | 72 B | 40 B |
| 1 | 40 B | 64 B | 72 B | 112 B | 72 B |
| 10 | 40 B | 96 B | 216 B | 256 B | 104 B |
| 1.000 | 40 B | 4.056 B | 8.424 B | 8.464 B | 4.064 B |

Três coisas se destacam.

Primeiro, com zero itens a lista é na verdade mais barata (32 B vs 40 B), e com um item a diferença é minúscula. Para resultados curtos e limitados, memória não é o motivo para escolher um ou outro.

Segundo, `Iterator(n).ToList()` é a pior coluna. O iterator não implementa `ICollection<T>`, então `ToList()` não consegue pré-dimensionar e cresce por duplicação, exatamente como a lista sem capacidade, mais a máquina de estados de 40 bytes. Se todo chamador chama `ToList()` no seu iterator logo em seguida, você está pagando pelos dois designs. Retorne uma `List<T>` pré-dimensionada.

Terceiro, `ToArray()` sobre um iterator quase não tem desperdício no .NET 10: 4.064 B para 1.000 ints, apenas 8 bytes a mais que o array exato mais o iterator. Desde o .NET 9, `ToArray()` armazena sequências de tamanho desconhecido em segmentos alocados na pilha e copia uma única vez para um array de tamanho exato; cobri essa mudança em [ToList vs ToArray no .NET 9](/pt-br/2025/01/net-performance-tolist-vs-toarray/). Se um chamador precisa materializar um iterator, `ToArray()` é a chamada mais barata.

## O que o JIT do .NET 10 elimina para você

Retornar `List<T>` tipada como `IEnumerable<T>` costumava custar mais uma alocação: o `foreach` sobre a interface chama `IEnumerable<T>.GetEnumerator()`, que faz boxing da struct `List<T>.Enumerator` (40 bytes em 64 bits). No .NET 10.0.10, o caso "List como `IEnumerable`" aloca os mesmos 64 B da lista concreta com um item. Ao reexecutar a sonda com `DOTNET_JitObjectStackAllocation=0`, o box volta (104 B), o que mostra que a devirtualização guardada do JIT mais a alocação de objetos na pilha, parte do [trabalho de de-abstração de enumeradores do .NET 10](https://github.com/dotnet/runtime/issues/108913), agora coloca esse enumerador na pilha. Com zero itens não há box nem com o botão desligado, porque `List<T>` entrega um enumerador vazio compartilhado quando `Count == 0`.

Os 40 bytes do iterator não mudaram nos casos de `foreach`, com ou sem análise de escape. A máquina de estados é retornada para fora do seu método, então escapa por definição, e o JIT só consegue alocá-la na pilha quando faz inlining do método iterator e de tudo que o consome em um único chamador. Isso aconteceu em algumas chamadas LINQ no benchmark abaixo, mas não de forma confiável.

## Tempos: onde cada um vence

BenchmarkDotNet 0.15.8, job padrão, .NET 10.0.10 Arm64 RyuJIT, Apple M4. Cada método monta a sequência e a consome dentro do benchmark, então as linhas "List" incluem o preenchimento da lista. Tempo médio, alocação entre parênteses:

| Benchmark | N = 10 | N = 1.000 | N = 100.000 |
| --- | --- | --- | --- |
| Iterator, `foreach` | 10,7 ns (40 B) | 580 ns (40 B) | 56,9 us (40 B) |
| `List<T>(n)`, `foreach` | 12,7 ns (96 B) | 1.004 ns (4.056 B) | 116,3 us (400.140 B) |
| `List<T>()`, `foreach` | 30,1 ns (216 B) | 1.214 ns (8.424 B) | 145,8 us (1.049.168 B) |
| `List<T>(n)` como `IEnumerable<T>`, `foreach` | 13,2 ns (96 B) | 1.148 ns (4.056 B) | 114,6 us (400.140 B) |
| Iterator, `.First()` | 2,1 ns (0 B) | 2,1 ns (0 B) | 2,0 ns (0 B) |
| `List<T>(n)`, `.First()` | 11,4 ns (96 B) | 666 ns (4.056 B) | 77,3 us (400.140 B) |
| Iterator, `.ToList()` | 34,1 ns (216 B) | 1.452 ns (8.424 B) | 166,9 us (1.049.168 B) |
| Iterator, `.Count()` | 7,3 ns (0 B) | 541 ns (0 B) | 53,5 us (0 B) |

Em uma única passada, o iterator é mais rápido em todos os tamanhos: cerca de 1,2x com 10 itens e 2x com 1.000 e 100.000. Isso surpreende quem espera que "uma chamada de interface por item" perca para "uma lista". A versão com lista faz o mesmo loop para preencher a lista, depois um segundo loop para lê-la, e paga pelo array; o iterator faz um único loop. Com 100.000 ints, o array de 400.140 bytes da lista pré-dimensionada passa do limite de 85.000 bytes, então vai para o Large Object Heap e cada chamada força coletas Gen2 na execução do BenchmarkDotNet.

A saída antecipada é onde a diferença fica absurda: `First()` no iterator custa 2 ns independentemente do tamanho, porque calcula um item. A versão com lista calcula todos os 100.000 antes de `First()` ver qualquer um deles.

As duas linhas em que o iterator perde são as que precisam do resultado inteiro de qualquer forma. `Iterator(n).ToList()` é a linha mais lenta em todas as colunas, mais lenta que montar a lista diretamente sem capacidade, porque adiciona as chamadas de interface por cima do crescimento por duplicação. E embora `Count()` no iterator seja rápido aqui, é rápido porque consome a sequência; se você chama `Count()` e depois `foreach`, executa o método duas vezes, e o `Count` O(1) da lista vence.

Os 0 B nas linhas `First()` e `Count()` do iterator são de novo o JIT do .NET 10: nesses benchmarks ele fez inlining do método iterator e da chamada LINQ e alocou a máquina de estados na pilha. Minha sonda de alocação viu o mesmo em alguns pontos de chamada e os 40 B normais em outros, e `DOTNET_JitObjectStackAllocation=0` restaurou os 40 B em todos os lugares. Trate isso como um bônus, não como algo em torno do qual projetar.

## O iterator se reutiliza, às vezes

Um detalhe explica um número surpreendente na sonda: enumerar o mesmo iterator duas vezes alocou 40 bytes no total, não 80. O `GetEnumerator()` gerado retorna `this` quando o campo de estado é `-2` (recém-criado) e o chamador está na thread criadora. Desassemblar o `Dispose()` gerado no SDK 10.0.302 mostra que ele é apenas `this.<>1__state = -2`, então, quando um `foreach` termina, ou sofre `break`, e descarta o enumerador, o objeto volta ao seu estado inicial e o próximo `foreach` na mesma thread recebe a mesma instância:

```csharp
// .NET 10.0.10, C# 14 (SDK 10.0.302)
var seq = Iterator(5);
foreach (var x in seq) { if (x == 2) break; }
var again = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, again)); // True: reused after Dispose

var fresh = Iterator(5);
var e1 = fresh.GetEnumerator();
e1.MoveNext();
var e2 = fresh.GetEnumerator();
Console.WriteLine(ReferenceEquals(fresh, e2));  // False: e1 still owns the instance
```

Um segundo enumerador obtido enquanto o primeiro ainda está ativo, ou obtido de outra thread, recebe uma nova instância inicializada a partir das cópias dos parâmetros `<>3__` armazenadas. Você nunca precisa raciocinar sobre isso para garantir corretude, mas significa que "iterator enumerado duas vezes" é barato em bytes. Não é barato em trabalho, que é o próximo ponto.

## Armadilhas que decidem por você

### Cada enumeração reexecuta seu método

O iterator não armazena itens. Um segundo `foreach`, um `Count()` seguido de um `foreach`, ou `Any()` seguido de `ToList()` executa o corpo do método de novo, incluindo qualquer chamada a banco de dados, leitura de arquivo ou `Console.WriteLine` dentro dele:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<string> ReadNames(string path)
{
    Console.WriteLine($"opening {path}");
    foreach (var line in File.ReadLines(path))
        yield return line.Trim();
}

var names = ReadNames("names.txt");
if (names.Any())                      // opening names.txt
    Console.WriteLine(names.Count()); // opening names.txt (again)
```

Os analisadores do .NET sinalizam isso como [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851), mas a regra vem desativada por padrão. Se seus chamadores rotineiramente precisam de duas passadas, retorne uma lista. Se você herdou um `IEnumerable<T>` e não sabe dizer se é seguro percorrê-lo duas vezes, [as verificações deste post sobre detectar um IEnumerable materializado](/pt-br/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/) são o mais próximo que a BCL oferece.

### A validação de argumentos é adiada

Nada no corpo de um iterator é executado até o primeiro `MoveNext()`, e isso inclui as cláusulas de guarda no topo:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // runs on first MoveNext, not here
    foreach (var x in source)
    {
        if (count-- <= 0) yield break;
        yield return x;
    }
}

var q = Take(null!, 3);   // no exception
foreach (var x in q) { }  // ArgumentNullException thrown here
```

O stack trace então aponta para o `foreach`, possivelmente longe da chamada incorreta. A correção padrão, e o motivo pelo qual os próprios operadores LINQ da BCL lançam exceções no momento da chamada, é dividir o método em dois: um método público que não é iterator e valida, e um iterator privado (uma função local serve) que produz os itens:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // throws at call time
    ArgumentOutOfRangeException.ThrowIfNegative(count);
    return Core(source, count);

    static IEnumerable<int> Core(IEnumerable<int> source, int count)
    {
        foreach (var x in source)
        {
            if (count-- <= 0) yield break;
            yield return x;
        }
    }
}
```

Um método com `List<T>` não tem essa armadilha: ele roda até o fim, ou lança exceção, antes de retornar.

### `finally` só executa se alguém descartar o enumerador

Blocos `try`/`finally` e `using` dentro de um iterator executam quando a enumeração termina ou quando o enumerador é descartado. O `foreach` sempre descarta, inclusive em `break` e em exceções. Código que chama `GetEnumerator()` e `MoveNext()` manualmente e esquece o `Dispose()` deixa arquivos e conexões abertos até que o GC finalize o que for dono deles. Uma lista não mantém recursos depois de retornar.

### Iterators recursivos são quadráticos

`yield return` não consegue repassar uma sequência aninhada, então um percurso recursivo de árvore escrito como `foreach (var child in Walk(node.Left)) yield return child;` aloca uma máquina de estados por nó e empurra cada item por todos os níveis: O(n x profundidade) chamadas de `MoveNext`. Para árvores profundas, use um `Stack<T>` explícito dentro de um único iterator, ou preencha uma única `List<T>` passada pela recursão.

### O tipo de retorno é uma promessa

Retornar `IEnumerable<T>` de um método que na verdade monta uma `List<T>` esconde o fato de que `Count` é gratuito e convida os chamadores a chamar `ToList()` "só por garantia", copiando os dados uma segunda vez (o caso `List.ToList()` de 8.112 B com 1.000 itens na [tabela de alocações acima](#alocações-por-chamada-medidas), contra 4.056 B da própria lista). Se você materializa, retorne `List<T>`, `IReadOnlyList<T>` ou um array, para que os chamadores vejam isso. Se você faz streaming, retorne `IEnumerable<T>` e documente que é lazy. Para dados vindos de um banco de dados ou da rede, nenhum dos dois é o ideal; [IEnumerable vs IAsyncEnumerable vs IQueryable](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) cobre quando fazer streaming assíncrono em vez disso, e [para que serve IAsyncEnumerable](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) aprofunda em `await foreach`.

## Qual retornar

Use um iterator com `yield return` quando:

- O chamador enumera uma vez, de cima para baixo, que é o caso comum de pipelines com `foreach` e cadeias LINQ.
- O chamador pode parar cedo (`First`, `Any`, `Take`, um `break` ao encontrar uma correspondência). O iterator faz apenas o trabalho que foi pedido.
- A sequência é grande, ilimitada ou produzida a partir de um stream (linhas de um arquivo, páginas de uma API). A memória fica em um único objeto em vez do resultado inteiro.

Retorne uma `List<T>` (tipada como `List<T>` ou `IReadOnlyList<T>`) quando:

- O chamador precisa de `Count`, indexação ou de mais de uma passada.
- O resultado é pequeno e limitado, onde os 40 bytes do iterator e as chamadas de interface por item não trazem nenhum benefício.
- Os chamadores vão chamar `ToList()` de qualquer forma. Pré-dimensione com `new List<T>(capacity)` quando souber a quantidade.
- O método tem efeitos colaterais ou validação que precisam acontecer exatamente uma vez, no momento da chamada.

Meu padrão para APIs públicas é a segunda lista: materializada e com o tipo honesto. Recorro a `yield return` quando saída antecipada ou memória são o requisito real, e nesse caso sempre separo a validação em um wrapper que não é iterator.

## Relacionados

- [IEnumerable vs IAsyncEnumerable vs IQueryable em C#: qual deles o método deve retornar?](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [Como saber se um IEnumerable<T> já foi materializado em C#](/pt-br/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [Desempenho no .NET: ToList vs ToArray](/pt-br/2025/01/net-performance-tolist-vs-toarray/)
- [O que é IAsyncEnumerable e quando devo usá-lo?](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [Como iterar sobre duas coleções em paralelo sem alocações no heap em C#](/pt-br/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/)

## Fontes

- [yield statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/yield) (referência da linguagem C#)
- [Iterators](https://learn.microsoft.com/dotnet/csharp/iterators) (guia de C#)
- [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851) (Microsoft Learn)
- [Enumerable.TryGetNonEnumeratedCount](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) (Microsoft Learn)
- [Roslyn iterator rewriter source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/IteratorRewriter/IteratorMethodToStateMachineRewriter.cs.html) (source.dot.net)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime) (Microsoft Learn)
