---
title: "Rider 2026.1 inclui um visualizador de ASM para a saída de JIT, ReadyToRun e NativeAOT"
description: "Rider 2026.1 adiciona um plugin .NET Disassembler que permite inspecionar o código de máquina gerado pelos compiladores JIT, ReadyToRun e NativeAOT sem sair da IDE."
pubDate: 2026-04-13
tags:
  - "rider"
  - "jetbrains"
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "pt-br"
translationOf: "2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly"
translatedBy: "claude"
translationDate: 2026-04-25
---

A JetBrains lançou o [Rider 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/rider-2026-1-released/) em 30 de março, e o destaque em tooling para desenvolvedores é um novo visualizador de ASM que renderiza o disassembly nativo do seu código C# diretamente dentro da IDE. O plugin suporta a saída de JIT, ReadyToRun (crossgen2) e NativeAOT (ilc) em x86/x64 e ARM64.

## Por que olhar para o assembly em primeiro lugar

Código .NET sensível a desempenho, pense em loops quentes, caminhos SIMD ou alocações pesadas em struct, às vezes se comporta de forma diferente do que a fonte C# sugere. O JIT pode desvirtualizar uma chamada, os dados de PGO podem inlinear um método que você esperava permanecer como chamada, ou NativeAOT pode dispor structs de uma forma que mate suas suposições de linha de cache. Até agora você precisava de ferramentas externas como [SharpLab](https://sharplab.io), o `DisassemblyDiagnoser` do BenchmarkDotNet, ou o [Disasmo](https://github.com/EgorBo/Disasmo) de Egor Bogatov para ver o que realmente chega à CPU. Rider 2026.1 traz esse fluxo de trabalho para dentro do editor.

## Começando

Instale o plugin a partir de **Settings > Plugins > Marketplace** procurando ".NET Disassembler". Requer um projeto .NET 6.0+. Uma vez instalado, abra qualquer arquivo C#, posicione o cursor sobre um método ou propriedade, e abra **View > Tool Windows > ASM Viewer** (ou clique com o botão direito e selecione no menu de contexto). Rider compila o alvo e exibe a saída do assembly automaticamente.

Tome um exemplo simples:

```csharp
public static int Sum(int[] values)
{
    int total = 0;
    for (int i = 0; i < values.Length; i++)
        total += values[i];
    return total;
}
```

Com PGO habilitado e a compilação por níveis ativa, o JIT no .NET 10 vetorizará esse loop em instruções SIMD. O visualizador de ASM mostra as instruções `vpaddd` e `vmovdqu` que provam que isso realmente aconteceu, bem ao lado da sua fonte.

## Snapshot e diff

O plugin suporta snapshots. Você pode capturar a saída atual do assembly, fazer uma alteração de código, e então comparar as duas lado a lado. Isso é útil quando você quer verificar que uma pequena refatoração (digamos, trocar de `Span<T>` para `ReadOnlySpan<T>`, ou adicionar um atributo `[MethodImpl(MethodImplOptions.AggressiveInlining)]`) realmente muda o código gerado da forma esperada.

## Opções de configuração

A barra de ferramentas no visualizador de ASM permite alternar:

- **Compilação por níveis** ligada ou desligada
- **PGO** (otimização guiada por perfil)
- **Saída amigável para diff** que estabiliza endereços para comparações mais limpas
- Alvo do compilador: JIT, ReadyToRun ou NativeAOT

Alternar entre a saída de JIT e NativeAOT para o mesmo método é uma maneira rápida de ver o quanto os dois pipelines divergem para seus padrões de código específicos.

## Onde isto se encaixa

O visualizador de ASM não substitui o BenchmarkDotNet para medir o throughput real. Ele o complementa. Quando um benchmark mostra uma regressão inesperada, o visualizador te dá um caminho rápido para "o que mudou no código gerado?" sem trocar de ferramentas ou escrever um harness separado. O plugin é baseado no [projeto Disasmo](https://github.com/EgorBo/Disasmo) de Egor Bogatov e está disponível em Windows, macOS e Linux. Detalhes completos no [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/29736--net-disassembler).
