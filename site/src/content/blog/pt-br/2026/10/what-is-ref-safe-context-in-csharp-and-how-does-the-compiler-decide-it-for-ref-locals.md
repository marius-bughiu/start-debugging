---
title: "O que é ref-safe-context em C# e como o compilador o decide para ref locals?"
description: "ref-safe-context é o escopo em que uma referência a uma variável permanece válida. Aqui estão os quatro contextos, a regra que fixa o contexto de um ref local no seu inicializador, por que a reatribuição de ref nunca pode ampliar nem reduzir esse contexto, e os erros CS8157, CS8168, CS8374 e CS9079 que decorrem disso, com a saída do compilador no C# 14 com .NET 10 e .NET 11 RC1."
pubDate: 2026-10-15
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "pt-br"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---

Resposta curta: ref-safe-context (contexto seguro de referência) é a região do código em que uma referência (um `ref` local, um `ref` return, um `ref` field) a uma determinada variável tem a garantia de apontar para memória viva. O compilador C# atribui a cada variável um entre quatro contextos, do mais estreito ao mais amplo: declaration-block, function-member, return-only e caller-context. Um `ref` local não recebe um contexto próprio. Ele copia o ref-safe-context da expressão com a qual foi inicializado, esse contexto fica fixo pelo resto da sua vida, e todo `r = ref other;` posterior precisa apontar para algo cujo contexto seja pelo menos tão amplo quanto o dele. Essa única regra explica por que um `ref` local inicializado a partir de um local da pilha nunca pode ser retornado, mesmo que você o reatribua depois a um elemento de array.

Todos os resultados deste post vêm de builds reais: o SDK do .NET 10 10.0.302 com `<LangVersion>14</LangVersion>`, e os mesmos arquivos recompilados com o SDK do .NET 11 RC1 (11.0.100-rc.1.26425.128). Os diagnósticos são idênticos nos dois e foram colados da saída do compilador, não parafraseados.

## Por que o compilador rastreia um "contexto"

Um `ref` em C# é um ponteiro gerenciado. Ele pode apontar para o heap (um elemento de array, um campo de uma instância de classe), para o armazenamento estático ou para um stack frame (um local, um parâmetro). Memória do heap e estática sobrevive a qualquer chamada de método. Um stack frame morre quando o método retorna. Se um método pudesse entregar um `ref` para um de seus próprios locais, o chamador ficaria com um ponteiro para um frame morto, exatamente o bug de use-after-free que o `ref` foi projetado para não ter.

O C# não resolve isso com uma verificação em tempo de execução. Ele resolve de forma estática: cada variável recebe um ref-safe-context que descreve até onde uma referência a ela pode viajar, e cada lugar que armazena ou retorna uma referência verifica se o contexto do referente é pelo menos tão amplo quanto o da própria referência. O padrão do C# resume isso em uma frase na [seção 9.7.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts): "The referent of a reference variable shall have a ref-safe-context that is at least as wide as the ref-safe-context of the reference variable itself."

Existe um conceito irmão, o safe-context, que se aplica a valores de tipos `ref struct` como `Span<T>`. O ref-safe-context responde "por quanto tempo uma referência a esta variável é válida?". O safe-context responde "por quanto tempo o valor armazenado nesta variável (que por sua vez contém referências) é válido?". A maior parte deste post trata do primeiro, mas os dois se encontram nos indexadores de `Span<T>`, o que é abordado mais adiante.

## Os quatro contextos, do mais estreito ao mais amplo

| Contexto | Quem o tem | Pode ser retornado com ref? |
| --- | --- | --- |
| declaration-block | Locais comuns, com escopo no bloco em que são declarados | Não |
| function-member | Parâmetros por valor, parâmetros `out`, `this` em um método de struct, `scoped ref` locais e parâmetros | Não |
| return-only | Parâmetros `ref` e `in` | Sim, somente via `return ref` |
| caller-context | Elementos de array, campos de instâncias de classe, campos estáticos, campos acessados por parâmetros `ref` | Sim |

Dois detalhes passam facilmente despercebidos. Primeiro, declaration-block é realmente por bloco: um local declarado dentro do corpo de um `if` tem um contexto mais estreito do que um declarado no topo do método. Segundo, return-only existe para que um parâmetro `ref` possa ser retornado (`return ref p;` é válido), mas não possa ser armazenado em algum lugar que sobreviva à chamada, como um `ref` field de um `ref struct` passado pelo chamador. Esse nível foi adicionado no C# 11 como parte das [melhorias de structs de baixo nível](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements).

Aqui está a base em código, com todos os métodos compilados em C# 14:

```csharp
// .NET 10 SDK 10.0.302, C# 14 (same result on .NET 11 RC1)
class Contexts
{
    int[] _arr = new int[10];
    static int s_counter;

    // declaration-block: error CS8168
    static ref int FromLocal() { int v = 5; return ref v; }

    // function-member (value parameter): error CS8157 once aliased
    static ref int FromValueParam(int p) { ref int r = ref p; return ref r; }

    // return-only (ref parameter): OK
    static ref int FromRefParam(ref int p) { ref int r = ref p; return ref r; }

    // caller-context (array element): OK
    ref int FromArray() { ref int r = ref _arr[3]; return ref r; }

    // caller-context (static field): OK
    static ref int FromStatic() { ref int r = ref s_counter; return ref r; }
}
```

Os dois erros:

```text
error CS8168: Cannot return local 'v' by reference because it is not a ref local
error CS8157: Cannot return 'r' by reference because it was initialized to a value that cannot be returned by reference
```

Leia com atenção a redação do CS8157: "because it was initialized to". O compilador não olha para o que `r` aponta no momento do `return`. Ele olha para aquilo com que `r` foi inicializado.

## Como um ref local recebe seu contexto

A regra do padrão para locais ([seção 9.7.2.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9722-local-variable-ref-safe-context)) tem duas linhas:

- Se `v` é uma variável de referência, seu ref-safe-context é o mesmo do ref-safe-context da sua expressão de inicialização.
- Caso contrário, seu ref-safe-context é declaration-block.

Portanto, o compilador decide o contexto de um `ref` local em exatamente um lugar: a declaração. O contexto da expressão inicializadora é avaliado com estas regras:

1. Um local ou um parâmetro por valor: seu próprio contexto (declaration-block ou function-member).
2. Um parâmetro `ref` ou `in`: return-only.
3. Um campo `e.F` de uma instância de classe, um elemento de array, um campo estático: caller-context.
4. Um campo `e.F` de um struct: o contexto de `e`. Um campo de um struct local é declaration-block; um campo de `this` dentro de um método de struct é function-member.
5. Um condicional `c ? ref a : ref b`: o mais estreito entre `a` e `b`.
6. Uma chamada a método, propriedade ou indexador que retorna `ref`: o mais estreito entre caller-context e o ref-safe-context de cada argumento `ref` (mais o safe-context de cada argumento, receptor incluído), ignorando os argumentos associados a parâmetros `scoped` e `out`.

A regra 6 é a que surpreende as pessoas, porque significa que um helper perfeitamente inocente pode contaminar um `ref` local:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int Pick(ref int a) => ref a;

static ref int ThroughHelper()
{
    int v = 5;
    ref int r = ref Pick(ref v); // r inherits v's declaration-block context
    return ref r;                // error CS8157
}
```

O `Pick` em si está correto, ele retorna o próprio parâmetro `ref`. Mas o compilador não olha dentro de `Pick`. Ele vê apenas a assinatura: "retorna um `ref` que pode ser qualquer um dos meus argumentos `ref`", então o contexto do resultado é o do argumento mais estreito, e esse argumento é um local. É assim que a especificação impede a lavagem de uma referência da pilha por meio de uma chamada de método.

A saída, quando o helper realmente nunca retorna aquele argumento, é dizer isso com `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int PickSecond(scoped ref int a, ref int b) => ref b;

static ref int Fine(ref int b)
{
    int v = 5;
    ref int r = ref PickSecond(ref v, ref b); // only b contributes: return-only
    return ref r;                             // OK
}
```

Um parâmetro `scoped ref` não pode ser retornado nem capturado pelo método chamado, então ele deixa de contribuir para o contexto do resultado. O operador condicional não tem essa válvula de escape:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Either(bool f)
{
    int v = 1;
    ref int r = ref f ? ref _arr[0] : ref v; // narrowest wins: declaration-block
    return ref r;                            // error CS8157
}
```

## A reatribuição de ref não pode ampliar nem reduzir

Desde o C# 7.3, um `ref` local pode ser apontado para outro lugar com `r = ref other;`. A regra da [seção 9.7.2.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9729-limitations-on-reference-variables) é: "For a ref reassignment `e1 = ref e2`, the ref-safe-context of `e2` shall be at least as wide a context as the ref-safe-context of `e1`." O contexto do local não muda em consequência disso. Isso tem implicações nos dois sentidos.

**Reduzir é um erro.** Inicialize a partir de um elemento de array e depois tente apontar para um local:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Narrowing()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    return ref r;
}
```

```text
error CS8374: Cannot ref-assign 'v' to 'r' because 'v' has a narrower escape scope than 'r'.
```

A mesma coisa acontece entre blocos aninhados, que é a versão que as pessoas encontram em loops reais:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static void NestedBlock()
{
    int outer = 1;
    ref int r = ref outer;   // declaration-block of the method body
    {
        int inner = 2;
        r = ref inner;       // error CS8374: inner's block is narrower
    }
}
```

**Ampliar é permitido, mas não ajuda.** Inicialize a partir de um local e depois aponte para um elemento de array. A reatribuição compila. O return não:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Widening()
{
    int v = 1;
    ref int r = ref v;   // declaration-block, fixed forever
    r = ref _arr[0];     // OK: caller-context is wider
    return ref r;        // error CS8157: r was *initialized* to a local
}
```

Isso é insensível ao fluxo de propósito. O compilador não rastreia que `r` por acaso aponta para o heap neste momento. Ele só conhece o contexto declarado, e esse é declaration-block.

**A armadilha do return-only.** Um parâmetro `ref` é return-only, o que é mais estreito do que caller-context. Por isso o código abaixo falha, com um código de erro diferente:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int FieldThenParam(ref int p)
{
    ref int r = ref _arr[0]; // caller-context
    r = ref p;               // error CS9079
    return ref r;
}
```

```text
error CS9079: Cannot ref-assign 'p' to 'r' because 'p' can only escape the current method through a return statement.
```

Tanto `_arr[0]` quanto `p` podem ser retornados individualmente, mas a combinação é rejeitada. A correção em todos esses casos é a mesma: inicialize o `ref` local com o referente **mais estreito** que ele vai conter, e só depois reatribua a outros mais amplos.

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ParamThenField(ref int p, bool useField)
{
    ref int r = ref p;               // return-only
    if (useField) r = ref _arr[0];   // caller-context is wider: OK
    return ref r;                    // OK: return-only is returnable
}
```

## `scoped ref` locais: optando por um contexto mais estreito

Você também pode reduzir um `ref` local deliberadamente. Declará-lo como `scoped ref` dá a ele o contexto function-member, independentemente do inicializador:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ScopedLocal()
{
    scoped ref int r = ref _arr[0]; // function-member, despite caller-context initializer
    return ref r;                   // error CS8157
}
```

Isoladamente isso parece inútil. A vantagem aparece quando o local é reatribuído depois a algo mais estreito. Compare os dois métodos abaixo, que diferem apenas pela palavra-chave `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
void Unscoped()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    r = 5;
}

void Scoped()
{
    scoped ref int r = ref _arr[0]; // function-member
    int v = 1;
    r = ref v;                      // OK: v's block is the method body
    r = 5;
}
```

Pense em `scoped` como a forma documentada de dizer "esta referência nunca sai do método", o que libera reatribuições que o contexto inferido proibiria. A mesma palavra-chave em um local `ref struct` (`scoped Span<int> s`) reduz o seu safe-context, o que impede que seu conteúdo escape.

## Structs, `this` e `[UnscopedRef]`

Dentro de um método de instância de struct, `this` é um parâmetro `scoped ref` implícito, então seu contexto é function-member, assim como o de todos os seus campos (regra 4). É por isso que um struct não pode retornar por ref o seu próprio campo:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

struct Counter
{
    int _n;

    public ref int Bad() => ref _n;                 // error CS8170
    [UnscopedRef] public ref int Good() => ref _n;  // OK: this widened to return-only

    static ref int UseGood()
    {
        Counter c = default;
        ref int r = ref c.Good(); // receiver c is a local: declaration-block
        return ref r;             // error CS8157
    }
}
```

```text
error CS8170: Struct members cannot return 'this' or other instance members by reference
```

`[UnscopedRef]` amplia `this` em um nível, de function-member para return-only, o que basta para `return ref _n`. Mas isso não torna o resultado seguro para o heap. No ponto de chamada, `c.Good()` é uma chamada que retorna `ref` e cujo receptor é passado por `ref`, então a regra 6 se aplica e o resultado herda o contexto declaration-block do local `c`. A referência retornada dura tanto quanto o struct para o qual aponta, o que é precisamente o correto.

## Spans: onde o ref-safe-context encontra o safe-context

`Span<T>` tem um indexador que retorna `ref`, então `ref span[i]` também segue a regra 6. O receptor contribui com o seu **safe-context**, e o safe-context de um span depende de onde veio a sua memória:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int FromStackSpan()
{
    Span<int> local = stackalloc int[4]; // safe-context: function-member
    ref int r = ref local[0];
    return ref r;                        // error CS8157
}

static ref int FromHeapSpan()
{
    Span<int> local = new int[4];        // safe-context: caller-context
    ref int r = ref local[0];
    return ref r;                        // OK
}
```

Os dois métodos são idênticos, exceto pelo inicializador de `local`, e só um compila. Um parâmetro span tem safe-context caller-context, o que torna válido, sem nenhuma anotação, o clássico padrão "encontrar o elemento por referência":

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int MaxRef(Span<int> values)
{
    ref int best = ref values[0];        // caller-context via the span parameter
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i]; // same context: OK
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

Toda reatribuição dentro do loop vem do mesmo span, então o contexto nunca entra em conflito. Esse é o formato a buscar: uma fonte, um contexto, reatribua à vontade.

## Como interpretar os códigos de erro

Quando você se deparar com um deles, o código indica de que lado a regra falhou:

1. **CS8168** ("not a ref local"): você tentou `return ref` em um local comum ou em um parâmetro por valor. Retorne o valor, ou mova o armazenamento para o heap.
2. **CS8157** ("was initialized to a value that cannot be returned"): o inicializador do `ref` local tinha um contexto mais estreito do que return-only. Olhe para o inicializador, não para a reatribuição mais recente. Verifique se chamadas a helpers recebem argumentos `ref` locais e marque como `scoped` os parâmetros que não escapam.
3. **CS8374** ("narrower escape scope"): uma reatribuição tentou reduzir o local. Inicialize primeiro com o referente mais estreito, ou declare o local no mesmo bloco do referente.
4. **CS9079** ("can only escape the current method through a return statement"): o caso especial do CS8374 em que o novo referente é um parâmetro `ref` ou `in` (return-only) e o local era caller-context. Inicialize a partir do parâmetro.
5. **CS8170**: um struct está retornando um ref para o seu próprio campo. Adicione `[UnscopedRef]` se os chamadores puderem conviver com o resultado ficando atrelado ao tempo de vida do próprio struct.

## Armadilhas que vale conhecer

- `ref` locais não podem ser capturados por lambdas ou funções locais, e não podem estar vivos através de um `await` ou `yield return`. Essa é uma restrição separada da seção 9.7.2.9, não um erro de contexto, mas costuma aparecer na mesma refatoração.
- Parâmetros `out` são implicitamente `scoped ref` sob as regras de ref safety do C# 11, então `return ref outParam;` falha com `error CS9075: Cannot return a parameter by reference 'o' because it is scoped to the current method`, mesmo que `return ref refParam;` funcione. Reduzir o `<LangVersion>` não traz de volta o comportamento antigo: com `<LangVersion>10</LangVersion>` em um projeto `net10.0` obtive o mesmo CS9075, porque o compilador aplica as novas regras sempre que o runtime de destino suporta `ref` fields. Marque o parâmetro como `[UnscopedRef] out int o` se você realmente precisar disso.
- Parâmetros `in` são return-only como os parâmetros `ref`, mas apenas como `ref readonly`. O [post sobre parâmetros `ref readonly`](/pt-br/2023/10/csharp-ref-readonly-parameters/) cobre quando escolher cada um.
- O compilador é conservador. A regra 6 assume que um método que retorna `ref` pode retornar qualquer um de seus argumentos `ref`. Se o seu método não faz isso, `scoped` não é uma gambiarra, é o contrato correto e documentado.
- Código unsafe não participa. Dentro de blocos `unsafe` você pode obter ponteiros para locais e o compilador não rastreia o tempo de vida deles. O [redesenho do `unsafe` no C# 16 como contrato do chamador](/pt-br/2026/05/csharp-16-unsafe-keyword-caller-contract/) trata de tornar essa fronteira explícita.

## Relacionados

- Se os spans em si são novidade para você, comece por [o que é `Span<T>` e quando ele realmente deixa o código mais rápido](/pt-br/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).
- Para escolher o formato de uma coleção antes de se preocupar com tempos de vida, veja [List vs Span vs ReadOnlySpan em C#](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).
- O C# 14 também mudou a forma como os spans são associados; [a breaking change de resolução de overload com spans](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) explica as surpresas com `MemoryExtensions`.
- [Conversões implícitas de span no C# 14](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) cobre as conversões mais novas no nível da linguagem, que permitem que arrays fluam para parâmetros span como o de `MaxRef` acima em mais situações, incluindo receptores de métodos de extensão.

## Fontes

- [C# standard, section 9.7.2 Ref safe contexts](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts), incluindo 9.7.2.2 (locais), 9.7.2.6 (invocação de função) e 9.7.2.9 (reatribuição de ref).
- [C# standard, section 9.7.3 The scoped modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#973-the-scoped-modifier).
- [Low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements), a proposta do C# 11 que introduziu return-only, `scoped` e `[UnscopedRef]`.
- [Reference variables](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables) e [`ref` structure types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct) na referência da linguagem C#.
