---
title: "Correção: Quebra de resolução de sobrecarga em C# 14 com Span e ReadOnlySpan"
description: "Após atualizar para C# 14 / .NET 10, chamadas como array.Contains, x.Reverse() e MemoryMarshal.Cast passam a se ligar a sobrecargas diferentes ou param de compilar. Aqui está o que mudou e como fixar o comportamento antigo onde importa."
pubDate: 2026-05-19
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet-10"
  - "spans"
  - "breaking-changes"
lang: "pt-br"
translationOf: "2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans"
translatedBy: "claude"
translationDate: 2026-05-19
---

Você atualiza um projeto para C# 14 (que vem com .NET 10, Roslyn 4.13, Visual Studio 17.13) e uma de três coisas acontece: uma `Expression<Func<int[], int, bool>>` que antes compilava e rodava agora lança em tempo de execução, uma chamada a `MemoryMarshal.Cast(array)` para de compilar com erro de ambiguidade, ou um `Assert.Equal([2], myArray)` do xUnit muda de "passa" para "correspondência ambígua entre sobrecargas de Assert.Equal". Todas são a mesma quebra. Os tipos span de primeira classe do C# 14 tornam `T[]` implicitamente conversível em `Span<T>` e `ReadOnlySpan<T>` durante a resolução de sobrecargas, a inferência de tipos e a ligação de métodos de extensão, e isso inverte qual sobrecarga vence em código que antes era inequívoco.

Este post percorre os quatro cenários que realmente encontrei em atualizações reais para .NET 10, mostra a reprodução mínima para cada um e indica a correção recomendada. Todos os exemplos assumem `<LangVersion>14.0</LangVersion>` e `<TargetFramework>net10.0</TargetFramework>` salvo indicação em contrário.

## Por que o C# 14 escolhe sobrecargas diferentes agora

Em C# 13 e anteriores, as conversões implícitas definidas pelo usuário de `T[]` para `Span<T>` e `ReadOnlySpan<T>` (declaradas no runtime via `op_Implicit`) eram tratadas como definidas pela biblioteca, não pela linguagem. O compilador não as considerava durante a resolução de sobrecargas, a inferência de tipos nem a ligação de métodos de extensão. Por isso, antes do .NET 10, você precisava escrever `myArray.AsSpan().BinarySearch(...)` quando queria a sobrecarga de span de um método que também tinha uma sobrecarga de `IEnumerable<T>`. O compilador escolhia silenciosamente a sobrecarga não-span porque não enxergava a conversão.

A proposta de [tipos span de primeira classe](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md) do C# 14 promove essas conversões à linguagem. Concretamente, após a atualização o compilador considera estas conversões durante a resolução de sobrecargas:

- `T[]` para `Span<T>`
- `T[]` para `ReadOnlySpan<T>`
- `T[]` para `ReadOnlySpan<U>` quando `T` é conversível por referência para `U`
- `Span<T>` para `ReadOnlySpan<T>`
- `string` para `ReadOnlySpan<char>`

Também adiciona regras de desempate: quando tanto uma sobrecarga de `Span<T>` quanto uma de `ReadOnlySpan<T>` são aplicáveis para o mesmo argumento, `ReadOnlySpan<T>` é preferida. O motivo dessa preferência aparece adiante (arrays covariantes), então tenha em mente.

A equipe do Roslyn documentou isso como uma [quebra de comportamento](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution) e outra entrada na lista de [quebras do compilador desde o C# 13](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010). Não existe um único código de erro do compilador que dispare para "esta resolução mudou". Alguns cenários ainda compilam silenciosamente mas ligam de forma diferente, outros agora produzem `CS0121` "a chamada é ambígua", e outros lançam em tempo de execução. As correções dependem do caso.

## Cenário 1: lambdas de expressão agora chamam `MemoryExtensions` em vez de `Enumerable`

Este é o mais desagradável porque compila sem reclamar e só quebra em tempo de execução quando a árvore de expressões é interpretada em vez de compilada para IL.

```csharp
// C# 14, .NET 10
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;

Expression<Func<int[], int, bool>> e = (array, num) => array.Contains(num);
var fn = e.Compile(preferInterpretation: true);
fn(new[] { 1, 2, 3 }, 2); // throws at runtime
```

Em C# 13, `array.Contains(num)` dentro da árvore de expressões se ligava a `System.Linq.Enumerable.Contains<T>(IEnumerable<T>, T)`. Em C# 14, o compilador agora vê que `int[]` se converte implicitamente para `ReadOnlySpan<int>`, então a melhor sobrecarga é `System.MemoryExtensions.Contains<T>(ReadOnlySpan<T>, T)`. A árvore de expressões é construída em torno de `MemoryExtensions.Contains`. Quando você pede interpretação (`preferInterpretation: true`), o interpretador de expressões LINQ não consegue lidar com parâmetros `ReadOnlySpan<T>` em chamadas de método arbitrárias e lança uma `NotSupportedException` ou, em alguns provedores antigos do EF Core que traduzem a árvore, uma `System.InvalidOperationException` sobre um método não suportado.

A correção é ligar a sobrecarga não-span explicitamente dentro da lambda. Existem três idiomas que funcionam:

```csharp
// .NET 10, C# 14
M((array, num) => ((IEnumerable<int>)array).Contains(num)); // cast forces Enumerable.Contains
M((array, num) => array.AsEnumerable().Contains(num));      // ditto, slightly less ugly
M((array, num) => Enumerable.Contains(array, num));         // explicit static call, no extension lookup

void M(Expression<Func<int[], int, bool>> e) => e.Compile(preferInterpretation: true);
```

Todas as três forçam o compilador a ligar `Enumerable.Contains` em vez de `MemoryExtensions.Contains`. A versão com cast é a mais barata em tempo de execução (a árvore de expressões contém apenas um nó de cast) e é a que eu uso primeiro.

Se você mantém uma biblioteca que constrói árvores de expressões em nome de chamadores, audite quaisquer caminhos `IQueryable.Provider.Execute` e qualquer código que use `Compile(preferInterpretation: true)`. EF Core 9 e versões posteriores compilam para IL, então a maioria das consultas EF Core não é afetada, mas qualquer interpretador de expressões de terceiros é.

## Cenário 2: Assert.Equal do xUnit fica ambíguo

Se você já escreveu isso em um teste xUnit, tem uma armadilha pronta:

```csharp
// .NET 10, C# 14, xUnit 2.9+
var x = new long[] { 1 };
Assert.Equal([2], x);
// CS0121: The call is ambiguous between the following methods or properties:
// 'Assert.Equal<T>(T[], T[])' and 'Assert.Equal<T>(ReadOnlySpan<T>, Span<T>)'
```

Ambas as sobrecargas são aplicáveis. A expressão de coleção `[2]` pode tipar destino para `long[]` ou `Span<long>`. A variável `x` é `long[]`, que se converte implicitamente tanto em `T[]` quanto em `Span<T>`. Não há melhor sobrecarga única, então você recebe `CS0121`.

A correção recomendada é desambiguar um dos argumentos:

```csharp
// .NET 10, C# 14
var x = new long[] { 1 };
Assert.Equal([2], x.AsSpan());   // binds to (ReadOnlySpan<T>, Span<T>)
// or
Assert.Equal<long>([2], x);      // generic argument disambiguates to (T[], T[]) when no Span overload matches T
```

Uma variante mais sutil aparece quando você mistura `T[]` e `ArraySegment<T>`:

```csharp
// .NET 10, C# 14
var y = new int[] { 1, 2 };
var s = new ArraySegment<int>(y, 1, 1);
Assert.Equal(y, s); // previously bound to Assert.Equal<T>(T, T), now ambiguous with Assert.Equal<T>(Span<T>, Span<T>)
Assert.Equal(y.AsSpan(), s); // workaround
```

`ArraySegment<int>` tem uma conversão implícita tanto para `Span<int>` quanto para `ReadOnlySpan<int>`, e agora `int[]` também tem, então a sobrecarga de span se torna aplicável e compete com a genérica `T, T`.

Se você controla a superfície da API (você escreveu `Assert.Equal`), a correção certa é aplicar [`OverloadResolutionPriorityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute) a uma das sobrecargas para enviesar a resolução. O xUnit incorporou isso na 2.9.x exatamente por esse motivo. Se você não pode recompilar a API, precisa desambiguar no local da chamada.

## Cenário 3: arrays covariantes lançam `ArrayTypeMismatchException`

Este é o bug que realmente apaga dados e o motivo pelo qual o comitê da linguagem fez `ReadOnlySpan<T>` vencer sobre `Span<T>` nos empates do C# 14.

```csharp
// .NET 10, C# 14
using System;
using System.Collections.Generic;
using System.Linq;

string[] s = new[] { "a" };
object[] o = s; // array variance: legal since C# 1

C.R(o);             // C# 13: prints 1 (IEnumerable overload). C# 14: ArrayTypeMismatchException
C.R(o.AsEnumerable()); // workaround

static class C
{
    public static void R<T>(IEnumerable<T> e) => Console.Write(1);
    public static void R<T>(Span<T> s)        => Console.Write(2);
}
```

O que acontece: `object[] o` é na verdade um `string[]` por baixo. Em C# 13, a única sobrecarga aplicável era `R<T>(IEnumerable<T>)`, então imprimia `1`. Em C# 14, `R<T>(Span<T>)` também é aplicável porque `T[]` agora se converte implicitamente em `Span<T>`. O compilador escolhe a sobrecarga de span (é "mais específica"), insere uma chamada ao construtor `Span<object>(o)` e o construtor lança `System.ArrayTypeMismatchException` em tempo de execução porque você não pode escrever `object` em um `string[]` subjacente.

É por isso que as regras de desempate do C# 14 preferem `ReadOnlySpan<T>` sobre `Span<T>`: um `ReadOnlySpan<T>` não pode escrever no array subjacente, então é seguro com arrays covariantes. A correção recomendada quando você controla a API é adicionar uma sobrecarga de `ReadOnlySpan<T>`:

```csharp
// .NET 10, C# 14
static class C
{
    public static void R<T>(IEnumerable<T> e)    => Console.Write(1);
    public static void R<T>(Span<T> s)           => Console.Write(2);
    public static void R<T>(ReadOnlySpan<T> s)   => Console.Write(3); // wins over Span<T> in C# 14
}
```

Agora `C.R(o)` imprime `3` (sem exceção). Quando você não pode adicionar uma sobrecarga, a correção no local da chamada é `o.AsEnumerable()` ou `((IEnumerable<object>)o)`.

## Cenário 4: `MemoryMarshal.Cast` e o desempate de ReadOnlySpan

A preferência por `ReadOnlySpan<T>` também quebra alguns padrões de biblioteca onde o autor pretendia que você optasse por uma sobrecarga passando um `Span<T>`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

double[] x = new double[0];
Span<ulong> y = MemoryMarshal.Cast<double, ulong>(x);
// CS0029: Cannot implicitly convert type 'ReadOnlySpan<ulong>' to 'Span<ulong>'
Span<ulong> z = MemoryMarshal.Cast<double, ulong>(x.AsSpan()); // workaround
```

`MemoryMarshal.Cast` tem tanto `Cast<TFrom, TTo>(Span<TFrom>)` quanto `Cast<TFrom, TTo>(ReadOnlySpan<TFrom>)`. Em C# 13, passar um `double[]` se resolvia pela conversão definida pelo usuário para `Span<TFrom>` porque não havia desempate e `Span<T>` era o alvo "direto". Em C# 14, ambas as sobrecargas são aplicáveis através das novas conversões embutidas, a sobrecarga de `ReadOnlySpan<T>` vence o desempate, e o resultado não é mais atribuível a um local `Span<ulong>`. Você ou chama `.AsSpan()` explicitamente para pular a conversão de array para span (ela produz um `Span<double>` diretamente, que só corresponde à sobrecarga de `Span`) ou muda o tipo do local para `ReadOnlySpan<ulong>` se não precisar de mutabilidade.

## O canto de `Enumerable.Reverse` para alvos antigos

Há uma armadilha extra que só afeta uma configuração não suportada mas vale a pena sinalizar porque aparece em projetos de migração legados. Se você define `<LangVersion>14.0</LangVersion>` mas mira um TFM antigo como `net8.0` com uma referência a `System.Memory`, isto acontece:

```csharp
// LangVersion 14, TargetFramework net8.0 (unsupported)
int[] x = new[] { 1, 2, 3 };
var y = x.Reverse(); // C# 13: Enumerable.Reverse, returns IEnumerable<int>
                     // C# 14: MemoryExtensions.Reverse, void in-place reverse
```

`MemoryExtensions.Reverse(Span<T>)` reverte no local e retorna `void`, enquanto `Enumerable.Reverse(IEnumerable<T>)` retorna a sequência revertida. A semântica inverte e `y` não é mais iterável. No `net10.0` isso é corrigido por uma nova sobrecarga `Enumerable.Reverse(this T[])` que toma precedência, então a quebra só aparece quando você mistura compilador novo com BCL antiga. A correção certa é atualizar o TFM, mas se você não puder, chame `Enumerable.Reverse(x)` explicitamente ou defina sua própria extensão `Reverse(this T[])` no seu namespace.

## Como detectar antes do runtime

Algumas mitigações práticas para uma atualização em andamento:

- Defina `<LangVersion>13.0</LangVersion>` em projetos individuais enquanto faz a triagem. Os recursos do C# 14 não relacionados a spans (modificadores de parâmetros de lambda, construtores parciais, palavra-chave `field`) ficarão desabilitados, mas a resolução permanece previsível.
- Ative o analisador do Roslyn [CA1872](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1872) e a inspeção do ReSharper/Rider ["C# 14 breaking change in overload resolution with span parameters"](https://www.jetbrains.com/help/resharper/CSharp14OverloadResolutionWithSpanBreakingChange.html). A inspeção do Rider destaca especificamente locais de chamada onde as novas conversões mudam qual sobrecarga é selecionada.
- Audite `Compile(preferInterpretation: true)` e qualquer consumidor terceiro de árvores de expressões (por exemplo, provedores antigos do EF6, Marten 6.x, Linq2DB anterior à 5.x). Eles são os pontos de maior risco porque a mudança é silenciosa em tempo de compilação.
- Procure por `Assert.Equal(`, `Assert.Contains(` e asserções similares de tipo coleção na sua suíte de testes. Atualize o xUnit para uma versão com anotações de `OverloadResolutionPriorityAttribute` (xUnit 2.9.x ou mais recente).

Se você é autor de uma API, a correção mais limpa a longo prazo é adicionar sobrecargas de `ReadOnlySpan<T>` ao lado de qualquer sobrecarga de `Span<T>` existente e aplicar `[OverloadResolutionPriority(1)]` àquela à qual você quer que os chamadores se liguem. O atributo é respeitado pelos compiladores de C# 13 e C# 14 (é ignorado em configurações de `LangVersion` anteriores, essa é a única ressalva), então cobre a maioria dos cenários de migração.

## Relacionado

Se você quer o contexto de por que essas conversões existem em primeiro lugar, o mergulho profundo em [conversões implícitas de Span em C# 14 e suporte de primeira classe para Span e ReadOnlySpan](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cobre a tabela completa de conversões e a motivação. O post mais amplo sobre [novidades do C# 14](/pt-br/2024/12/csharp-14/) lista as outras quebras que você deve esperar na mesma atualização, incluindo o modificador de parâmetro de lambda `scoped` e a palavra-chave contextual `field`. Para uma prévia da linguagem que vem por aí, [argumentos de expressão de coleção em C# 15](/pt-br/2026/04/csharp-15-collection-expression-arguments/) se constrói em cima dessas regras de span e vale a leitura quando você estiver confortável com como o compilador escolhe entre alvos span e não-span.

## Fontes

- [Breaking change: C# 14 overload resolution with span parameters (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [C# compiler breaking changes since C# 13 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010)
- [First-class span types proposal (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [Issue dotnet/docs#43952: covariant array overload selection](https://github.com/dotnet/docs/issues/43952)
- [OverloadResolutionPriorityAttribute (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [Rider inspection: C# 14 overload resolution with span parameters (JetBrains)](https://www.jetbrains.com/help/rider/CSharp14OverloadResolutionWithSpanBreakingChange.html)
