---
title: "O que é o layout transparente de struct, e por que um struct wrapper de campo único muda a convenção de chamada no .NET?"
description: "Um struct transparente é aquele que a ABI trata exatamente como seu único campo. O .NET 11 não oferece essa garantia: um struct que encapsula um double é passado em RCX no Windows x64, mas em XMM0 no Linux e no macOS. Veja o disassembly do JIT do .NET 11 em três ABIs, os bugs de P/Invoke que isso causa e como escrever tipos wrapper seguros em qualquer fronteira."
pubDate: 2026-10-10
tags:
  - "dotnet-11"
  - "csharp"
  - "interop"
  - "jit"
  - "performance"
lang: "pt-br"
translationOf: "2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-10
---

Resposta curta: "layout transparente" é a garantia de que um struct com exatamente um campo tem o layout *e é passado entre chamadas* exatamente como esse campo. O Rust escreve isso como `#[repr(transparent)]`. O .NET 11 não tem isso. Um struct C# como `readonly record struct Meters(double Value)` tem o mesmo layout de memória de 8 bytes que um `double`, mas na fronteira de uma chamada o JIT o classifica como um agregado, e cada ABI de plataforma decide como os agregados viajam. No Linux x64, no macOS x64 e em todos os alvos ARM64, o wrapper ainda viaja em um registrador de ponto flutuante, então você nunca percebe. No Windows x64 ele vai em `RCX`, um registrador inteiro, e é retornado em `RAX` em vez de `XMM0`. Isso custa algumas movimentações de registrador no código gerenciado e corrompe valores silenciosamente se você usar o wrapper em uma assinatura de P/Invoke cujo lado nativo recebe um `double` simples.

Tudo abaixo foi executado no .NET 11 RC1 (runtime 11.0.0-rc.1.26425.128, SDK 11.0.100-rc.1.26425.128) com C# 15. O disassembly gerenciado para Windows x64 e Linux x64 vem do compilador cruzado `crossgen2` do RC1 com `JitDisasm`, as listagens do macOS vêm da execução do app nativamente em arm64 e sob Rosetta em x64, e as listagens nativas vêm do Apple clang 21 mirando cada ABI.

## Layout de memória e convenção de chamada são dois contratos diferentes

Quando as pessoas dizem que um struct de campo único é "gratuito", normalmente se referem ao layout de memória. Essa parte é verdade. `Meters` ocupa 8 bytes, alinhados a 8, exatamente como `double`. `Unsafe.SizeOf<Meters>()` retorna 8, um array de `Meters` é compatível bit a bit com um array de `double`, e `MemoryMarshal.Cast<Meters, double>` funciona.

A convenção de chamada é um contrato separado. Ela responde: quando este valor é um argumento ou um valor de retorno, qual registrador ou slot de pilha o guarda? Uma ABI toma essa decisão *classificando* o tipo, e a maioria das ABIs classifica primeiro por "é um escalar ou um agregado" e só depois olha para dentro. Um struct é um agregado mesmo com um único campo. Se a ABI então olha através dele para o `double` interno depende inteiramente da plataforma:

- **System V AMD64 (Linux x64, macOS x64)** divide agregados em eightbytes e classifica cada um pelos campos que ele contém. Um campo `double` significa que o eightbyte é da classe SSE, então o struct vai em `XMM0`, igual a um `double` puro.
- **AAPCS64 (Linux, macOS e Windows em ARM64)** tem a regra do agregado homogêneo de ponto flutuante (HFA): um struct de um a quatro campos do mesmo tipo de ponto flutuante é passado em registradores SIMD consecutivos. Um `double` é um HFA de tamanho um, então vai em `D0`, igual a um `double` puro.
- **Windows x64** não olha para dentro de jeito nenhum. A [documentação da convenção de chamada x64](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention) diz que structs de tamanho 8, 16, 32 ou 64 bits "are passed as if they were integers of the same size." Um struct contendo um `double` tem 64 bits, então vai em `RCX`. Nos retornos, um tipo definido pelo usuário do tamanho certo volta em `RAX`, enquanto floats e doubles voltam em `XMM0`.

O JIT do .NET segue a ABI da plataforma para chamadas gerenciado-para-gerenciado, não apenas para P/Invoke. Então isso não é uma curiosidade exclusiva de interop. Aparece em código C# comum.

## A ABI nativa, direto do compilador

Aqui está o menor arquivo C que expõe a diferença. Compilá-lo para três alvos com `clang -O2 -S` mostra o que cada ABI espera:

```c
// abi.c, Apple clang 21, -O2
typedef struct { double value; } Meters;
typedef struct { float x, y; } Vec2;

double take_double(double d) { return d * 2.0; }
double take_meters(Meters m) { return m.value * 2.0; }
Meters ret_meters(double d) { Meters m = { d }; return m; }
float  take_vec2(Vec2 v) { return v.x + v.y; }
float  take_two_floats(float x, float y) { return x + y; }
```

Para `x86_64-pc-windows-msvc`:

```asm
; Windows x64
take_double:
    addsd   %xmm0, %xmm0      ; double arrives in xmm0
    retq
take_meters:
    movq    %rcx, %xmm0       ; Meters arrives in rcx, moved to xmm0 first
    addsd   %xmm0, %xmm0
    retq
ret_meters:
    movq    %xmm0, %rax       ; Meters is returned in rax, not xmm0
    retq
```

Para `x86_64-apple-macos` (System V) e `arm64-apple-macos` (AAPCS64), `take_meters` compila para exatamente as mesmas instruções de `take_double` (`addsd %xmm0, %xmm0` e `fadd d0, d0, d0`, respectivamente), e `ret_meters` compila para um simples `ret`, porque o valor já está no registrador de retorno.

Ou seja, o wrapper é transparente em duas das três ABIs por acidente de suas regras de classificação, e opaco no Windows x64.

## O que o JIT do .NET 11 emite para um struct wrapper

Agora o lado gerenciado. Dois métodos, idênticos exceto pelo wrapper:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.CompilerServices;

public readonly record struct Meters(double Value);

static class Managed
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static double ScaleDouble(double d) => d * 2.0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Meters ScaleMeters(Meters m) => new(m.Value * 2.0);
}
```

No Linux x64 (crossgen2 `--targetos:linux --targetarch:x64`), ambos os métodos compilam para os mesmos 5 bytes:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, linux-x64
       vaddsd   xmm0, xmm0, xmm0
       ret
; Total bytes of code 5
```

No macOS arm64, executando nativamente com `DOTNET_JitDisasm`, ambos têm os mesmos 20 bytes, com `fadd d0, d0, d0` como único trabalho real.

No Windows x64 (crossgen2 `--targetos:windows --targetarch:x64`), `ScaleDouble` continua com 5 bytes, mas `ScaleMeters` vira:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, win-x64
       vmovq    xmm0, rcx          ; argument arrives in an integer register
       vaddsd   xmm0, xmm0, xmm0
       vmovq    rax, xmm0          ; result leaves in an integer register
       ret
; Total bytes of code 15
```

Duas movimentações extras entre domínios por chamada, três vezes o tamanho do código. Dentro do corpo do método, o JIT promove o struct para o seu único campo e trabalha com um registrador `double` simples; o custo fica inteiramente na fronteira. Se a chamada é inlinada, a fronteira desaparece e o custo também. Por isso o overhead raramente importa na prática, e você só o vê em caminhos quentes não inlinados: chamadas virtuais, despacho de interface, delegates, métodos com `NoInlining` ou métodos grandes demais para inlinar.

Encapsular um inteiro ou uma referência não tem esse problema em nenhuma dessas ABIs. Um `readonly record struct UserId(int Value)` viaja em `ECX` no Windows x64, `EDI` no System V e `W0` no ARM64, exatamente como um `int` puro. Um struct que encapsula uma referência de objeto viaja como um ponteiro. A divergência é específica de campos de ponto flutuante (e, como mostrado abaixo, de structs com vários campos), porque só os valores de ponto flutuante têm um arquivo de registradores separado que a ABI pode escolher ignorar.

## O bug real: tipos wrapper em assinaturas de P/Invoke

A diferença de desempenho é uma nota de rodapé. A diferença de correção não. Se você usa um wrapper fortemente tipado em uma assinatura `LibraryImport` ou `DllImport` cuja contraparte nativa recebe o primitivo subjacente, está afirmando que o wrapper é transparente. O marshaller não verifica isso, porque o struct é blittable e é passado como está.

Aqui está uma reprodução contra a biblioteca `abi.c` acima:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.ProcessArchitecture} / {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"take_double(Meters 21)  = {Native.TakeDoubleAsMeters(new Meters(21)).Value}");
Console.WriteLine($"take_two_floats(Vec2)   = {Native.TakeTwoFloatsAsVec2(new Vec2(1f, 2f))}");
Console.WriteLine($"take_two_floats(f, f)   = {Native.TakeTwoFloats(1f, 2f)}");

public readonly record struct Meters(double Value);
public readonly record struct Vec2(float X, float Y);

static partial class Native
{
    // Wrong on purpose: the C side is double take_double(double)
    [LibraryImport("libabi", EntryPoint = "take_double")]
    public static partial Meters TakeDoubleAsMeters(Meters m);

    // Wrong on purpose: the C side is float take_two_floats(float, float)
    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloatsAsVec2(Vec2 v);

    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloats(float x, float y);
}
```

No macOS arm64:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 3
take_two_floats(f, f)   = 3
```

Tudo "funciona". `Meters` é um HFA de um `double`, `Vec2` é um HFA de dois `float`s, e a AAPCS64 os coloca em `D0` e `S0`/`S1`, exatamente onde o código nativo procura.

No macOS x64 (System V), mesmo binário, mesma biblioteca:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 1
take_two_floats(f, f)   = 3
```

`Meters` continua funcionando, porque um único eightbyte SSE vai em `XMM0`. `Vec2` não: o System V empacota os dois floats em um eightbyte, então o struct inteiro chega nos 64 bits baixos de `XMM0`. A função nativa lê `x` de `XMM0` e `y` de `XMM1`, que contém o que quer que tenha sobrado lá. Nesta execução isso era zero por acaso, então a resposta foi `1`. Em outra execução pode ser qualquer coisa.

No Windows x64, as duas declarações erradas quebram. `Meters` vai em `RCX` enquanto `take_double` lê `XMM0`, e o resultado é lido de volta de `RAX` enquanto o código nativo escreveu em `XMM0`. `Vec2` (8 bytes) também vai em `RCX`. Você pode confirmar o lado nativo pela listagem de `x86_64-pc-windows-msvc` acima; o lado gerenciado segue a mesma regra que o disassembly de `ScaleMeters` mostra.

Este é o clássico bug de "funciona no meu Mac, lixo no agente de build do Windows". O código revisado e testado em laptops ARM64 passa, e a primeira execução no Windows x64 produz um absurdo ou um valor sutilmente errado.

## Como escrever tipos wrapper seguros em qualquer fronteira

Não existe nenhum atributo no .NET 11 que torne um struct transparente. `[StructLayout(LayoutKind.Sequential)]`, `Pack` e `Size` controlam o layout de memória, não a classificação de registradores. Então a solução é manter os wrappers no lado gerenciado da fronteira.

1. **Declare as assinaturas nativas com os tipos nativos exatos.** Se o C recebe `double`, o P/Invoke recebe `double`. Encapsule e desencapsule em um método gerenciado fino:

    ```csharp
    // .NET 11 RC1, C# 15
    static partial class Native
    {
        [LibraryImport("libabi", EntryPoint = "take_double")]
        private static partial double TakeDouble(double d);

        public static Meters Scale(Meters m) => new(TakeDouble(m.Value));
    }
    ```

    O método wrapper é inlinado, então você não paga nada pela segurança de tipos.

2. **Só use um struct em um P/Invoke quando o lado nativo usa um struct com os mesmos campos.** Se o header C diz `Vec2 v`, um `Vec2` C# com os mesmos campos na mesma ordem está correto em qualquer ABI, porque os dois lados aplicam a mesma classificação. O bug aparece sempre apenas quando há um struct de um lado e escalares soltos do outro.

3. **Trate ponteiros de função e `UnmanagedCallersOnly` da mesma forma.** Um `delegate* unmanaged<Meters, Meters>` tem o mesmo problema que um `LibraryImport`, e o mesmo vale para uma exportação `[UnmanagedCallersOnly]` que um host nativo chama com um `double`. Se você constrói addons Node ou hosts de plugin dessa forma, como em [escrever addons Node.js com .NET Native AOT](/pt-br/2026/04/nodejs-addons-dotnet-native-aot/), mantenha as assinaturas exportadas primitivas.

4. **Em caminhos gerenciados quentes no Windows x64, verifique se a chamada é inlinada antes de se preocupar.** Se um profiler aponta para um método não inlinado que recebe ou retorna um wrapper de ponto flutuante, olhe o disassembly. O [visualizador de ASM do Rider para disassembly de JIT e Native AOT](/pt-br/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) ou o `DOTNET_JitDisasm` mostrarão o par de `vmovq`. Você pode então passar o primitivo pela fronteira quente, ou reestruturar para que a chamada seja inlinada.

## Armadilhas e casos extremos

- **Dois floats não são um double.** Muita gente assume que "8 bytes são 8 bytes". `Vec2(float, float)` tem 8 bytes, mas é um eightbyte SSE no System V, um HFA de dois no ARM64 e um blob de tamanho inteiro no Windows x64. Três ABIs, três respostas. Este é o caso que mais atinge código multiplataforma de jogos e gráficos.
- **Campos mistos mudam a classificação de novo.** Um `struct { int Id; float Weight; }` tem 8 bytes. No System V ele vira um eightbyte da classe INTEGER (inteiro vence quando um eightbyte mistura classes) e vai em `RDI`. No ARM64 não é um HFA, então vai em `X0`. No Windows x64, `RCX`. Nenhum desses corresponde a passar um `int` e um `float` separadamente.
- **O tamanho importa no Windows x64.** Apenas structs de 1, 2, 4 e 8 bytes são passados por valor em um registrador. Um struct de 12 ou 16 bytes é passado por referência a uma cópia alocada pelo chamador, o que é uma mudança muito maior do que passar seus campos individualmente. No System V e no ARM64, structs de até 16 bytes ainda vão em registradores.
- **Métodos de instância em classes C++ são diferentes de novo.** O MSVC retorna tipos definidos pelo usuário de funções membro não estáticas por um ponteiro oculto, mesmo quando caberiam em `RAX`. Por isso `CallConvMemberFunction` existe em `System.Runtime.CompilerServices`, e por isso métodos COM que retornam structs pequenos são uma armadilha conhecida.
- **A promoção de struct esconde o custo, não o remove.** Dentro de um método o JIT substitui um struct promovido pelo seu campo, então a aritmética local em `Meters` é tão rápida quanto em `double`. A promoção não muda como o valor atravessa uma chamada. Se você está pesando structs contra classes para objetos de valor, a [matriz de decisão entre record, class e struct](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) cobre o lado de tamanho e cópia desse trade-off.
- **ReadyToRun e Native AOT usam as mesmas regras.** O código pré-compilado ainda precisa concordar com a ABI da plataforma, então publicar com [Native AOT ou ReadyToRun](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) não torna um wrapper transparente. A saída do crossgen2 neste post é código ReadyToRun.

## O .NET vai ganhar um layout transparente de verdade?

No .NET 11, não. O mais próximo disso no roadmap é a [proposta de layout de struct para interop em dotnet/runtime#100896](https://github.com/dotnet/runtime/issues/100896), que aprovou um `CustomLayoutAttribute` com tipos de layout para structs estilo C, unions e tipos Swift. A issue menciona explicitamente pedidos por um mecanismo como o `repr(transparent)` do Rust, mas o formato aprovado não inclui um, e a issue foi movida do milestone 11.0.0 para o 12.0.0 em julho de 2026. Se um dia um tipo transparente for lançado, ele permitiria que o JIT e o marshaller classificassem um wrapper de campo único como o seu campo em qualquer ABI, que é exatamente o que a [RFC 1758 do Rust](https://rust-lang.github.io/rfcs/1758-repr-transparent.html) faz para seus newtypes.

Até lá, a regra é curta: wrappers são gratuitos em memória e gratuitos depois do inlining, mas em uma fronteira de ABI eles são agregados, e só a plataforma decide se isso importa. Mantenha-os fora das assinaturas nativas e, se precisar passá-los por uma chamada quente não inlinada no Windows x64, leia o disassembly primeiro.

## Relacionados

- [Record vs class vs struct em C#: uma matriz de decisão](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para escolher o formato de um tipo de valor logo de início.
- [O visualizador de ASM do Rider 2026.1 para disassembly de JIT e Native AOT](/pt-br/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/), a forma mais fácil de ver você mesmo o par de `vmovq`.
- [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) para entender como os três modos de geração de código diferem, e onde não diferem.
- [Polars.NET e LibraryImport](/pt-br/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) para uma biblioteca real baseada em Rust que precisa acertar essas assinaturas.
- [Addons Node.js com .NET Native AOT](/pt-br/2026/04/nodejs-addons-dotnet-native-aot/), onde exportações `UnmanagedCallersOnly` enfrentam a mesma regra no sentido inverso.

## Fontes

- [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention), documentação do Microsoft C++, para as regras de agregados e valores de retorno do Windows x64.
- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI), seção 3.2.3, para a classificação de eightbytes.
- [Procedure Call Standard for the Arm 64-bit Architecture (AAPCS64)](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst), para a regra do HFA.
- [dotnet/runtime#100896: New attribute for interop-specific struct concerns](https://github.com/dotnet/runtime/issues/100896).
- [dotnet/runtime#43867: Keep structs in registers](https://github.com/dotnet/runtime/issues/43867), a issue de acompanhamento do JIT para o tratamento de structs de campo único.
- [Rust RFC 1758: repr(transparent)](https://rust-lang.github.io/rfcs/1758-repr-transparent.html).
