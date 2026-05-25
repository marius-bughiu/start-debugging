---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> em C#: quando usar cada um"
description: "List<T> é uma coleção de heap que cresce; Span<T> e ReadOnlySpan<T> são visões apenas na pilha sobre memória que você já possui. Use List<T> para tudo que você armazena, retorna de async ou faz crescer; Span<T> para uma visão mutável sem alocações em um método síncrono; ReadOnlySpan<T> para análise somente leitura sobre strings, literais u8 e fatias."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "pt-br"
translationOf: "2026/05/list-vs-span-vs-readonlyspan-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-25
---

Use `List<T>` quando você tiver uma coleção que cresce, é guardada em um campo, retornada de um método ou passada através de um `await`. Use `Span<T>` quando quiser uma visão mutável e sem alocações sobre um buffer contíguo que você já tem (um array, um bloco `stackalloc`, uma fatia) dentro de um único método síncrono. Use `ReadOnlySpan<T>` para a mesma visão quando você só lê: fatiamento de strings, literais `u8`, análise, busca. A decisão que se sobrepõe ao gosto: os dois spans são tipos `ref struct`, então eles não podem viver no heap, não podem ser um campo de uma classe e não podem cruzar um `await` ou um `yield`. Se você precisa de qualquer uma dessas coisas, está com `List<T>` (ou um array), ponto final.

Este artigo tem como alvo .NET 11 e C# 14. `Span<T>` e `ReadOnlySpan<T>` estão na BCL desde o .NET Core 2.1 e na linguagem desde o C# 7.2, mas duas mudanças recentes importam aqui: o C# 13 (.NET 9) adicionou a anti-restrição `allows ref struct` e `params ReadOnlySpan<T>`, e o C# 14 (.NET 11) adicionou conversões implícitas de primeira classe entre arrays e spans. Ambas reduzem o atrito de transitar entre esses tipos. `List<T>` remonta ao .NET Framework 2.0.

## Estes não são três sabores da mesma coisa

A comparação confunde as pessoas porque os três nomes parecem pares e não são. Dois deles são coleções apenas no nome.

`List<T>` é uma classe. É um invólucro que cresce em torno de um `T[]` privado que dobra a capacidade quando enche. Ela vive no heap gerenciado, o GC a rastreia, você pode guardá-la em um campo, retorná-la, capturá-la em uma lambda e entregá-la a um método `async`. Ela possui seu armazenamento e pode crescer. Esta é a coleção do dia a dia que você pega sem pensar, e na maioria das vezes esse instinto está correto.

`Span<T>` é um `ref struct`. Ele não possui memória nenhuma. É um valor minúsculo (uma referência gerenciada mais um comprimento) que aponta para uma região contígua que outra pessoa alocou: um array, uma fatia de um array, um buffer `stackalloc` ou memória não gerenciada. Ele não pode crescer, porque não possui o armazenamento subjacente. Ele é mutável: escrever através de um `Span<T>` escreve no buffer subjacente. Por ser um `ref struct`, o runtime garante que ele só pode viver na pilha, que é exatamente o que o torna seguro para apontar para a memória da pilha, mas também o que o proíbe de ser um campo, sofrer boxing ou sobreviver a um `await`.

`ReadOnlySpan<T>` é a mesma visão `ref struct`, menos a capacidade de escrever. É o que o fatiamento de strings retorna (`"hello".AsSpan(1, 3)`), o que um literal UTF-8 produz (`"GET"u8` é um `ReadOnlySpan<byte>`) e o tipo de parâmetro que você deveria aceitar quando só lê um buffer. Tudo o que foi dito sobre as restrições de pilha-somente do `Span<T>` se aplica de forma idêntica.

Então a verdadeira pergunta raramente é "qual coleção". É "eu possuo e faço crescer um buffer (`List<T>`), ou vejo um que já tenho, de forma mutável (`Span<T>`) ou somente leitura (`ReadOnlySpan<T>`)?".

## A matriz de decisão

O comportamento abaixo é para .NET 9+ / C# 13+ salvo indicação em contrário.

| Capacidade                                   | `List<T>`              | `Span<T>`                  | `ReadOnlySpan<T>`          |
| -------------------------------------------- | ---------------------- | -------------------------- | -------------------------- |
| Tipo                                         | classe (heap)          | `ref struct` (pilha)       | `ref struct` (pilha)       |
| Possui seu armazenamento                     | sim                    | não (uma visão)            | não (uma visão)            |
| Pode crescer / `Add`                         | sim                    | não                        | não                        |
| Mutar elementos                              | sim                    | sim                        | não                        |
| Alocação ao criar                            | heap (o `T[]` subjacente) | nenhuma                 | nenhuma                    |
| Guardar em um campo de uma classe            | sim                    | não                        | não                        |
| Retornar de um método `async`                | sim                    | não                        | não                        |
| Usar através de `await` / `yield`            | sim                    | não                        | não                        |
| Capturar em uma lambda / closure             | sim                    | não                        | não                        |
| Boxing / atribuir a `object` ou interface    | sim                    | não                        | não                        |
| Usar como argumento de tipo genérico         | sim                    | só com `allows ref struct` | só com `allows ref struct` |
| Fatiar sem copiar                            | não (`GetRange` copia) | sim (`Slice`, sem cópia)   | sim (`Slice`, sem cópia)   |
| Originar de uma `string`                     | não                    | não                        | sim (`AsSpan`)             |
| Originar de `stackalloc`                     | não                    | sim                        | sim                        |
| Primeira aparição                            | .NET Framework 2.0     | .NET Core 2.1              | .NET Core 2.1              |

As linhas de "Guardar em um campo" até "Boxing" são as que decidem a maioria dos casos reais. Se qualquer uma delas for um sim para o seu cenário, os spans estão fora e você mantém um `List<T>` ou um array. Todo o resto é uma questão de desempenho e ergonomia.

## Quando escolher List<T>

`List<T>` é o padrão. Recorra a ele sempre que a coleção tiver um tempo de vida mais longo do que um método síncrono, ou quando você não souber o tamanho final de antemão.

- **Você constrói uma coleção de forma incremental.** Você está lendo linhas, anexando resultados, acumulando eventos. `Add` é O(1) amortizado e a lista se redimensiona sozinha. Um span não pode crescer, então nem é uma disputa.
- **A coleção é um campo ou um valor de retorno.** Um cache, um registro, um `List<Order>` que você devolve de um repositório. Um `ref struct` não pode ser um campo nem ser retornado através de um limite assíncrono, então qualquer coisa que sobreviva ao quadro de pilha vive em um `List<T>`.
- **Você cruza um `await`.** No momento em que um método aguarda (await), cada variável local que sobrevive ao await é elevada para uma máquina de estados alocada no heap. Um `ref struct` não pode ser elevado, então uma variável local `Span<T>` não pode sobreviver ao await. Um `List<T>` pode.

```csharp
// .NET 11, C# 14 -- List<T> is the only correct choice here:
// it grows, it is returned, and the method is async.
public async Task<List<Order>> LoadRecentAsync(DbContext db, CancellationToken ct)
{
    var results = new List<Order>();
    await foreach (var order in db.Orders.AsAsyncEnumerable().WithCancellation(ct))
    {
        if (order.Total > 100m)
            results.Add(order);   // grows on demand
    }
    return results;               // escapes the stack frame
}
```

Se você quer uma dica de que tomou a decisão certa, pergunte-se se a coleção precisa existir depois que o método retornar. Se sim, é um `List<T>` ou um array, nunca um span.

## Quando escolher Span<T>

`Span<T>` é para uma visão mutável e sem alocações sobre memória que você já controla, usada e descartada dentro de um único método síncrono. A vantagem clássica é evitar uma alocação intermediária.

- **Um pequeno buffer temporário via `stackalloc`.** Formatar um número, construir uma chave pequena, calcular o hash de alguns bytes. `stackalloc` coloca o buffer na pilha, e um `Span<T>` é o manipulador seguro para ele. Sem `T[]` no heap, sem pressão sobre o GC.
- **Fatiar um buffer no lugar.** Analisar um quadro de rede: pegar o cabeçalho, depois a carga útil, sem copiar nenhum dos dois. `Span<T>.Slice` retorna outra visão sobre a mesma memória.
- **Mutar uma região de array sem uma sopa de parâmetros de offset/comprimento.** Passar `buffer.AsSpan(start, length)` é mais limpo do que enfiar `(buffer, start, length)` por cada chamada, e os limites são verificados uma vez na fatia.

```csharp
// .NET 11, C# 14 -- a stackalloc scratch buffer, no heap allocation
public static bool TryFormatTimestamp(long unixSeconds, Span<char> destination, out int written)
{
    Span<char> scratch = stackalloc char[20];   // on the stack, not the heap
    if (!unixSeconds.TryFormat(scratch, out int n))
    {
        written = 0;
        return false;
    }
    return scratch.Slice(0, n).TryCopyTo(destination)
        ? (written = n) >= 0
        : Fail(out written);

    static bool Fail(out int w) { w = 0; return false; }
}
```

Há uma razão de desempenho real além da alocação. O JIT muitas vezes consegue eliminar as verificações de limites quando itera um `Span<T>` diretamente, porque o comprimento do span está bem ali e a forma do laço é reconhecível. Iterar um `List<T>` através de seu enumerador executa uma verificação de versão e uma verificação de limites a cada `MoveNext`. Medimos isso mais abaixo.

Uma ponte comum: se você já tem um `List<T>` e quer o desempenho de um span para uma leitura quente ou uma mutação no lugar, não o copie. Chame `CollectionsMarshal.AsSpan(list)` para obter um `Span<T>` diretamente sobre o array subjacente da lista. Essa visão só é válida até a próxima operação que redimensione a lista, então use-a e descarte-a.

## Quando escolher ReadOnlySpan<T>

`ReadOnlySpan<T>` é o tipo de parâmetro correto para qualquer método síncrono que lê um buffer e não precisa mutá-lo. Conforme as [diretrizes de uso de Memory e Span](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines) da Microsoft, a regra um é "para uma API síncrona, prefira `Span<T>` em vez de `Memory<T>`", e a regra dois é "use `ReadOnlySpan<T>` se o buffer deve ser somente leitura". A maior parte da análise e da busca é somente leitura.

- **Fatiar strings sem alocar substrings.** `"2026-05-25".AsSpan(0, 4)` te dá o ano como um `ReadOnlySpan<char>` sem uma nova `string`. `int.Parse` e similares têm sobrecargas de span, então você pode analisar direto da fatia.
- **Literais UTF-8.** `"GET"u8` é um `ReadOnlySpan<byte>` embutido no assembly. Comparar um buffer de bytes recebido contra ele é sem alocações.
- **Aceitar qualquer formato de buffer.** Um método que recebe `ReadOnlySpan<byte>` pode ser chamado com um `byte[]`, um `ArraySegment<byte>`, um buffer `stackalloc` ou uma fatia, sem sobrecargas. No C# 14 a conversão de array para span é implícita, então quem chama nem escreve `.AsSpan()`.

```csharp
// .NET 11, C# 14 -- read-only parsing with zero substring allocations
public static (int year, int month, int day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

// All three callers work; none allocate a substring.
var a = ParseIsoDate("2026-05-25");                 // string -> ReadOnlySpan<char>
var b = ParseIsoDate("2026-05-25".AsSpan());         // explicit
Span<char> buf = stackalloc char[10];
"2026-05-25".CopyTo(buf);
var c = ParseIsoDate(buf);                            // Span<char> -> ReadOnlySpan<char>
```

Note que um `Span<T>` se converte implicitamente em um `ReadOnlySpan<T>`, nunca o contrário. Pegue o tipo mais restritivo que seu método realmente precisa: se você só lê, peça `ReadOnlySpan<T>` para que todos que chamam, mutáveis ou não, possam te alcançar. Isso combina naturalmente com [SearchValues<T> para busca rápida de múltiplas agulhas](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/), que é construído inteiramente em torno de entradas `ReadOnlySpan<T>`.

## O benchmark: somar 10.000 inteiros

A afirmação de desempenho é específica: iterar um `Span<T>` ou um `ReadOnlySpan<T>` é mais rápido do que iterar um `List<T>`, porque o JIT elimina as verificações de limites por elemento no span e o enumerador da lista não. Aqui está a medição.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
// dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;
    private int[] _array = null!;

    [GlobalSetup]
    public void Setup()
    {
        _array = Enumerable.Range(0, 10_000).ToArray();
        _list = new List<int>(_array);
    }

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // List<T>.Enumerator: version + bounds check
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }

    [Benchmark]
    public long ReadOnlySpanForeach()
    {
        long sum = 0;
        ReadOnlySpan<int> span = _array;     // C# 14 implicit conversion
        foreach (int x in span) sum += x;
        return sum;
    }
}
```

Resultados representativos em um Ryzen 7 / Windows 11 / build .NET 11, x64 RyuJIT:

| Método                | Média     | Ratio | Alocado   |
| --------------------- | --------- | ----- | --------- |
| `ListForeach`         | 6,1 us    | 1,00  | 0 B       |
| `SpanForeach`         | 2,4 us    | 0,39  | 0 B       |
| `ReadOnlySpanForeach` | 2,4 us    | 0,39  | 0 B       |

Cerca de 2,5x mais rápido para o laço do span, com zero alocação nos três (a lista já existe; `CollectionsMarshal.AsSpan` não copia). O ratio exato varia com o tipo de elemento e a CPU, mas a direção é estável: o enumerador do span é um laço fino que percorre por `ref` e que o JIT otimiza com força, enquanto o `List<T>.Enumerator` carrega a verificação de versão que detecta a modificação concorrente. Essa verificação de versão é um recurso, não desperdício (é por isso que o `List<T>` lança `InvalidOperationException` se você o muta durante a iteração), mas custa ciclos que o span nunca paga.

A ressalva honesta: para uma soma de 10.000 elementos isto são microssegundos. Se o seu laço não é quente, não contorça o seu código para economizar 4 microssegundos. Os spans ganham o seu lugar em laços internos quentes, analisadores e serializadores que executam milhões de vezes, não no percurso ocasional de uma lista.

## As armadilhas que decidem por você

Três restrições se sobrepõem ao gosto por completo, e as três vêm do fato de `Span<T>` e `ReadOnlySpan<T>` serem tipos `ref struct`.

**Um `await` no escopo elimina os spans.** Uma variável local `ref struct` não pode sobreviver a um `await`, porque o compilador teria que elevá-la para uma máquina de estados alocada no heap, o que um tipo apenas-pilha proíbe. O compilador o rejeita de cara. Se o seu método aguarda (await) e precisa de um buffer que abrange o await, use `Memory<T>` / `ReadOnlyMemory<T>` (os primos amigáveis ao heap) ou um `List<T>` / array. Veja [como converter T[] para ReadOnlyMemory<T>](/pt-br/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) para os tipos de visão seguros através do await.

**Um campo, um retorno através de async ou uma closure elimina os spans.** Você não pode escrever `class C { Span<int> _buf; }`. Você não pode capturar um span em uma lambda. Você não pode retornar um de um `async Task<Span<int>>`. No momento em que o seu design precisa que o buffer escape do quadro de pilha atual, a resposta é `List<T>` ou `T[]`, possivelmente com um manipulador `Memory<T>` para async.

**Um contexto genérico anterior ao C# 13 limita os spans.** Antes do C# 13 você não podia usar `Span<T>` como argumento de tipo genérico de jeito nenhum. Com a anti-restrição `allows ref struct` do C# 13 você pode, mas apenas se o método ou tipo genérico optar por ela com `where T : allows ref struct`. Uma API genérica que não optou por ela ainda não pode receber um span. `List<T>` não tem tal restrição; é uma classe comum.

Há também uma armadilha sutil de tempo de vida com `CollectionsMarshal.AsSpan`. O span que ele retorna aponta para o array subjacente atual da lista. Se você então fizer `Add` o suficiente para disparar um redimensionamento, a lista aloca um novo array e o seu span agora aponta para o antigo, já órfão. Trate esse span como válido apenas até a próxima chamada que mute a lista.

## A recomendação, reformulada

Por padrão, `List<T>`. É a coleção que você faz crescer, armazena, retorna, atravessa com await e captura, e no .NET 11 é mais que rápida o bastante para tudo que não seja um caminho quente medido. Desça para `Span<T>` quando quiser uma visão mutável e sem alocações sobre um buffer que você já possui e que vai usar e descartar dentro de um único método síncrono, especialmente com `stackalloc` ou fatiamento no lugar. Use `ReadOnlySpan<T>` como tipo de parâmetro para qualquer leitor síncrono, e como o retorno do fatiamento de strings e dos literais `u8`, para que você analise e busque sem alocar substrings. Quando um span seria ideal mas há um `await`, um campo ou uma closure no caminho, recorra a `Memory<T>` / `ReadOnlyMemory<T>` ou fique com `List<T>`. A versão correta mais curta: possuir e crescer significa `List<T>`; ver e mutar significa `Span<T>`; ver e ler significa `ReadOnlySpan<T>`.

## Relacionado

- [Conversões implícitas de Span em C# 14: suporte de primeira classe para Span e ReadOnlySpan](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cobre as conversões que permitem aos chamadores omitir `.AsSpan()`.
- [Como converter T[] para ReadOnlyMemory<T> em C#](/pt-br/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) é a contraparte segura através do await quando um span não pode cruzar um `await`.
- [Como usar SearchValues<T> corretamente no .NET 11](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) se apoia em `ReadOnlySpan<T>` para uma busca rápida de múltiplos caracteres.
- [Como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) se apoia no fatiamento de spans para analisar sem copiar.
- [C# 13: o fim das alocações de params](/pt-br/2026/01/c-13-the-end-of-params-allocations/) explica `params ReadOnlySpan<T>`, os `params` sem alocações que os spans tornam possíveis.

## Fontes

- [Diretrizes de uso de Memory<T> e Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Referência da struct System.Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Referência da struct System.ReadOnlySpan<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.readonlyspan-1)
- [Anti-restrição allows ref struct (MS Learn, proposta do C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [Referência de CollectionsMarshal.AsSpan (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
- [Referência da classe List<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.collections.generic.list-1)
