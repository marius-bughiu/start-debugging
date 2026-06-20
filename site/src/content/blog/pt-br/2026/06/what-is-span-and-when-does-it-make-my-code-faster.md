---
title: "O que é Span<T> em C# e quando ele realmente deixa seu código mais rápido?"
description: "Span<T> é um ref struct que vive apenas na pilha e aponta para memória que você já possui, então não tem alocação de respaldo. Ele acelera o código em exatamente três situações: substituir um buffer no heap por stackalloc, fatiar sem copiar e laços apertados onde o JIT elimina as verificações de limites. Em qualquer outro lugar ele não muda nada, e cruzando um await ele não compila."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "pt-br"
translationOf: "2026/06/what-is-span-and-when-does-it-make-my-code-faster"
translatedBy: "claude"
translationDate: 2026-06-20
---

`Span<T>` é um `ref struct` que vive apenas na pilha e representa uma região contígua de memória que você já possui: um array, uma fatia de um, um buffer de `stackalloc`, um pedaço de uma string ou memória não gerenciada. É uma referência gerenciada mais um comprimento, nada mais. Ele não aloca, não copia e não pode crescer. Esse é o tipo inteiro. A razão pela qual as pessoas recorrem a ele é desempenho, mas ele só deixa o código mais rápido em três situações concretas: quando permite substituir uma alocação no heap por `stackalloc`, quando permite fatiar um buffer sem copiar, e quando transforma um laço em um formato do qual o JIT pode remover as verificações de limites. Fora desses casos, um span é uma ferramenta de clareza, não de desempenho, e forçá-lo em código que não faz nenhuma das três coisas não traz nada. Este artigo tem como alvo .NET 11 e C# 14, embora o próprio `Span<T>` esteja na BCL desde o .NET Core 2.1 e na linguagem desde o C# 7.2.

A armadilha é que "use `Span<T>`, é mais rápido" é repetido sem a segunda metade da frase. Então deixe-me dar a segunda metade: o que o tipo realmente é, os mecanismos exatos pelos quais ele economiza ciclos, e a lista igualmente importante de casos em que colocar um span muda o código gerado em aproximadamente zero.

## Uma visão sobre a memória, não um contêiner

O modelo mental que resolve a maior parte da confusão: `Span<T>` não é uma coleção. É uma janela. Uma `List<T>` ou um `T[]` possuem seu armazenamento, vivem no heap, e o coletor de lixo os rastreia. Um `Span<T>` não possui nada. Ele mantém uma referência para o início de alguma memória e uma contagem de quantos elementos são válidos. Crie um e nenhuma alocação acontece, porque não há nada a alocar: os bytes já existem em algum lugar, e o span apenas nomeia um trecho deles.

```csharp
// .NET 11, C# 14
int[] numbers = { 10, 20, 30, 40, 50 };

Span<int> all = numbers;          // a view over the whole array, no copy
Span<int> middle = all.Slice(1, 3); // {20, 30, 40}, still the same backing memory

middle[0] = 99;                   // writes THROUGH to numbers[1]
Console.WriteLine(numbers[1]);    // 99
```

`middle` não copiou três inteiros. É uma referência para `numbers[1]` mais o comprimento `3`. Escrever através dele escreve no array original, porque só há um array. Esse aliasing é exatamente o objetivo: um span é um manipulador barato, tipado e com verificação de limites para memória que vive em outro lugar.

Como o runtime garante que um `ref struct` só pode viver na pilha, um span é seguro para apontar para memória da pilha (um buffer de `stackalloc`) sem os riscos de tempo de vida que uma referência do heap para a pilha criaria. Essa mesma garantia é a origem de todas as restrições que o tipo tem, ao que chegaremos. Primeiro, a parte pela qual você veio.

## De onde a velocidade realmente vem

Um span deixa o código mais rápido por meio de três mecanismos distintos. Eles são independentes: um dado pedaço de código pode atingir um, dois ou nenhum. Se não atingir nenhum, o span não está fazendo nada pelo seu tempo de execução.

### Mecanismo 1: ele permite não alocar de jeito nenhum

Esse é o grande, e na verdade não é o span que faz o trabalho. O span é o manipulador seguro que torna o `stackalloc` utilizável. Um pequeno buffer temporário (formatar um número, montar uma chave de busca, calcular o hash de alguns bytes) tradicionalmente significava um `new byte[n]` ou `new char[n]` no heap, que depois o GC tem que coletar. Com `stackalloc`, o buffer vive no quadro da pilha e desaparece de graça quando o método retorna. O `Span<T>` é como você lê e escreve essa memória da pilha com segurança.

```csharp
// .NET 11, C# 14 -- format an int to text with zero heap allocation
public static string ToHex(int value)
{
    Span<char> buffer = stackalloc char[8];   // on the stack, not the heap
    value.TryFormat(buffer, out int written, "X");
    return new string(buffer[..written]);     // the only allocation is the final string
}
```

O ganho é medido em pressão sobre o GC, não em velocidade bruta de laço. Aloque um milhão de buffers minúsculos e descartáveis por segundo e você gera um milhão de objetos que o coletor de gen-0 tem que percorrer. Mova-os para `stackalloc` e essa pressão vai a zero. Em um caminho quente, remover alocações costuma ser um ganho de ponta a ponta maior do que cortar instruções de um laço, porque as pausas do GC afetam o processo inteiro, não só o seu método. Esse é o mesmo instinto por trás de [params ReadOnlySpan<T> eliminando as alocações de params](/pt-br/2026/01/c-13-the-end-of-params-allocations/): a alocação mais rápida é a que nunca acontece.

### Mecanismo 2: ele permite fatiar sem copiar

O segundo mecanismo é `Slice`. Em uma `string`, pegar uma substring com `Substring` aloca uma `string` totalmente nova e copia os caracteres. Em um array, `GetRange` ou o `Skip`/`Take` do LINQ materializando em uma nova coleção também copiam. O `Slice` de um span não faz nenhuma das duas coisas: ele retorna outro span apontando para a mesma memória, com o deslocamento e o comprimento ajustados. Zero cópia, zero alocação.

```csharp
// .NET 11, C# 14 -- parse "2026-06-20" with no substring allocations
public static (int Year, int Month, int Day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));  // no new string
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

var parsed = ParseIsoDate("2026-06-20");      // string converts to ReadOnlySpan<char> implicitly
```

Cada `int.Parse` aqui lê direto de uma fatia da string original. A versão antiga com `date.Substring(0, 4)` alocaria três strings de vida curta por chamada. Em um parser que percorre milhões de linhas, isso são milhões de alocações evitadas. As sobrecargas de span de `int.Parse`, `DateTime.Parse`, `Guid.Parse` e companhia existem precisamente para que você possa analisar a partir de fatias sem nunca materializar uma substring. Essa é a espinha dorsal da análise rápida de CSV e logs, razão pela qual [ler um CSV grande sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) se apoia no fatiamento com spans para percorrer cada linha no lugar.

### Mecanismo 3: o JIT elimina as verificações de limites em laços apertados

O terceiro mecanismo é o mais sutil e o que as pessoas mais frequentemente invocam sem entender. Quando você itera um span com um laço `for` limitado por `span.Length`, o JIT pode provar que cada índice está dentro do intervalo e remover por completo a verificação de limites por elemento. Ele reconhece o padrão `for (int i = 0; i < span.Length; i++)` e sabe que `span[i]` não pode estar fora do intervalo, então descarta a comparação e o desvio que de outra forma protegeriam cada acesso. A equipe do JIT da Microsoft passou anos ensinando o RyuJIT a reconhecer as verificações de limites de um span do mesmo modo que reconhece as de um array, e o .NET 10 fez a análise de asserções subjacente depender menos da ordem para que mais formatos de laço se qualifiquem, como documenta o artigo [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/).

Compare isso com iterar uma `List<T>` através do seu enumerador. `List<T>.Enumerator.MoveNext` executa uma verificação de versão a cada passo (o mecanismo que lança `InvalidOperationException` se você mutar a lista no meio da iteração) mais uma verificação de limites. Essa verificação de versão é um recurso de correção, não desperdício, mas custa ciclos que um span nunca paga.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x -- dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;

    [GlobalSetup]
    public void Setup() => _list = new List<int>(Enumerable.Range(0, 10_000));

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // version + bounds check per step
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // a view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }
}
```

Resultados representativos em um build de Ryzen 7 / Windows 11 / .NET 11, x64 RyuJIT:

| Method        | Mean   | Ratio | Allocated |
| ------------- | ------ | ----- | --------- |
| `ListForeach` | 6.1 us | 1.00  | 0 B       |
| `SpanForeach` | 2.4 us | 0.39  | 0 B       |

Cerca de 2,5 vezes mais rápido, sem alocação em nenhum dos dois (a lista já existe; `CollectionsMarshal.AsSpan` entrega um span sobre o array de respaldo dela sem copiar). A proporção exata muda com o tipo de elemento e a CPU, mas a direção é estável. Repare na unidade, porém: são microssegundos sobre 10.000 elementos. Esse número é a razão completa da próxima seção.

## Quando Span<T> não faz nada por você

Aqui está a parte que a versão cargo cult desse conselho omite. Um span só ajuda quando um desses três mecanismos está em jogo. Coloque-o em código que não ativa nenhum e você escreveu código mais restrito para um tempo de execução idêntico. Pior ainda, você pode tê-lo deixado mais lento ou feito parar de compilar.

**Você converte para um span e imediatamente copia para fora.** Se a sua "otimização" é `array.AsSpan().ToArray()` ou fatiar um span só para fazer `.ToArray()` do resultado, você alocou de qualquer forma. A cópia é o custo; o span na frente dela não trouxe nada. O ganho do mecanismo 2 existe apenas enquanto você continuar lendo através da visão.

**O laço não é quente.** O mecanismo 3 economizou 3,7 microssegundos sobre 10.000 elementos. Se esse laço roda uma vez por requisição web, ou algumas centenas de vezes no total, você nunca vai medir a diferença diante da latência de rede e banco de dados que a empequenecem em cinco ordens de magnitude. Torcer código legível para cortar microssegundos de um caminho frio é uma perda líquida: você paga em clareza e restrições por uma aceleração que ninguém consegue observar. Os spans ganham seu lugar em parsers, serializadores e laços internos que rodam milhões de vezes, não na travessia ocasional de uma coleção.

**Você já tinha um array e só o lê sequencialmente.** Um `foreach` simples sobre um `T[]` já obtém a eliminação de verificações de limites do JIT; os arrays são o caso original para o qual essa otimização foi construída. Envolver o array em um span primeiro não deixa o laço mais rápido, porque o laço do array já era rápido. O span ajuda quando a fonte é uma `List<T>` (cujo enumerador carrega a verificação de versão) ou quando você precisa fatiar, não quando você já tem um array e o percorre do início ao fim.

**Você força um `stackalloc` que é grande demais.** O mecanismo 1 só ganha com buffers pequenos. Um `stackalloc` de tamanho grande ou controlado pelo chamador arrisca um estouro de pilha, que é uma falha, não um caminho lento. A orientação usual é limitar `stackalloc` a uma constante pequena (comumente de algumas centenas de bytes a ~1 KB) e recorrer a um array agrupado ou do heap acima disso. Um span sobre um `stackalloc` grande demais não é mais rápido, é uma `StackOverflowException` latente.

O teste honesto antes de recorrer a um span: qual dos três mecanismos estou comprando? Se você não consegue nomear um, está recorrendo ao tipo por hábito. O [guia de decisão List vs Span vs ReadOnlySpan](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) percorre o eixo completo de posse e tempo de vida se você está escolhendo entre eles para um campo ou valor de retorno específico.

## As restrições, e por que elas existem

Toda restrição sobre `Span<T>` decorre de um fato: ele é um `ref struct`, então o runtime o obriga a viver apenas na pilha. É isso que o torna seguro para apontar para memória de `stackalloc`, e é inegociável.

**Ele não pode cruzar um `await` nem um `yield`.** Quando um método aguarda com await, o compilador iça cada variável local que sobrevive ao await para uma máquina de estados alocada no heap. Um tipo que vive apenas na pilha não pode ser içado, então o compilador rejeita uma variável local `Span<T>` que abranja um `await`. Essa é a restrição com a qual as pessoas esbarram primeiro. Se você precisa de um buffer que cruze uma fronteira assíncrona, use `Memory<T>` ou `ReadOnlyMemory<T>`, os primos amigáveis ao heap; [converter um array para ReadOnlyMemory<T>](/pt-br/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) cobre os tipos de visão seguros diante de await.

**Ele não pode ser um campo de uma classe, sofrer boxing nem ser capturado em uma lambda.** Você não pode escrever `class C { Span<int> _buf; }`, não pode atribuir um span a `object` nem fechar sobre um em uma clausura. Cada uma dessas coisas deixaria o span escapar do seu quadro de pilha, o que o tipo proíbe. No momento em que o seu design precisa que a visão sobreviva ao método atual, a resposta é uma `List<T>`, um `T[]` ou um manipulador `Memory<T>`.

**O uso genérico precisa de `allows ref struct`.** Antes do C# 13 você não podia usar `Span<T>` como argumento de tipo genérico de jeito nenhum. A antirrestrição `allows ref struct` do C# 13 removeu isso, mas só para métodos e tipos genéricos que optam explicitamente com `where T : allows ref struct`. Uma API genérica mais antiga que não optou por isso ainda não pode receber um span.

**Uma visão de `CollectionsMarshal.AsSpan` é válida apenas até a lista mudar de tamanho.** Esse span aponta para o array de respaldo atual da lista. Faça `Add` o suficiente para disparar um redimensionamento e a lista aloca um novo array, deixando o seu span apontando para o antigo, agora órfão. Use esse span imediatamente e descarte-o; nunca o mantenha através de uma chamada que mute a lista.

Mais uma conveniência chegou no C# 14: arrays agora se convertem em spans de forma implícita, então você escreve `ReadOnlySpan<char> s = "GET"u8` e passa `myArray` onde um span é esperado sem um `.AsSpan()` visível. O artigo [conversões implícitas de Span no C# 14](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cobre exatamente quais conversões o compilador agora faz por você.

## A versão curta

`Span<T>` é uma visão sem alocação e apenas na pilha sobre memória que você já possui. Ele deixa o código mais rápido de três formas específicas: permite substituir buffers do heap por `stackalloc`, permite fatiar strings e arrays sem copiar, e dá ao JIT um formato de laço do qual ele pode remover verificações de limites. Esses ganhos são reais e grandes em parsers, serializadores e laços internos quentes que rodam milhões de vezes. Eles são invisíveis em caminhos frios, e evaporam por completo se você copiar para fora do span, se a sua fonte já é um array que você percorre sequencialmente, ou se não há nenhum laço quente medido. E como ele é um `ref struct`, ele para no primeiro `await`, campo ou clausura do seu design. Recorra a ele quando puder nomear qual dos três mecanismos está comprando. Se não puder, você está adicionando restrições por uma aceleração que não está lá.

## Relacionados

- [List<T> vs Span<T> vs ReadOnlySpan<T> em C#: quando usar cada um](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) é o guia de decisão quando você está escolhendo entre os três para um campo ou retorno específico.
- [Como converter T[] para ReadOnlyMemory<T> em C#](/pt-br/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) é o caminho seguro diante de await quando um span não pode cruzar um `await`.
- [Como usar SearchValues<T> corretamente no .NET 11](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) se baseia em `ReadOnlySpan<T>` para busca multi-agulha acelerada por SIMD.
- [Como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) analisa cada linha no lugar com fatiamento de spans.
- [Conversões implícitas de Span no C# 14](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cobre as conversões que permitem aos chamadores omitir `.AsSpan()`.

## Fontes

- [Referência do struct System.Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Diretrizes de uso de Memory<T> e Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Performance Improvements in .NET 10 (.NET Blog)](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/)
- [Antirrestrição allows ref struct (MS Learn, C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [Referência de CollectionsMarshal.AsSpan (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
