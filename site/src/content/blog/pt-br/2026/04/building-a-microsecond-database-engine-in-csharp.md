---
title: "Construindo um motor de banco de dados de latência de microssegundos em C#"
description: "O projeto Typhon de Loic Baumann mira commits ACID de 1-2 microssegundos usando ref structs, intrínsecos de hardware e memória fixada, provando que C# pode competir no nível de programação de sistemas."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "database"
lang: "pt-br"
translationOf: "2026/04/building-a-microsecond-database-engine-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

A suposição de que motores de banco de dados de alto desempenho exigem C, C++ ou Rust está profundamente enraizada. O [projeto Typhon](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) de Loic Baumann a desafia diretamente: um motor de banco de dados ACID embarcado escrito em C#, mirando commits transacionais de 1-2 microssegundos. O projeto recentemente [chegou à primeira página do Hacker News](https://news.ycombinator.com/item?id=47720060), provocando um debate animado sobre o que .NET moderno pode realmente fazer.

## O kit de desempenho em C# moderno

O argumento central de Baumann é que o gargalo no design de motores de banco de dados é o layout de memória, não a escolha de linguagem. C# moderno fornece as ferramentas para controlar a memória em um nível que teria sido impossível uma década atrás.

Os tipos `ref struct` vivem exclusivamente na pilha, eliminando alocações no heap em caminhos quentes:

```csharp
ref struct TransactionContext
{
    public Span<byte> WriteBuffer;
    public int PageIndex;
    public bool IsDirty;
}
```

Para regiões de memória que nunca devem se mover, `GCHandle.Alloc` com `GCHandleType.Pinned` mantém o coletor de lixo fora das seções críticas. Combinado com `[StructLayout(LayoutKind.Explicit)]`, você obtém controle em nível C sobre cada offset de byte:

```csharp
[StructLayout(LayoutKind.Explicit, Size = 64)]
struct PageHeader
{
    [FieldOffset(0)]  public long PageId;
    [FieldOffset(8)]  public long TransactionId;
    [FieldOffset(16)] public int RecordCount;
    [FieldOffset(20)] public PageFlags Flags;
}
```

## Intrínsecos de hardware para caminhos quentes

O namespace `System.Runtime.Intrinsics` dá acesso direto às instruções SIMD. Para um motor de banco de dados escaneando páginas ou computando checksums, esta é a diferença entre "rápido o suficiente" e "competitivo com C":

```csharp
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

static unsafe uint Crc32Page(byte* data, int length)
{
    uint crc = 0;
    int i = 0;
    for (; i + 8 <= length; i += 8)
        crc = Sse42.Crc32(crc, *(ulong*)(data + i));
    for (; i < length; i++)
        crc = Sse42.Crc32(crc, data[i]);
    return crc;
}
```

## Impondo disciplina em tempo de compilação

Um dos aspectos mais interessantes da abordagem do Typhon é usar analisadores Roslyn como trilhos de segurança. Analisadores personalizados impõem regras específicas do domínio (sem alocações acidentais no heap em código transacional, sem aritmética de ponteiros não verificada fora de módulos aprovados) em tempo de compilação, em vez de depender da revisão de código.

Genéricos restritos com `where T : unmanaged` fornecem outra camada, garantindo que estruturas de dados genéricas funcionem somente com tipos blittable que têm layouts de memória previsíveis.

## O que isto significa para .NET

Typhon ainda não é um banco de dados de produção. Mas o projeto demonstra que a lacuna entre C# e linguagens de sistemas tradicionais diminuiu significativamente. Entre `Span<T>`, intrínsecos de hardware, `ref struct` e controle explícito de layout de memória, .NET 10 te dá os blocos de construção para trabalho de sistemas crítico em desempenho sem deixar o ecossistema gerenciado.

O [artigo completo](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) vale a pena ler pelos detalhes arquiteturais e benchmarks.
