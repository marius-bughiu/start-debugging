---
title: "Loop com ref T vs indexação de Span<T> em C#: por que a versão com span é tão rápida quanto ou mais rápida no .NET 10"
description: "No .NET 10, um for simples sobre span[i] limitado por span.Length compila para um loop sem verificação de limites, com redução de força e contagem regressiva. Um loop escrito à mão com Unsafe.Add(ref r, i) e índice int mantém uma extensão de sinal e uma comparação de contagem progressiva, e foi medido 2-5% mais lento. Benchmarks e disassembly do JIT para arm64 e x64 no .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "span"
  - "jit"
lang: "pt-br"
translationOf: "2026/10/ref-t-loop-vs-span-t-indexing-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-30
---

No .NET 10, escreva o loop como `for (int i = 0; i < span.Length; i++) sum += span[i];` e pare por aí. O JIT prova que todo índice está dentro do intervalo, remove a verificação de limites, reescreve o índice como um deslocamento em bytes que ele incrementa de 4 em 4 a cada volta (redução de força) e transforma o loop em um contador regressivo que termina em um único `dec`/`jne` (ou `sub`/`cbnz` no Arm64). A versão "mais rápida" escrita à mão, `sum += Unsafe.Add(ref r, i)` com índice `int`, não recebe esse tratamento. Ela mantém o contador `int`, estende o sinal para um deslocamento do tamanho nativo a cada iteração e compara com o tamanho no fim do loop. Nas minhas medições no .NET 10.0.10, isso deixou o loop com `Unsafe.Add` **2,4% mais lento com 4.096 elementos e 3,6% mais lento com 1.000.000 de elementos** do que o loop seguro com span. Trocar o contador do loop com `ref` para `nint` fecha a diferença por completo, e uma caminhada com `ref` que avança o ponteiro empata com o loop com span. Ou seja, o código com `ref T` só consegue empatar com o loop com span no .NET 10. Ele nunca ganha, e abre mão da segurança de memória para chegar lá.

Tudo abaixo foi medido com BenchmarkDotNet 0.15.8 no .NET 10.0.10 (SDK 10.0.302), C# 14, em um Apple M4 com macOS 27.0.1. As listagens Arm64 são o código Tier1 real dessa execução, capturado com `DOTNET_JitDisasm`. As listagens x64 vêm do crossgen2 10.0.10 com alvo `win-x64`, que executa o mesmo RyuJIT com todas as otimizações, mas sem Dynamic PGO. As otimizações de loop que explicam o resultado foram lançadas no [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations), então tudo aqui vale também para o .NET 9.

## A comparação num relance

| Formato do loop | Verificação de limites no loop | Cálculo de índice por iteração | 4.096 ints | 1.000.000 ints |
| --- | --- | --- | ---: | ---: |
| `for` sobre `array[i]` | Removida | Deslocamento com redução de força, contagem regressiva | 1.035,6 ns | 251,9 us |
| `for` sobre `span[i]`, limite `span.Length` | Removida | Deslocamento com redução de força, contagem regressiva | 1.035,9 ns | 254,4 us |
| `foreach (ref readonly int x in span)` | Removida | Igual ao anterior | 1.035,6 ns | 254,5 us |
| `for` sobre `span[i]`, limite é um parâmetro `n` | Içada para fora por clonagem de loop | Igual ao anterior no clone rápido | 1.035,4 ns | 254,5 us |
| `Unsafe.Add(ref r, i)`, `int i` | Nenhuma (nunca teve) | Extensão de sinal + comparação de contagem progressiva | 1.060,1 ns | 263,7 us |
| `Unsafe.Add(ref r, i)`, `nint i` | Nenhuma | Redução de força, contagem regressiva | 1.036,1 ns | 254,7 us |
| Caminhada com `ref` e `Unsafe.IsAddressLessThan` | Nenhuma | Ponteiro com pós-incremento | 1.035,3 ns | 251,4 us |
| `Enumerable.Sum(int[])` | n/a | Vetorizado | 506,9 ns | 128,6 us |

Cada loop soma um `int[]`. As barras de erro ficam todas abaixo de 1,5 ns com 4.096 elementos e abaixo de 0,8 us com um milhão. Executei novamente as linhas de span e `ref` em uma segunda sessão separada do BenchmarkDotNet, e todas as médias ficaram a até 0,6 ns (4.096) e 0,1 us (um milhão) da primeira execução. A última linha está ali para manter o resultado em proporção: o loop escalar mais rápido ainda tem metade da velocidade de um vetorizado.

## Os dois loops que as pessoas realmente comparam

A pergunta costuma aparecer depois que alguém lê o código-fonte da BCL, vê `ref T` e `Unsafe.Add` por toda parte e reescreve um loop crítico para imitar. Aqui estão os dois formatos lado a lado:

```csharp
// .NET 10.0.10, C# 14
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

static int SpanFor(ReadOnlySpan<int> s)
{
    int sum = 0;
    for (int i = 0; i < s.Length; i++) sum += s[i];
    return sum;
}

static int RefAdd(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (int i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

A intuição por trás de `RefAdd` é que `s[i]` tem verificação de limites e `Unsafe.Add` não, então a versão com `ref` precisa ser mais rápida. No .NET Core 2.1 essa intuição muitas vezes estava certa. Desde então, o JIT aprendeu a remover a verificação de limites exatamente desse formato de loop, e no .NET 9 aprendeu mais três truques que só se aplicam quando ele entende por completo a variável de índice. O loop com span recebe todos eles. O loop com `Unsafe.Add` fica fora do padrão.

## O que o JIT faz com o loop com span

Este é o código Tier1 Arm64 de `SpanFor`, direto do `DOTNET_JitDisasm` no .NET 10.0.10:

```asm
; Kernels:SpanFor(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
            mov     w2, wzr            ; sum = 0
            cmp     w1, #0             ; length <= 0 ?
            ble     G_M000_IG05
            mov     x3, xzr            ; byte offset = 0
G_M000_IG04:
            ldr     w4, [x0, x3]       ; load s[i]
            add     w2, w4, w2         ; sum += ...
            add     x3, x3, #4         ; offset += 4
            sub     w1, w1, #1         ; remaining--
            cbnz    w1, G_M000_IG04    ; loop while remaining != 0
```

Três otimizações distintas são visíveis nesse loop:

1. **Eliminação da verificação de limites.** Não há comparação com o tamanho nem chamada a `CORINFO_HELP_RNGCHKFAIL`. Como `i` começa em 0, só incrementa e é protegido por `i < s.Length`, a análise de intervalos do JIT prova que `s[i]` é sempre válido. Essa é a parte que todo mundo conhece, e ela funciona para spans desde o .NET Core 2.1.
2. **Redução de força.** O código-fonte multiplica `i` por 4 para obter um endereço. O loop, em vez disso, mantém um deslocamento em bytes em `x3` e soma 4 a ele. As notas do runtime do .NET 9 descrevem isso como o JIT transformando "automaticamente" o acesso indexado nessa forma.
3. **Direção do contador do loop.** O `i` original desapareceu. Quando o endereço deixa de depender de `i`, o contador só controla o número de iterações, então o JIT conta o tamanho até zero e termina o loop com `cbnz` em vez de uma comparação e um desvio separados.

No x64, o mesmo método compila para quatro instruções no corpo do loop:

```asm
; Kernels:SpanFor, crossgen2 10.0.10, win-x64, full opts
G_M000_IG04:
       add      edx, dword ptr [rax+r8]
       add      r8, 4
       dec      ecx
       jne      SHORT G_M000_IG04
```

Isso é o mais enxuto que um loop escalar de soma consegue ser. Não sobrou nenhuma instrução para uma reescrita com `ref` remover.

## O que o JIT faz com o loop com `Unsafe.Add`

Agora `RefAdd`, mesma máquina, mesma execução:

```asm
; Kernels:RefAdd(System.ReadOnlySpan`1[int]):int (Tier1), .NET 10.0.10 Arm64
G_M000_IG03:
            ldr     w4, [x0, w3, SXTW #2]   ; load r[(nint)i * 4]
            add     w2, w4, w2
            add     w3, w3, #1              ; i++
            cmp     w3, w1                  ; i < length ?
            blt     G_M000_IG03
```

```asm
; Kernels:RefAdd, crossgen2 10.0.10, win-x64, full opts
G_M000_IG05:
       movsxd   r8, ecx                     ; sign-extend i to 64 bits
       add      esi, dword ptr [rax+4*r8]
       inc      ecx
       cmp      ecx, edx
       jl       SHORT G_M000_IG05
```

O loop não tem verificação de limites, mas o loop com span também não tinha, então isso não rende nada. O que ele perdeu foi a redução de força e a contagem regressiva. `Unsafe.Add<T>(ref T source, int elementOffset)` converte o deslocamento `int` em um inteiro nativo antes de escalá-lo. Essa extensão de sinal fica entre a variável de indução e o endereço, e o JIT não reescreve através dela. Assim, o loop mantém `i` como contador de 32 bits, recalcula o endereço a partir dele a cada iteração (`SXTW #2` no Arm64, um `movsxd` explícito no x64) e precisa de uma comparação real com o tamanho no fim.

No Arm64, a extensão de sinal é incorporada ao modo de endereçamento do load, então o número de instruções é igual ao do loop com span. Ainda assim, ele mediu mais lento, de forma consistente, nas duas execuções. A diferença visível é a saída do loop: um `cmp` explícito do contador incrementado com o tamanho, em vez do `cbnz` fundido do contador regressivo. Não fiz profiling abaixo do nível de instrução, então trate isso como a causa provável, não como uma causa comprovada. No x64, simplesmente há uma instrução a mais por elemento. Nenhuma das diferenças é grande, e esse é o ponto: a versão escrita à mão custa a segurança e ainda perde alguns por cento.

## Corrigindo o loop com `ref`, se você realmente precisar de um

Há duas maneiras de escrever um loop com `ref` que iguale o loop com span. A primeira é tornar o índice do tamanho nativo, para que não haja nada a estender:

```csharp
// .NET 10.0.10, C# 14
static int RefAddNint(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int r = ref MemoryMarshal.GetReference(s);
    for (nint i = 0; i < s.Length; i++) sum += Unsafe.Add(ref r, i);
    return sum;
}
```

O código Tier1 Arm64 disso é instrução por instrução igual ao de `SpanFor` (`ldr w4, [x0, x3]`, `add x3, x3, #4`, `sub x1, x1, #1`, `cbnz`), e registrou 1.036,1 ns contra 1.035,7 ns do loop com span. A saída do crossgen2 para x64 também é o mesmo corpo de quatro instruções.

A segunda é a caminhada que avança o ponteiro, usada por muito código de alto desempenho mais antigo:

```csharp
// .NET 10.0.10, C# 14
static int RefWalk(ReadOnlySpan<int> s)
{
    int sum = 0;
    ref int p = ref MemoryMarshal.GetReference(s);
    ref int end = ref Unsafe.Add(ref p, s.Length);
    while (Unsafe.IsAddressLessThan(ref p, ref end))
    {
        sum += p;
        p = ref Unsafe.Add(ref p, 1);
    }
    return sum;
}
```

No Arm64, esta usa endereçamento pós-indexado (`ldr w3, [x0], #0x04`, carregar e avançar em uma só instrução), então o corpo do loop tem quatro instruções em vez de cinco. Foi a linha mais rápida com um milhão de elementos por cerca de 1%, o que está dentro do ruído que você veria entre duas máquinas diferentes. Esse é o melhor caso para código `ref` escrito à mão no .NET 10: um empate de 1%, em troca de um código em que um erro de off-by-one lê ou escreve memória fora do span sem nenhuma exceção. Note também que `end` é uma referência gerenciada um elemento além do fim do buffer. As [boas práticas de código unsafe](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) dizem para não criar ponteiros gerenciados inválidos, mesmo que você nunca os desreferencie, e deixam as regras exatas de validade para a ECMA-335. Esse não é um canto onde você queira estar por 1% de ganho.

Se você escreve `foreach (ref readonly int x in span)` porque ouviu dizer que é o "loop com ref", ele compila para o mesmo código do loop indexado com span. O compilador C# converte um `foreach` sobre span em um `for` indexado sobre o span, então o JIT vê o mesmo formato.

## Onde o loop com span perde a vantagem

O loop com span é rápido porque o JIT consegue provar coisas sobre ele. Quebre a prova e o loop muda de formato. A maneira mais comum é limitar o loop por algo diferente de `span.Length`:

```csharp
// .NET 10.0.10, C# 14
static int SpanForN(ReadOnlySpan<int> s, int n)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += s[i];   // n is not s.Length
    return sum;
}
```

Agora `s[i]` pode realmente estar fora do intervalo. O JIT Tier1 lida com isso com **clonagem de loop**: ele emite uma verificação `n <= s.Length` antes do loop, um clone rápido sem verificação de limites para quando ela é verdadeira e um clone lento que verifica a cada iteração e lança `IndexOutOfRangeException` no primeiro índice inválido. O clone rápido na minha listagem Arm64 é idêntico a `SpanFor`, e é por isso que a linha do benchmark empata. A saída do crossgen2 para x64 do mesmo método não clonou e manteve um `cmp`/`jae` no loop. Então, se um método assim roda a partir de código ReadyToRun antes de o tiering substituí-lo, ele paga a verificação. A correção é entregar a prova ao JIT você mesmo: `s = s[..n];` antes do loop, e depois iterar até `s.Length`. O slice faz uma verificação de limites logo no início, e toda iteração seguinte sai de graça.

O mesmo truque importa quando há dois spans:

```csharp
// .NET 10.0.10, C# 14
static void CopyX2(ReadOnlySpan<int> src, Span<int> dst)
{
    dst = dst[..src.Length];                    // one check here...
    for (int i = 0; i < src.Length; i++)
        dst[i] = src[i] * 2;                    // ...none in the loop
}
```

Sem o slice, `dst[i]` não é coberto pela guarda `i < src.Length`. O Tier1 também clonou esse loop (um `cmp w1, w3` / `bgt` antes da entrada seleciona a cópia com ou sem verificação), então as três variantes (sem slice, com slice e uma versão com `Unsafe.Add` e verificação manual de tamanho) mediram dentro de 1% umas das outras com 4.096 elementos. Com 64 elementos, a versão com `Unsafe.Add` e sua verificação inicial de `ArgumentException` foi a mais lenta das três, com 20,1 ns contra 16,8 ns do loop com span e slice. O slice continua sendo a versão a escrever, porque não depende de heurísticas de clonagem e diz o que o método exige.

Se quiser ver as verificações por conta própria, o post anterior sobre [eliminação de verificação de limites para acesso por índice a partir do fim no .NET 11](/pt-br/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) mostra como ler `CORINFO_HELP_RNGCHKFAIL` em uma listagem, e o [visualizador de ASM do Rider](/pt-br/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) mostra o mesmo código sem variáveis de ambiente.

## Como verificar isso no seu próprio código

A orientação da própria Microsoft nas [boas práticas de código unsafe](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) é direta: os benefícios da remoção unsafe da verificação de limites "são frequentemente transitórios", então verifique se o JIT atual ainda precisa disso e reescreva em código seguro se não precisar. Dois comandos bastam para checar:

```bash
# .NET 10 SDK, any OS
DOTNET_JitDisasm="SpanFor RefAdd" DOTNET_JitStdOutFile=jit.txt dotnet run -c Release
dotnet run -c Release -- --filter '*SpanFor*' '*RefAdd*'   # BenchmarkDotNet
```

Coisas que vão enganar você no processo:

- **Código Tier0.** A primeira listagem impressa para um método é código Tier0 sem otimização, em que `s[i]` é uma chamada real com uma verificação real. Procure a listagem marcada como `Tier1`. O post sobre [como a compilação em camadas funciona](/pt-br/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) explica quando cada camada roda e o que o OSR faz com loops de longa duração.
- **Listagens ReadyToRun e crossgen2.** O código pré-compilado não tem PGO e pode manter chamadas que o Tier1 faz inline. Minhas listagens x64 chamam `MemoryMarshal.GetReference` fora de linha, muito provavelmente porque o crossgen2 não faz inline através da version bubble para dentro de `System.Private.CoreLib`. Os corpos dos loops continuam representativos, mas o prólogo não.
- **Microbenchmarks que escondem o loop.** Marque o kernel com `[MethodImpl(MethodImplOptions.NoInlining)]` para que o JIT o compile como um método próprio, e leia a listagem desse método, não a do wrapper do benchmark.
- **Baseline errado.** Se o objetivo real é throughput, compare com uma versão vetorizada. `Enumerable.Sum` sobre um `int[]` rodou com o dobro da velocidade de qualquer loop escalar aqui, e `Vector<T>` ou `TensorPrimitives` levam você até lá para operações personalizadas.

## Escolhendo entre eles

Use como padrão o loop indexado sobre span (ou array) limitado por `.Length`. Ele é seguro, é para o que o otimizador de loops do JIT é ajustado e, no .NET 10, nunca é mais lento do que as alternativas com `ref` em nenhuma destas medições. Quando o limite for outra coisa, faça o slice primeiro para que o limite passe a ser `.Length`.

Recorra a `ref T` e `Unsafe.Add` somente quando tiver uma listagem que mostre uma verificação de limites que o JIT não consegue remover e um benchmark que mostre que a verificação importa. Quando o fizer, use um índice `nint` ou uma caminhada com ponteiro, não um índice `int`, ou você perderá a redução de força que o loop com span recebeu de graça. Se você está tomando decisões sobre `ref` e slicing em uma API inteira, [`List<T>` vs `Span<T>` vs `ReadOnlySpan<T>`](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) cobre qual tipo aceitar logo de início, [o que é `Span<T>` e quando ele deixa o código mais rápido](/pt-br/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) cobre os outros dois lugares em que spans realmente compensam, e [iterar duas coleções em paralelo sem alocações](/pt-br/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/) aplica o padrão de slice para provar limites a um loop com duas entradas.

## Fontes

- [What's new in the .NET 9 runtime: loop optimizations](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/runtime#loop-optimizations) (alargamento de variável de indução, endereçamento pós-indexado, redução de força, direção do contador do loop)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/runtime) (inversão de loop aprimorada, da qual dependem a clonagem de loop e as otimizações de variável de indução)
- [Unsafe code best practices](https://learn.microsoft.com/en-us/dotnet/standard/unsafe-code/best-practices) (seção 9, remoção unsafe da verificação de limites; seção 4, ponteiros gerenciados inválidos)
- [Referência da API da classe `Unsafe`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe)
- [BenchmarkDotNet](https://benchmarkdotnet.org/)
