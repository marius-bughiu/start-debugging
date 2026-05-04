---
title: "Como converter T[] para ReadOnlyMemory<T> em C# (operador implícito e construtor explícito)"
description: "Três formas de envolver um T[] em um ReadOnlyMemory<T> no .NET 11: a conversão implícita, o construtor explícito e AsMemory(). Quando cada uma é a escolha certa."
pubDate: 2026-05-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
template: "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-convert-array-to-readonlymemory-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-04
---

Se você só quer uma visão `ReadOnlyMemory<T>` sobre um array existente, o caminho mais curto é a conversão implícita: `ReadOnlyMemory<byte> rom = bytes;`. Se você precisa de uma fatia, prefira `bytes.AsMemory(start, length)` ou `new ReadOnlyMemory<byte>(bytes, start, length)`. Os três são livres de alocação, mas apenas o construtor e `AsMemory` aceitam offset e comprimento, e apenas o construtor é explícito no ponto de chamada (o que importa em revisão de código).

Versões referenciadas neste post: .NET 11 (runtime), C# 14. `System.Memory` faz parte de `System.Runtime` no .NET moderno, então nenhum pacote extra é necessário.

## Por que existe mais de um caminho de conversão

`ReadOnlyMemory<T>` está na BCL desde o .NET Core 2.1 (e no pacote NuGet `System.Memory` no .NET Standard 2.0). A Microsoft adicionou vários pontos de entrada de propósito: um sem fricção para o caso dos 90%, um construtor explícito para código que precisa destacar a conversão, e um método de extensão que espelha `AsSpan()` para você alternar mentalmente entre span e memory sem trocar de contexto.

Concretamente, a BCL expõe:

1. Uma conversão implícita de `T[]` para `Memory<T>` e de `T[]` para `ReadOnlyMemory<T>`.
2. Uma conversão implícita de `Memory<T>` para `ReadOnlyMemory<T>`.
3. O construtor `new ReadOnlyMemory<T>(T[])` e a sobrecarga de fatiamento `new ReadOnlyMemory<T>(T[] array, int start, int length)`.
4. Os métodos de extensão `AsMemory<T>(this T[])`, `AsMemory<T>(this T[], int start)`, `AsMemory<T>(this T[], int start, int length)` e `AsMemory<T>(this T[], Range)` definidos em `MemoryExtensions`.

Todo caminho é livre de alocação. A escolha é principalmente estilística, com duas distinções reais: apenas o construtor e `AsMemory` aceitam uma fatia, e apenas a conversão implícita permite que um argumento `T[]` flua para um parâmetro `ReadOnlyMemory<T>` sem que o chamador escreva nada.

## O exemplo mínimo

```csharp
// .NET 11, C# 14
using System;

byte[] payload = "hello"u8.ToArray();

// Path 1: implicit operator
ReadOnlyMemory<byte> a = payload;

// Path 2: explicit constructor, full array
ReadOnlyMemory<byte> b = new ReadOnlyMemory<byte>(payload);

// Path 3: explicit constructor, slice
ReadOnlyMemory<byte> c = new ReadOnlyMemory<byte>(payload, start: 1, length: 3);

// Path 4: AsMemory extension, full array
ReadOnlyMemory<byte> d = payload.AsMemory();

// Path 5: AsMemory extension, slice with start + length
ReadOnlyMemory<byte> e = payload.AsMemory(start: 1, length: 3);

// Path 6: AsMemory extension, range
ReadOnlyMemory<byte> f = payload.AsMemory(1..4);
```

Os seis produzem instâncias `ReadOnlyMemory<byte>` que apontam para o mesmo array de apoio. Nenhum deles copia o array. Todos os seis são seguros em loops apertados porque o custo é uma pequena cópia de struct, não uma cópia de buffer.

## Quando o operador implícito é a escolha certa

A conversão implícita de `T[]` para `ReadOnlyMemory<T>` é a mais limpa em pontos de chamada onde o tipo de destino já é um parâmetro `ReadOnlyMemory<T>`:

```csharp
// .NET 11
public Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
{
    // ...
    return Task.CompletedTask;
}

byte[] payload = GetPayload();
await WriteAsync(payload); // implicit conversion happens here
```

Você não escreve `payload.AsMemory()` nem `new ReadOnlyMemory<byte>(payload)`. O compilador emite a conversão para você. Isso importa de duas formas: o ponto de chamada permanece legível em código quente, e sua API pode receber `ReadOnlyMemory<T>` sem forçar todo chamador a aprender um tipo novo.

A contrapartida é que a conversão é invisível. Se você quer que um revisor de código note "este código agora está passando uma visão `ReadOnlyMemory<T>` em vez de um array", o operador implícito esconde isso.

## Quando o construtor vale a verbosidade

`new ReadOnlyMemory<byte>(payload, start, length)` é a forma explícita. Você recorre a ele em três situações:

1. **Você precisa de uma fatia com offset e comprimento.** A conversão implícita sempre cobre o array inteiro.
2. **Você quer que o ponto de chamada torne a conversão visível.** Um campo como `private ReadOnlyMemory<byte> _buffer;` inicializado pelo construtor é mais fácil de localizar com grep do que um operador implícito.
3. **Você quer que o compilador verifique os limites do offset e comprimento uma vez, na construção.** Todos os caminhos verificam os limites em algum momento, mas o construtor aceita `start` e `length` como parâmetros e lança `ArgumentOutOfRangeException` imediatamente se eles caírem fora do array, antes que qualquer consumidor toque na memória.

```csharp
// .NET 11
byte[] frame = ReceiveFrame();
const int headerLength = 16;

// Skip the header. Bounds-checked here, not when the consumer reads.
var payload = new ReadOnlyMemory<byte>(frame, headerLength, frame.Length - headerLength);

await ProcessAsync(payload);
```

Se `frame.Length < headerLength`, a `ArgumentOutOfRangeException` é lançada no local da construção, onde as variáveis locais ainda estão em escopo e um depurador pode mostrar qual era de fato o `frame.Length`. Se você adia o fatiamento para dentro de `ProcessAsync`, perde essa localidade e a falha aparece onde quer que a fatia seja finalmente materializada.

## Quando usar `AsMemory()` em vez disso

`AsMemory()` é a mesma coisa que o construtor, com duas vantagens ergonômicas: lê-se da esquerda para a direita (`payload.AsMemory(1, 3)` em vez de `new ReadOnlyMemory<byte>(payload, 1, 3)`), e tem uma sobrecarga `Range`, então a sintaxe de fatiamento do C# funciona:

```csharp
// .NET 11, C# 14
byte[] payload = GetPayload();
const int headerLength = 16;

ReadOnlyMemory<byte> body = payload.AsMemory(headerLength..);
ReadOnlyMemory<byte> first16 = payload.AsMemory(..headerLength);
ReadOnlyMemory<byte> middle = payload.AsMemory(8..24);
```

`AsMemory(Range)` retorna `Memory<T>`, e o cast para `ReadOnlyMemory<T>` aqui passa pela conversão implícita de `Memory<T>` para `ReadOnlyMemory<T>`. Isso também é livre de alocação.

Se você já adotou mentalmente `AsSpan()` (o mesmo padrão para `Span<T>`), `AsMemory()` é a versão desse hábito que sobrevive através de um `await`.

## O que acontece com arrays `null`

Passar um array `null` para a conversão implícita ou para `AsMemory()` não lança exceção. Isso produz um `ReadOnlyMemory<T>` padrão, que é equivalente semanticamente a `ReadOnlyMemory<T>.Empty` (`IsEmpty == true`, `Length == 0`):

```csharp
// .NET 11
byte[]? maybeNull = null;

ReadOnlyMemory<byte> a = maybeNull;            // default, not a NullReferenceException
ReadOnlyMemory<byte> b = maybeNull.AsMemory(); // also default
// new ReadOnlyMemory<byte>(maybeNull) also returns default
```

O construtor de um único argumento `new ReadOnlyMemory<T>(T[]? array)` documenta isso explicitamente: uma referência nula produz um `ReadOnlyMemory<T>` com valor padrão. O construtor de três argumentos `new ReadOnlyMemory<T>(T[]? array, int start, int length)` lança `ArgumentNullException` se o array for nulo e você especificar um start ou length diferente de zero, porque os limites não podem ser satisfeitos contra `null`.

Essa tolerância a `null` é conveniente para payloads opcionais, mas também é uma armadilha: um chamador que passa `null` vai silenciosamente obter um buffer vazio em vez de uma quebra, o que pode mascarar um bug a montante. Se seu método depende do array ser não nulo, valide antes de envolvê-lo.

## Fatiar o resultado também é grátis

Uma vez que você tem um `ReadOnlyMemory<T>`, chamar `.Slice(start, length)` produz outro `ReadOnlyMemory<T>` sobre o mesmo armazenamento de apoio. Não há segunda cópia nem segunda alocação:

```csharp
// .NET 11
ReadOnlyMemory<byte> all = payload.AsMemory();

ReadOnlyMemory<byte> head = all.Slice(0, 16);
ReadOnlyMemory<byte> body = all.Slice(16);
```

A struct `ReadOnlyMemory<T>` armazena uma referência ao `T[]` original (ou a um `MemoryManager<T>`), um offset dentro desse armazenamento e um comprimento. Fatiar apenas retorna uma nova struct com offset e comprimento ajustados. É por isso que todos os seis caminhos de conversão acima são seguros para usar mesmo em loops apertados: o custo é uma cópia de struct, não uma cópia de buffer.

## Voltando de `ReadOnlyMemory<T>` para um `Span<T>`

Dentro de um método síncrono, geralmente você quer um span, não um memory:

```csharp
// .NET 11
public int CountZeroBytes(ReadOnlyMemory<byte> data)
{
    ReadOnlySpan<byte> span = data.Span; // allocation-free
    int count = 0;
    foreach (byte b in span)
    {
        if (b == 0) count++;
    }
    return count;
}
```

`.Span` é uma propriedade em `ReadOnlyMemory<T>` que retorna um `ReadOnlySpan<T>` sobre a mesma memória. Use o span para o loop interno, mantenha o memory em campos e através de fronteiras de `await`. O inverso (span para memory) intencionalmente não é fornecido, porque spans podem viver na pilha, onde um `Memory<T>` não pode alcançar.

## O que você não pode fazer (e as alternativas)

`ReadOnlyMemory<T>` é genuinamente somente leitura no que diz respeito à API pública. Não há um `ToMemory()` público que retorne o `Memory<T>` mutável subjacente. A saída de emergência fica em `MemoryMarshal`:

```csharp
// .NET 11
using System.Runtime.InteropServices;

ReadOnlyMemory<byte> ro = payload.AsMemory();
Memory<byte> rw = MemoryMarshal.AsMemory(ro);
```

Isso é inseguro no sentido de "o sistema de tipos estava te dizendo algo". Só recorra a isso quando você tem certeza de que nenhum outro consumidor depende do contrato de somente leitura que você acabou de quebrar, por exemplo em um teste unitário ou em código que possui o buffer de ponta a ponta.

`ReadOnlyMemory<T>` também não pode apontar para uma `string` através dos caminhos de conversão de array. `string.AsMemory()` retorna um `ReadOnlyMemory<char>` que envolve a própria string, não um `T[]`. Os caminhos de conversão a partir de `T[]` cobertos acima não se aplicam a strings, mas o restante da superfície da API (fatiamento, `Span`, igualdade) se comporta de forma idêntica.

## Escolhendo um na sua base de código

Um padrão razoável em uma base de código .NET 11:

- **Em assinaturas de API**: receba `ReadOnlyMemory<T>`. Chamadores com um `T[]` vão passá-lo como está (operador implícito), chamadores com uma fatia vão passar `array.AsMemory(start, length)`. Você não abre mão de nada.
- **Em pontos de chamada com um array completo**: use a conversão implícita, não escreva `.AsMemory()`. É ruído.
- **Em pontos de chamada com uma fatia**: use `array.AsMemory(start, length)` ou `array.AsMemory(range)`. Evite `new ReadOnlyMemory<T>(array, start, length)` a menos que a explicitude no ponto de chamada seja exatamente o ponto.
- **Em caminhos quentes**: não importa para desempenho. O JIT reduz todos os seis caminhos à mesma construção de struct. Escolha o que ler melhor.

## Relacionados

- [Como usar `SearchValues<T>` corretamente no .NET 11](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) para busca compatível com span que combina naturalmente com `ReadOnlyMemory<T>.Span`.
- [Como usar Channels em vez de `BlockingCollection` em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) quando você quer pipelines assíncronos que passem payloads `ReadOnlyMemory<T>`.
- [Como usar `IAsyncEnumerable<T>` com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) para padrões de streaming que combinam bem com visões de memory.
- [Como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) que se apoia fortemente em fatiamento sem cópia.
- [Como usar o novo tipo `System.Threading.Lock` no .NET 11](/pt-br/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) para a primitiva de sincronização que você vai querer ao redor de `Memory<T>` mutável compartilhado entre threads.

## Fontes

- [`ReadOnlyMemory<T>` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1)
- [`MemoryExtensions.AsMemory` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.memoryextensions.asmemory)
- [Memory<T> and Span<T> usage guidelines (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-span/)
- [`MemoryMarshal.AsMemory` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.asmemory)
