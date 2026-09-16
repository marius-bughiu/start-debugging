---
title: "O JIT do .NET 11 desvirtualiza métodos virtuais genéricos, e a alocação some junto"
description: "O artigo Performance Improvements in .NET 11 de Stephen Toub mostra chamadas a métodos virtuais genéricos caindo de 6,7 ns e 24 bytes para 1,8 ns e zero alocação. Três pull requests do RyuJIT liberaram o inlining no despacho que era o mais opaco do .NET."
pubDate: 2026-09-16
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods"
translatedBy: "claude"
translationDate: 2026-09-16
---

Stephen Toub publicou ["Performance Improvements in .NET 11"](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) em 2026-09-15, e enterrada na seção de desabstração está uma mudança que ficou bloqueada por anos: o RyuJIT agora consegue desvirtualizar métodos virtuais genéricos.

Os GVMs foram por muito tempo a forma de despacho mais lenta do .NET, e por um motivo estrutural. Um método virtual comum tem um slot na vtable, então o compilador sabe onde procurar. `int SizeOf<T>(T value)` declarado em uma interface não tem um slot único, porque cada instanciação é um corpo de método diferente identificado pelos argumentos de tipo. Resolver um deles exige uma busca em tempo de execução, e para o JIT o resultado é um ponteiro de função opaco. Opaco significa nada de inlining, e sem inlining a análise de escape nunca consegue enxergar através da chamada.

## O benchmark do artigo

```csharp
[Benchmark]
public int NonShared() => ((IProcessor)new Processor()).SizeOf(42);

[Benchmark]
public int Shared() => ((IProcessor)new Processor()).SizeOf("hello");

private interface IProcessor
{
    int SizeOf<T>(T value);
}

private sealed class Processor : IProcessor
{
    public int SizeOf<T>(T value) => Unsafe.SizeOf<T>();
}
```

`NonShared` instancia sobre `int`, então o runtime compila um corpo dedicado. `Shared` instancia sobre `string`, que usa o corpo compartilhado para tipos de referência e por isso precisa que um argumento de contexto genérico seja propagado pela chamada. As duas eram lentas:

| Método | Runtime | Média | Ratio | Alocado |
| --- | --- | --- | --- | --- |
| NonShared | .NET 10.0 | 6.678 ns | 1.00 | 24 B |
| NonShared | .NET 11.0 | 1.764 ns | 0.26 | 0 B |
| Shared | .NET 10.0 | 7.166 ns | 1.00 | 24 B |
| Shared | .NET 11.0 | 1.764 ns | 0.25 | 0 B |

## Três pull requests, na ordem

[dotnet/runtime#120866](https://github.com/dotnet/runtime/pull/120866) veio primeiro, em novembro de 2025, e é o que destrava o resto. O JIT costumava despejar o alvo da chamada `ldvirtftn` em um temporário antes de montar os argumentos, e isso já bastava para manter o despacho opaco pelo resto do pipeline. Remover esse despejo permitiu que a avaliação do alvo passasse à frente da avaliação dos argumentos onde isso é legal.

[dotnet/runtime#122023](https://github.com/dotnet/runtime/pull/122023) então ensinou o JIT a desvirtualizar GVMs não compartilhados, carregando o contexto genérico de que a chamada precisa para que o despacho indireto vire uma chamada direta e passível de inlining. [dotnet/runtime#128702](https://github.com/dotnet/runtime/pull/128702) estendeu isso para GVMs compartilhados e para implementações padrão de interface que exigem stubs de instanciação, e é por isso que a linha `Shared` cai nos mesmos 1.764 ns de `NonShared`.

## Por que os 24 bytes somem

A alocação nunca foi o objetivo da chamada. `new Processor()` existe apenas para que o cast para a interface tenha um receptor. No .NET 10, a chamada opaca obrigava o JIT a assumir que o receptor escapava, então `Processor` ia para o heap: 24 bytes por invocação.

Assim que a chamada sofre inlining, a análise de escape consegue provar que o objeto nunca sai do frame. A instância é alocada na pilha, ninguém a lê, e ela desaparece por completo. `Unsafe.SizeOf<T>()` vira uma constante na mesma passagem. O ganho de 3,8x é real, mas o zero na coluna de memória alocada é a parte que aparece em um serviço com muita pressão de GC.

Uma ressalva: isso exige que o JIT conheça o tipo exato do receptor no ponto da chamada, como acontece aqui com um tipo `sealed` construído localmente. Para um ponto de chamada de fato polimórfico você ainda depende da desvirtualização guiada do [PGO dinâmico](/pt-br/2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in/), que entrega uma verificação de tipo mais um caminho rápido em linha, e não uma chamada direta.

Se você escreve interfaces de visitor, hooks genéricos de serializadores, ou qualquer abstração em que o parâmetro de tipo fica no método e não no tipo, essa é a mudança do .NET 11 que vale medir no seu próprio código. O [artigo completo](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) traz o disassembly.
