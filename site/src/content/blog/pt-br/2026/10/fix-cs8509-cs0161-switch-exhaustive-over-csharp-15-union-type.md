---
title: "Correção: CS8509 ou CS0161 em um switch exaustivo sobre um tipo union do C# 15"
description: "Faça o switch sobre o valor union, não sobre .Value, e use uma switch expression ou adicione case null a um switch statement. Statements exigem cobertura de null, enquanto expressions apenas emitem um aviso."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "pattern-matching"
lang: "pt-br"
translationOf: "2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type"
translatedBy: "claude"
translationDate: 2026-10-01
---

Faça o switch sobre o próprio valor union, não sobre a propriedade `.Value`, e prefira uma switch expression. Se você precisa de um switch statement em um método que retorna valor, adicione um braço `case null:` (ou um `throw` depois do switch): o compilador só trata um switch statement sobre um union como completo quando o `Value` nulo de um union `default` está coberto. Todo o comportamento abaixo foi medido no SDK do .NET 11 RC1 (`11.0.100-rc.1.26425.128`, C# 15, sem necessidade de sobrescrever `LangVersion`).

## O erro em contexto

Você declarou um union, correspondeu todos os tipos de caso, e mesmo assim o compilador diz que você não cobriu todos:

```text
warning CS8509: The switch expression does not handle all possible values of its input type (it is not exhaustive). For example, the pattern '_' is not covered.
error CS0161: 'Pets.Describe(Pet)': not all code paths return a value
error CS0165: Use of unassigned local variable 's'
warning CS8655: The switch expression does not handle some null inputs (it is not exhaustive). For example, the pattern 'null' is not covered.
error CS8780: A variable may not be declared within a 'not' or an 'or' pattern or a union matching involving matching against either the instance, or its underlying value.
```

São cinco sintomas diferentes do mesmo mal-entendido: a exaustividade de unions no C# 15 é uma propriedade da **correspondência de union**, e essa correspondência só entra em ação sob condições específicas. Fora dessas condições, você volta à correspondência de padrões comum sobre `object`, onde dois padrões de tipo nunca são exaustivos.

## Por que o compilador não enxerga seu switch como exaustivo

A [especificação de unions](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-exhaustiveness) do C# 15 diz isso em uma linha: presume-se que um tipo union é "exausto" pelos seus tipos de caso, então uma `switch` expression é exaustiva se tratar todos os tipos de caso do union. Todo o resto decorre das letras miúdas.

1. **A entrada precisa ser o valor union.** A correspondência de union só acontece "when the input value of a pattern is of a union type or of a nullable of a union type". Fazer o switch sobre `pet.Value` (do tipo `object?`) ou sobre um union que foi convertido para `object` não dá ao compilador nenhuma lista de casos, então ele pede `_`.
2. **Switch statements são mais rígidos que switch expressions.** Uma switch expression com um `null` não tratado compila com um aviso CS8655. Um switch statement usado para análise de atribuição definida ou de caminhos de retorno só conta como completo quando `null` também está coberto, então o fim do `switch` continua alcançável e você recebe CS0161 ou CS0165.
3. **O `Value` de um union sempre pode ser nulo.** `public union Pet(Cat, Dog)` é reduzido a um struct com `public object? Value { get; }`. `default(Pet)` contém `null`, e `new Pet((Cat)null!)` também. A especificação lista isso em [well-formedness](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#well-formedness): `Value` é "null or a value of a case type".
4. **Parâmetros de tipo não são desembrulhados.** Um tipo de caso `T` em `union Result<T>(T, Exception)` não pode ser correspondido com uma designação, porque o compilador não consegue provar se `T v` deve testar a instância do union ou o seu conteúdo. Isso é o CS8780.

## Reprodução mínima

```csharp
// .NET 11 RC1 SDK 11.0.100-rc.1.26425.128, C# 15, <Nullable>enable</Nullable>
public record Cat(string Name);
public record Dog(string Name);
public union Pet(Cat, Dog);
public union MaybePet(Cat?, Dog);
public union Result<T>(T, Exception);

static class Pets
{
    // OK: no diagnostics
    static string A(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: pattern '_' is not covered
    static string B(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

    // CS0161: not all code paths return a value
    static string Describe(Pet p)
    {
        switch (p)
        {
            case Cat c: return c.Name;
            case Dog d: return d.Name;
        }
    }

    // CS8655: pattern 'null' is not covered (Cat? is a nullable case type)
    static string D(MaybePet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: a union boxed into object is just an object
    static string E(object o) => o switch { Cat c => c.Name, Dog d => d.Name };

    // CS8655: Nullable<Pet> can be null
    static string F(Pet? p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8780 on 'TV v'
    static string I<TV>(Result<TV> r) => r switch { TV v => v!.ToString()!, Exception e => e.Message };
}
```

O método `A` é o ponto de referência: o valor union vai direto para uma switch expression, todo tipo de caso tem um braço, e o compilador fica em silêncio. Todos os outros métodos violam uma das quatro regras acima.

## A correção, em detalhes

Siga estes passos em ordem. O primeiro resolve a maioria dos relatos reais.

### 1. Corresponda o union, não `.Value`

`Value` é declarado como `object?`. No momento em que você o desreferencia, você descartou o tipo union e a sua lista de casos. A correspondência de padrões sobre o union já desembrulha o conteúdo para você: `p is Cat c` é compilado como um teste sobre `p.Value`, então não há motivo para recorrer a `.Value` por conta própria.

```csharp
// .NET 11 RC1, C# 15
// Before: CS8509
static string Name(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

// After: exhaustive, no default arm
static string Name(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };
```

O mesmo vale para um union que viaja por um `object`, um `IUnion` ou um parâmetro genérico `T`. Segundo a [questão resolvida](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#resolved-confirm-that-a-type-parameter-is-never-a-union-type-even-when-constrained-to-one) da especificação, um parâmetro de tipo nunca é um tipo union, mesmo quando restrito a um. No RC1, `static string L<TU>(TU u) where TU : struct, IUnion => u switch { Cat c => ..., Dog d => ... }` nem chega à exaustividade: falha com CS8121, "An expression of type 'TU' cannot be handled by a pattern of type 'Cat'". Mantenha o tipo union concreto na assinatura.

Uma exceção parcial: padrões de propriedade sobre `Value` passam a reconhecer o union no RC1. `r switch { { Value: TV v } => ..., { Value: Exception e } => ... }` produziu apenas CS8655, não CS8509. A especificação ainda lista "Should direct Value property matching follow Union rules?" como questão em aberto, então não construa nada em cima disso.

### 2. Prefira uma switch expression; dê a um switch statement um `case null`

Este é o caso do CS0161 / CS0165 e o mais surpreendente, porque os mesmos braços funcionam como expression. Medi três variantes no RC1:

```csharp
// .NET 11 RC1, C# 15
public union Pet(Cat, Dog);
public closed class Shape;
public sealed class Sq : Shape;
public sealed class Ci : Shape;

// error CS0161
static string S1(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; } }

// compiles
static string S2(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; case null: return "none"; } }

// compiles: bool is exhaustive for statements
static int S3(bool b) { switch (b) { case true: return 1; case false: return 0; } }

// error CS0161: closed hierarchies behave like unions here
static int S4(Shape s) { switch (s) { case Sq: return 1; case Ci: return 0; } }
```

`S3` prova que o compilador faz análise de exaustividade para switch statements. O que ele não faz é ignorar um `null` não coberto. Uma switch expression rebaixa o `null` ausente a um aviso de nullable (e, para um union cujos tipos de caso são todos não anuláveis, a nada). Um switch statement usa a resposta completa de exaustividade para a alcançabilidade, e essa resposta inclui `null`. Ativar `#nullable disable` não muda isso: o compilador do RC1 ainda reporta CS0161 tanto para o union quanto para a classe closed.

Você tem três correções limpas, em ordem de preferência:

```csharp
// .NET 11 RC1, C# 15
using System.Diagnostics;

// a) Use an expression. Most switch statements that only return can be one.
static string Describe(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

// b) Cover null explicitly. Use this when a default union is a legitimate state.
static string Describe2(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
        case null: return "no pet";
    }
}

// c) Keep the statement and declare the end unreachable.
static string Describe3(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
    }
    throw new UnreachableException();
}
```

Evite `default:` como correção. Ele compila, mas também engole o próximo tipo de caso que você adicionar ao union, que é justamente o diagnóstico que você queria manter.

A variante CS0165 é o mesmo problema em forma de atribuição: `string s; switch (p) { case Cat c: s = ...; break; case Dog d: s = ...; break; } return s;` falha porque o fim do switch é alcançável com `s` não atribuída. As mesmas três correções se aplicam.

### 3. Trate null onde o tipo diz que pode ser nulo

O CS8655 é o compilador tendo razão. Você o recebe em duas situações:

- Um dos tipos de caso é anulável, como em `union MaybePet(Cat?, Dog)`. A regra da especificação: o estado nulo padrão de `Value` é "maybe null" se algum tipo de caso for "maybe null".
- A entrada é `Pet?` (um `Nullable<Pet>`), que pode ser `null` por si só.

Adicione um braço `null`. Em um union, `null` corresponde tanto a uma instância nula quanto a um union cujo `Value` é nulo:

```csharp
// .NET 11 RC1, C# 15
static string D(MaybePet p) => p switch
{
    Cat c => c.Name,
    Dog d => d.Name,
    null => "none",
};
```

Se o tipo de caso anulável foi acidental, remova o `?` da declaração do union.

### 4. Remova a designação em tipos de caso que são parâmetros de tipo

Para `union Result<T>(T, Exception)`, o braço `T v` falha com CS8780 independentemente da restrição. Testei sem restrição, `where T : notnull`, `where T : class` e `where T : struct`: as quatro reportam CS8780 no RC1. O que funciona é um padrão de tipo sem variável, ou capturar o caso genérico por último com `var`:

```csharp
// .NET 11 RC1, C# 15
public union Result<T>(T, Exception);

// Exhaustive and clean with notnull: prints "v:5" for new Result<int>(5)
static string W4<TV>(Result<TV> r) where TV : notnull =>
    r switch { TV => "v:" + r.Value, Exception => "e" };

// Match the concrete case first, let var take the rest
static string W3<TV>(Result<TV> r) =>
    r switch { Exception e => e.Message, var other => other.Value!.ToString()! };
```

Sem a restrição `notnull`, a forma `TV =>` ainda compila, mas adiciona CS8655, porque `TV` poderia ser um tipo anulável. Observe que `var` não desembrulha um union: `other` é o `Result<TV>`, não o seu conteúdo, e por isso você lê `.Value` a partir dele.

## A metade do runtime: um union default ainda lança exceção

Silenciar o compilador não é o mesmo que tratar todos os valores. Um union cujos tipos de caso são todos não anuláveis não gera aviso quando você faz o switch sobre `default`:

```csharp
// .NET 11 RC1, C# 15
public union Result2(int, Exception);

static string Show(Result2 r) => r switch { int v => v.ToString(), Exception e => e.Message };

Show(default); // System.Runtime.CompilerServices.SwitchExpressionException at runtime
```

A questão resolvida da especificação "Default nullable state of `Value` property" reconhece que `default(U).Value` é `null` enquanto a análise de nullable olha apenas para os tipos de caso. Na prática, um union default aparece quando é um campo que nunca foi atribuído, um elemento de array, um retorno `default` em código genérico, ou um payload desserializado que não preencheu o union. Se algum desses caminhos existe, adicione o braço `null` mesmo que o compilador não peça, ou valide na fronteira. O mesmo raciocínio vale para [propriedades não anuláveis que nunca são definidas em um construtor](/pt-br/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): a anotação descreve uma intenção, não uma garantia em tempo de execução.

## Pegadinhas e erros parecidos

- **CS8846** ("However, a pattern with a 'when' clause might successfully match this value") significa que um tipo de caso só é coberto sob uma cláusula `when`. Adicione um braço sem guarda para esse tipo. Não é um bug de union.
- **CS8509 citando um tipo concreto**, como "the pattern 'Dog' is not covered", é a versão honesta do erro: você realmente está sem um tipo de caso. Este é o diagnóstico que dispara por toda parte quando alguém adiciona um caso a um union compartilhado, e o motivo para evitar braços `default` e `_`.
- **Tipos de caso que são interfaces ou classes base** são exauridos por esse tipo, não pelos seus subtipos. Para `union Shape(IShape, string)`, braços para `Circle` e `Square` não cobrem `IShape`. Se você quer exaustividade por subtipos, faça da base uma [hierarquia de classes closed](/pt-br/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/) e adicione-a como tipo de caso.
- **Previews antigas.** Se você ainda está no .NET 11 Preview 2 com tipos `UnionAttribute` e `IUnion` declarados à mão, como descrito no [anúncio original dos tipos union](/pt-br/2026/04/csharp-15-union-types-dotnet-11-preview-2/), os diagnósticos de exaustividade mudaram entre as previews. Atualize para o RC1 antes de investigar qualquer um dos erros acima.
- **Analisadores e código gerado.** Código que recebe unions como `object`, como um conversor JSON ou um model binder, se enquadra na regra 1. O comportamento de serialização e de binding está coberto em [serializar tipos union do C# com System.Text.Json](/pt-br/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) e [onde o binding de union funciona no ASP.NET Core 11](/pt-br/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/).

## Veja também

- [Os tipos union do C# 15 chegaram](/pt-br/2026/04/csharp-15-union-types-dotnet-11-preview-2/) para a sintaxe de declaração e as conversões implícitas.
- [Hierarquias de classes closed do C# 15](/pt-br/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/), que compartilham o comportamento de switch statement medido acima.
- [Serializando tipos union do C# com System.Text.Json](/pt-br/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) para unions que cruzam uma fronteira de rede.
- [Retornando múltiplos valores de um método em C#](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) se você está comparando um union `Result<T>` com tuplas ou parâmetros out.
- [Correção do CS8618 para propriedades não anuláveis](/pt-br/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) para o lado da análise de nullable da mesma história.

## Fontes

- [Especificação de unions do C# 15 (csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md): correspondência de union, exaustividade, nullability, redução e as questões resolvidas citadas acima.
- [Referência de tipos union no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union).
- [Avisos de correspondência de padrões, incluindo CS8509, CS8655 e CS8846](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/pattern-matching-warnings).
- Todos os diagnósticos e resultados de runtime reproduzidos localmente com o SDK do .NET 11 RC1 `11.0.100-rc.1.26425.128` no macOS, `net11.0`, `<Nullable>enable</Nullable>`.
