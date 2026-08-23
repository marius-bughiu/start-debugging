---
title: "Como escrever um membro de extensão estático que se aplica a todos os tipos enum em C# 14"
description: "Declare um bloco extension genérico com a restrição struct, Enum e você ganha Status.Values, Status.Count e Status.Parse em cada enum da sua solução. O formato do receptor, as armadilhas CS0704 e CS0428, e por que você precisa cachear Enum.GetValues."
pubDate: 2026-08-23
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
  - "enums"
lang: "pt-br"
translationOf: "2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-08-23
---

C# 14 permite escrever um único bloco `extension` que adiciona membros estáticos a *todos* os tipos enum de uma vez. O formato é `extension<TEnum>(TEnum) where TEnum : struct, Enum`, declarado dentro de uma classe estática não genérica, com o nome do parâmetro receptor omitido porque os membros são estáticos. Isso te dá `Status.Values`, `Status.Count` e `Status.Parse("active")` em cada enum da sua solução sem escrever uma linha por enum. Tudo abaixo foi compilado e executado com o SDK do .NET 10.0.201 sobre o runtime 10.0.5.

O detalhe é que três coisas distintas vão te morder: o parâmetro de tipo é inalcançável de dentro de um método genérico, qualquer nome de membro que `System.Enum` já possua fica oculto silenciosamente, e a implementação óbvia aloca um novo array a cada chamada.

## Por que o receptor precisa ser `TEnum`, e não `Enum`

O instinto é escrever `extension(Enum)` e pronto, já que todo enum deriva de `System.Enum`. Isso compila, e até resolve a partir do nome de um tipo enum concreto:

```csharp
// .NET 10, C# 14 -- compiles and runs, but is a dead end
public static class B
{
    extension(Enum)
    {
        public static string Label => "Label:System.Enum";
    }
}

// both of these print "Label:System.Enum"
Console.WriteLine(Status.Label);
Console.WriteLine(Enum.Label);
```

Membros de extensão estáticos declarados no tipo base realmente são alcançáveis pelo nome de um enum derivado. Mas não há parâmetro de tipo nesse bloco, então você não consegue chamar nenhuma das APIs genéricas de `Enum`. `Enum.GetValues<TEnum>()`, `Enum.Parse<TEnum>` e `Enum.TryParse<TEnum>` são exatamente as APIs que você quer, e todas precisam de um `TEnum`. Sem ele você volta à reflexão sobre `typeof`, fazendo boxing de cada valor para `object`.

Então o receptor precisa carregar o parâmetro de tipo. O instinto seguinte é `where TEnum : Enum`, que também compila até você realmente usá-lo:

```csharp
extension<TEnum>(TEnum) where TEnum : Enum
{
    public static TEnum[] Values => Enum.GetValues<TEnum>();
}
```

```
error CS0453: The type 'TEnum' must be a non-nullable value type in order to use it
as parameter 'TEnum' in the generic type or method 'Enum.GetValues<TEnum>()'
```

`Enum` como restrição permite o próprio `System.Enum`, que é um tipo de referência abstrato. Os auxiliares genéricos de `Enum` são todos restritos a `struct, Enum`, então seu bloco precisa corresponder. Isso deixa exatamente um formato que funciona.

## Declare o bloco em três passos

1. **Crie uma `static class` de nível superior e não genérica.** Blocos `extension` só são legais ali. O nome da classe nunca aparece no ponto de chamada, então escolha algo descritivo como `EnumExtensions`.
2. **Escreva `extension<TEnum>(TEnum) where TEnum : struct, Enum` e omita o nome do parâmetro receptor.** O MS Learn é explícito: "the extension parameter doesn't need to include the parameter name if the only members are static". Remover o nome é o que sinaliza que este bloco contém membros estáticos; um receptor nomeado é para membros de instância.
3. **Declare membros `public static` dentro do bloco.** Eles se vinculam ao enum concreto que você nomeia no ponto de chamada, então `TEnum` é inferido como `Status` quando você escreve `Status.Values`.

```csharp
// .NET 10, C# 14
public static class EnumExtensions
{
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static TEnum[] Values => Enum.GetValues<TEnum>();
        public static int Count => Enum.GetValues<TEnum>().Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status { Draft = 1, Active = 2, Archived = 4 }
public enum Color { Red, Green, Blue }

Console.WriteLine(Status.Count);              // 3
Console.WriteLine(string.Join(",", Status.Values));  // Draft,Active,Archived
Console.WriteLine(Color.Parse("green"));      // Green
Console.WriteLine(Color.TryParse("BLUE", out var c));  // True
```

Um único bloco, e cada enum da compilação ganhou quatro membros estáticos. Esse é todo o ganho, e é a parte que genuinamente não era expressável antes do C# 14. Se você quiser revisar o recurso ao redor, a [visão geral dos membros de extensão do C# 14](/pt-br/2026/02/csharp-14-extension-members/) cobre operadores e os casos não genéricos, e [declarar propriedades de extensão](/pt-br/2026/06/how-to-declare-extension-properties-in-csharp-14/) aprofunda nas regras específicas de propriedades.

## O que o compilador realmente emite

Blocos `extension` não são um recurso de runtime. Tudo é reduzido a métodos estáticos comuns na classe estática que os contém, mais um tipo marcador gerado pelo compilador que carrega os metadados da extensão. Usar reflexão sobre a classe em tempo de execução mostra isso:

```
--- emitted members on EnumExtensions ---
  NestedType <G>$1AEBB925A470955AA56007A9C9196757`1
  Method   get_Count
  Method   get_Values
  Method   Parse
  Method   TryParse
```

O tipo aninhado `<G>$<hash>` é o tipo de agrupamento que o compilador usa para registrar o receptor e suas restrições. Os membros em si são métodos estáticos planos, e é por isso que blocos `extension` são compatíveis em nível binário com os antigos métodos de extensão com parâmetro `this` e por isso não há custo de despacho em tempo de execução.

Essa emissão plana tem uma consequência direta, e é a primeira coisa que vai te surpreender.

## Um bloco `extension` não é um escopo

O MS Learn enuncia a regra sem rodeios: "An extension doesn't introduce a scope for member declarations. All members declared in a single class, even if in multiple extensions, must have unique signatures." Então um membro de instância e um estático com o mesmo nome colidem mesmo vivendo em blocos diferentes:

```csharp
public static class E2
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Tag => "instance";
    }
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static string Tag => "static";   // CS0102
    }
}
```

```
error CS0102: The type 'E2' already contains a definition for 'Tag'
```

Separe-os em duas classes estáticas e a colisão se move para o ponto de chamada, onde o C# 14 tem um diagnóstico dedicado:

```
error CS9339: The extension resolution is ambiguous between the following members:
'C1.extension<Status>(Status).Count' and 'C2.extension<Status>(Status).Count'
```

Vale reconhecer o CS9339 de imediato, porque um bloco enum genérico se aplica a todos os enums em escopo. Duas bibliotecas que ambas entreguem uma extensão `Values` vão colidir em cada enum que você possui, e nenhuma das duas tem culpa. A mesma família de problemas aparece quando você move um método de extensão no estilo antigo para dentro de um bloco e esquece de apagar o original, o que produz [a ambiguidade CS0121 após migrar para membros de extensão](/pt-br/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/).

## `TEnum.Values` não compila dentro de um método genérico

Esta é a que custa mais tempo. O membro de extensão resolve bem contra um nome de enum concreto, mas não contra um parâmetro de tipo:

```csharp
public static int CountOf<TEnum>() where TEnum : struct, Enum
{
    return TEnum.Values.Length;   // CS0704
}
```

```
error CS0704: Cannot do non-virtual member lookup in 'TEnum' because it is a type parameter
```

Membros de extensão estáticos são resolvidos por busca de nome sobre um tipo, e um parâmetro de tipo não é um tipo para esse fim. Apenas membros de interface `static` *abstract* participam da busca de membros através de um parâmetro de tipo, e membros de extensão não são membros de interface. Não existe sintaxe que conserte isso.

A resposta prática é manter a implementação real em uma classe auxiliar genérica comum e deixar o bloco `extension` ser uma fachada fina sobre ela. Código genérico chama o auxiliar diretamente; código de aplicação chama o membro de extensão bonito. Essa divisão também é o que resolve o problema de alocação abaixo, então você ganha de graça.

## `Enum.GetValues<TEnum>()` aloca um novo array a cada chamada

`Enum.GetValues<TEnum>()` devolve um `TEnum[]` novo toda vez, porque entregar um array mutável em cache deixaria qualquer chamador corrompê-lo. Uma propriedade que o chama a cada acesso transforma uma consulta em uma alocação. Medido no runtime 10.0.5, build Release, um milhão de acessos a um enum de cinco membros, indexando o resultado para que o JIT não possa içar a chamada para fora do laço:

| Implementação | Tempo | Alocado | Por operação |
| --- | --- | --- | --- |
| `Enum.GetValues<TEnum>()` por acesso | 27,8 ms | 48.000.832 bytes | 48 B |
| cache estático genérico | 0,7 ms | 0 bytes | 0 B |

48 bytes por operação são o cabeçalho do array mais cinco valores de 4 bytes, arredondado para o alinhamento. O número escala com o enum, então um enum de 30 membros custa mais. Ao longo de três execuções a versão sem cache mediu entre 26,8 ms e 29,5 ms, e a versão com cache 0,7 ms sempre.

A solução é uma classe genérica estática. O CLR te dá uma instância dos seus campos estáticos por tipo genérico fechado, então `EnumInfo<Status>` e `EnumInfo<Color>` recebem armazenamento separado, cada um inicializado exatamente uma vez no primeiro uso:

```csharp
// .NET 10, C# 14
internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();
}
```

`ImmutableArray<TEnum>` importa aqui em vez de `TEnum[]`: um array em cache entregue por uma propriedade é mutável por qualquer chamador, e um único `Values[0] = ...` envenena silenciosamente o cache para o processo inteiro. `FrozenSet` é o formato certo para verificações de pertencimento, já que paga um custo de construção maior uma vez em troca de leituras mais rápidas, que é exatamente o compromisso que um cache estático por tipo quer. O [benchmark de Dictionary vs FrozenDictionary](/pt-br/2024/04/net-8-performance-dictionary-vs-frozendictionary/) tem os números por trás dessa escolha.

## Nomes que `System.Enum` já possui ficam ocultos

Membros de extensão são um plano B. A busca de nomes encontra os membros reais primeiro, e só recorre às extensões quando nada aplicável existe. `System.Enum` já declara `IsDefined`, então um membro de extensão com esse nome nunca chega a ser considerado:

```csharp
extension<TEnum>(TEnum value) where TEnum : struct, Enum
{
    public bool IsDefined => Enum.IsDefined(value);
    public bool IsKnown => Enum.IsDefined(value);
}

Status s = Status.Active;
bool a = s.IsKnown;     // fine
bool b = s.IsDefined;   // CS0428
```

```
error CS0428: Cannot convert method group 'IsDefined' to non-delegate type 'bool'.
Did you intend to invoke the method?
```

O compilador encontrou o grupo de métodos `Enum.IsDefined` e parou de procurar. A mensagem de erro é ativamente enganosa, porque sugere que você esqueceu os parênteses quando o problema real é que sua propriedade de extensão está inalcançável por aquele nome. O mesmo acontece com membros de extensão estáticos: `Status.IsDefined` declarado como propriedade de extensão estática produz o CS0428 idêntico.

Note que isso é sobre nomes, não assinaturas. `GetValues` como *método* de extensão funciona bem:

```csharp
extension<TEnum>(TEnum) where TEnum : struct, Enum
{
    public static TEnum[] GetValues() => Enum.GetValues<TEnum>();  // compiles
}

Status[] all = Status.GetValues();   // resolves to your extension
```

`Enum.GetValues` existe, mas nenhuma sobrecarga dele é aplicável com zero argumentos, então a busca cai até a extensão. Depender disso é frágil. A regra segura é evitar todo nome que já esteja em `System.Enum`: `IsDefined`, `Parse`, `TryParse`, `GetName`, `GetNames`, `GetValues`, `GetUnderlyingType`, `Format`, `ToObject`, `HasFlag` e `CompareTo`. Escolher `Values`, `Count`, `Names` e `IsKnown` contorna a categoria inteira.

`Parse` e `TryParse` são as exceções incômodas, porque são os nomes que os chamadores esperam. Eles de fato resolvem atualmente, pela mesma razão de zero sobrecargas aplicáveis que `GetValues`. Se você quiser ser conservador, chame-os de `ParseName` e `TryParseName`.

## A armadilha da decomposição de `[Flags]`

Se você adicionar um membro que divide um valor de flags em suas partes, a implementação óbvia está errada para qualquer enum com um membro zero:

```csharp
[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Admin = Read | Write }

public ImmutableArray<TEnum> NaiveFlags =>
    [.. EnumInfo<TEnum>.Values.Where(f => value.HasFlag(f))];
```

```
naive : [None, Read, Write, Admin]
```

`HasFlag` é um teste de subconjunto, então `x.HasFlag(None)` é verdadeiro para todo `x`, e membros compostos como `Admin` também correspondem. Filtrar para membros de bit único conserta os dois problemas de uma vez:

```csharp
// .NET 10, C# 14 -- add to EnumInfo<TEnum>; needs using System.Numerics;
public static readonly ImmutableArray<TEnum> SingleBitFlags =
    [.. Enum.GetValues<TEnum>().Where(v =>
        BitOperations.PopCount(Convert.ToUInt64(v)) == 1)];

public ImmutableArray<TEnum> Flags =>
    [.. EnumInfo<TEnum>.SingleBitFlags.Where(f => value.HasFlag(f))];
```

```
fixed : [Read, Write]
none  : []
read  : [Read]
```

`Convert.ToUInt64` faz boxing, mas roda uma vez por tipo enum dentro do inicializador estático, não por chamada.

## A versão que vale a pena entregar

Juntando as peças: um auxiliar genérico segurando os caches, um bloco estático para os membros em nível de tipo, um bloco de instância para os membros em nível de valor, e nenhum nome que `System.Enum` já possua.

```csharp
// .NET 10, C# 14
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Reflection;

internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();

    public static readonly FrozenDictionary<TEnum, string> Descriptions =
        Enum.GetValues<TEnum>()
            .DistinctBy(v => v)
            .ToFrozenDictionary(
                v => v,
                v => typeof(TEnum).GetField(v.ToString())
                        ?.GetCustomAttribute<DescriptionAttribute>()?.Description
                     ?? v.ToString());
}

public static class EnumExtensions
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Description => EnumInfo<TEnum>.Descriptions[value];
        public bool IsKnown => EnumInfo<TEnum>.Defined.Contains(value);
    }

    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static ImmutableArray<TEnum> Values => EnumInfo<TEnum>.Values;
        public static int Count => EnumInfo<TEnum>.Values.Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status
{
    [Description("Not yet published")] Draft,
    [Description("Live")]              Active,
    Archived,
}
```

```
Status.Count      : 3
Status.Values     : [Draft, Active, Archived]
Description       : Not yet published
Description (none): Archived
IsKnown           : True / False
Parse             : Active
TryParse bad input: False
```

O `DistinctBy(v => v)` no construtor do dicionário não é decoração. `Enum.GetValues` devolve uma entrada por *membro*, e dois membros podem compartilhar um valor (`Alias = Active`), o que lançaria uma exceção de chave duplicada sem ele. Esse é o mesmo detalhe de alias que torna a persistência de enums complicada, coberto em [armazenar um enum como string no EF Core 11](/pt-br/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/).

A reflexão em `Descriptions` significa que esse padrão precisa de uma anotação de trimming se você publicar com trimming ou Native AOT habilitado. Remova o membro `Description` se você mira em qualquer um dos dois, ou alimente as strings a partir de um gerador de código-fonte.

Um limite que vale enunciar: membros de extensão são resolvidos em tempo de compilação contra um nome que você escreve no código-fonte. Se o seu tipo enum só é conhecido como um `Type` em tempo de execução, nada disso se aplica e você volta às APIs de reflexão não genéricas. Blocos `extension` tornam enums mais agradáveis de usar no código que você compila, não no código que você descobre.

## Fontes

- [Extension member declarations, C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension) no MS Learn, atualizado em 2026-08-13
- [C# 14: Exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) no blog do .NET
- Referência da API [Enum.GetValues&lt;TEnum&gt;()](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues)
- Referência da API [FrozenSet&lt;T&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.collections.frozen.frozenset-1)
