---
title: "RyuJIT poda mais bounds checks no .NET 11 Preview 3: index-from-end e i + constante"
description: ".NET 11 Preview 3 ensina ao RyuJIT a eliminar bounds checks redundantes em acessos consecutivos index-from-end e em padrões i + constante < length, cortando pressão de branches em loops apertados."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

A eliminação de bounds check é a otimização do JIT que decide silenciosamente quão rápido muito código .NET é. Todo `array[i]` e `span[i]` em código managed carrega um compare-and-branch implícito, e quando o RyuJIT consegue provar que o índice está no range, esse branch some. O .NET 11 Preview 3 estende essa prova a dois padrões comuns que antes pagavam o check mesmo assim.

As duas mudanças estão documentadas nas [release notes do runtime](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/runtime.md) e aparecem em destaque no [anúncio do .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) de 14 de abril de 2026.

## Acesso back-to-back index-from-end

O operador index-from-end `^1`, `^2`, introduzido com C# 8, é syntactic sugar pra `Length - 1`, `Length - 2`. O JIT já conseguia elidir o bounds check no primeiro acesso há tempos, mas um segundo acesso logo depois era frequentemente tratado de forma independente e forçava um compare-and-branch redundante.

No .NET 11 Preview 3 a análise de range reutiliza a prova de length entre acessos consecutivos index-from-end:

```csharp
static int TailSum(int[] values)
{
    // .NET 10: two bounds checks, one per access.
    // .NET 11 Preview 3: the JIT proves both are in range from a single length test.
    return values[^1] + values[^2];
}
```

Se você desassemblar `TailSum` no [ASM viewer do Rider 2026.1](https://blog.jetbrains.com/dotnet/), dá pra ver o segundo par `cmp`/`ja` simplesmente sumir. Código que caminha pela cauda de um buffer, accessors de ring-buffer, parsers que espiam o último token, ou comparadores de janela fixa, todos se beneficiam sem mudança de fonte.

## Loops `i + constante < length`

A segunda melhoria mira um padrão que aparece o tempo todo em código numérico e de parsing. Um loop stride-2 parecia bem no papel mas ainda pagava um bounds check no segundo acesso:

```csharp
static int SumPairs(ReadOnlySpan<int> buffer)
{
    int sum = 0;
    for (int i = 0; i + 1 < buffer.Length; i += 2)
    {
        // buffer[i] is trivially safe, but buffer[i + 1] used to
        // get its own bounds check, even though the loop condition
        // already proved it.
        sum += buffer[i] + buffer[i + 1];
    }
    return sum;
}
```

A condição do loop `i + 1 < buffer.Length` já prova que `buffer[i + 1]` está no range, mas o RyuJIT costumava tratar os dois acessos como independentes. Preview 3 ensina a análise a raciocinar sobre um índice mais uma constante pequena contra um length, então tanto `buffer[i]` quanto `buffer[i + 1]` compilam pra um load simples.

A mesma reescrita se aplica a `i + 2`, `i + 3`, e assim por diante, enquanto o offset constante bater com o que a condição do loop garante. Alargue a condição pra `i + 3 < buffer.Length`, e um inner loop stride-4 fica bounds-check-free nos quatro acessos.

## Por que branches pequenos somam

Um único bounds check custa menos de um nanossegundo em CPUs modernas. A pressão real é de segunda ordem: o slot de branch que consome, as decisões de loop-unrolling que bloqueia, as oportunidades de vetorização que derrota. Quando o RyuJIT prova que um inner loop inteiro é bounds-safe, ele fica livre pra desenrolar mais agressivamente e entregar o bloco ao auto-vetorizador. É aí que uma micro-vitória de 1% no papel vira uma melhora de 10 a 20% num kernel numérico de verdade.

## Tentando hoje

Nenhuma das otimizações precisa de feature flag. Rode qualquer SDK .NET 11 Preview 3 e elas entram automaticamente. Seteie `DOTNET_JitDisasm=TailSum` pra dumpar o código gerado, rode uma vez no .NET 10 e uma no Preview 3, e diff. Se você mantém hot loops em arrays ou spans, especialmente coisas que espiam o fim de um buffer ou caminham com stride fixo, esse é um speedup grátis esperando no Preview 3.
