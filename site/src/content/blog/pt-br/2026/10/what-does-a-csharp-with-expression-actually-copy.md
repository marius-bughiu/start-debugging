---
title: "O que uma expressão `with` do C# realmente copia, e por que as propriedades calculadas de um record não são recalculadas?"
description: "Uma expressão with chama o método <Clone>$ gerado pelo compilador para o record, que executa um construtor de cópia que copia todos os campos de instância e ignora todos os inicializadores. É por isso que propriedades inicializadas a partir de outras propriedades, valores em cache e IDs Guid ficam desatualizados. Medido no .NET 10 com C# 14, com as correções que realmente funcionam."
pubDate: 2026-10-16
tags:
  - "csharp"
  - "csharp-14"
  - "records"
  - "dotnet-10"
  - "immutability"
lang: "pt-br"
translationOf: "2026/10/what-does-a-csharp-with-expression-actually-copy"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Resposta curta:** no C# 14 no .NET 10 (e em todas as versões desde que os records chegaram no C# 9), `a with { X = 1 }` em uma classe record faz duas coisas: chama o método `<Clone>$` gerado pelo compilador, que chama o construtor de cópia do record, e depois executa os acessores `init` que você listou, em ordem. O construtor de cópia copia **todos os campos de instância** byte a byte (uma cópia rasa) e **não** executa nenhum inicializador de campo ou de propriedade. Então uma propriedade como `public string FullName { get; } = $"{First} {Last}";` é calculada uma vez no construtor do original, copiada como um valor armazenado e nunca recalculada. Faça os valores derivados usarem corpo de expressão (`=> $"{First} {Last}"`), ou redefina os caches dentro dos acessores `init` das propriedades das quais eles dependem.

O restante deste post mostra exatamente o que o compilador gera, quais tipos de membros "calculados" sobrevivem a um `with` e quais não, um efeito colateral desagradável na igualdade ao usar cache dentro de um record, e os padrões que se sustentam. Todas as saídas abaixo vêm de aplicativos baseados em arquivo (`dotnet run probe.cs`) no SDK 10.0.302, runtime 10.0.10.

## O que o compilador gera para um record

Pegue um record posicional simples:

```csharp
// .NET 10, C# 14
record Person(string First, string Last);
```

Além do construtor primário, das propriedades, da igualdade e do `ToString`, o compilador emite dois membros de cópia. A [especificação de records](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members) os chama de "construtor de cópia" e método "clone". Você pode ver os dois com reflection:

```csharp
// .NET 10, C# 14
using System.Reflection;

foreach (var m in typeof(Person).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                .Where(m => m.Name.Contains("Clone")))
    Console.WriteLine($"method: {m.Name} virtual={m.IsVirtual} returns {m.ReturnType.Name}");

foreach (var c in typeof(Person).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
    Console.WriteLine($"ctor: ({string.Join(",", c.GetParameters().Select(p => p.ParameterType.Name))}) protected={c.IsFamily}");
```

Saída:

```text
method: <Clone>$ virtual=True returns Person
ctor: (String,String) protected=False
ctor: (Person) protected=True
```

`<Clone>$` é um nome que você não consegue digitar em C#, então só o compilador pode chamá-lo. Seu corpo é simplesmente `return new Person(this);`. O construtor protegido `Person(Person original)` é onde a cópia acontece, e a especificação é precisa sobre o que ele faz: depois de chamar o construtor de cópia da base (ou `object()`), ele "copia os valores de todos os campos de instância declarados implícita ou explicitamente no tipo record" e "não executa nenhum inicializador de campo/propriedade de instância presente na declaração do record".

Então isto:

```csharp
var b = a with { First = "Grace" };
```

é reduzido (lowered) a algo como:

```csharp
var tmp = a.<Clone>$();   // new Person(a): field-by-field copy, no initializers
tmp.First = "Grace";       // the init accessor, legal here because the compiler emits it
var b = tmp;
```

Duas consequências saem direto dessa redução. Primeiro, nada do que você escreveu no corpo do record é executado durante a cópia, exceto os acessores `init` dos membros que você nomeia. Segundo, esses acessores `init` rodam depois da cópia, sobre uma instância que já contém todos os campos do original.

## Quatro formas de escrever uma propriedade "calculada", quatro resultados diferentes

Aqui está um record com quatro membros que parecem todos derivar de `First` e `Last`:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string Init { get; } = $"{First} {Last}";   // property initializer
    public string Expr => $"{First} {Last}";            // expression-bodied
    private string? _cached;
    public string Cached => _cached ??= $"{First} {Last}"; // lazy cache in a field
}
```

E uma execução que toca o cache antes de copiar:

```csharp
var a = new Name("Ada", "Lovelace");
Console.WriteLine(a.Cached);              // fills the cache on a
var b = a with { First = "Grace" };
Console.WriteLine($"{b.Init} | {b.Expr} | {b.Cached}");
Console.WriteLine(b);
```

Saída:

```text
Ada Lovelace
Ada Lovelace | Grace Lovelace | Ada Lovelace
Name { First = Grace, Last = Lovelace, Init = Ada Lovelace, Expr = Grace Lovelace, Cached = Ada Lovelace }
```

Apenas a propriedade com corpo de expressão está correta. Os motivos correspondem um a um à redução acima:

- **`Init { get; } = ...`** é sustentada por um campo de apoio oculto `<Init>k__BackingField`. O inicializador rodou uma vez, dentro do construtor primário de `a`. O construtor de cópia copiou o campo de apoio como uma string e não executou o inicializador de novo. `First` mudou depois, mas nada jamais reatribui `Init`.
- **`Expr => ...`** não tem campo de apoio. É um método que lê `First` e `Last` a cada chamada, então reflete o que a cópia contém agora.
- **`Cached => _cached ??= ...`** é a mais sutil. Se você chamar `with` *antes* de alguém ler `Cached` no original, `_cached` ainda é `null`, é copiado como `null`, e a cópia calcula o valor correto. Se o cache do original já estiver preenchido, a cópia herda `"Ada Lovelace"` e o `??=` nunca dispara. O bug depende de algum caminho de código não relacionado ter lido a propriedade antes, o que o torna péssimo de reproduzir.

A mesma coisa acontece com qualquer coisa que um inicializador de campo produza. Um record com `public Guid Id { get; } = Guid.NewGuid();` mantém o **mesmo** `Id` em toda cópia feita com `with`. Confirmei que o inicializador simplesmente não é executado, usando um contador:

```csharp
// .NET 10, C# 14
var t = new Tracked("x");
var t2 = t with { Value = "y" };
Console.WriteLine($"initializer runs: {Counter.Count}, stamp same: {t.Stamp == t2.Stamp}");

static class Counter { public static int Count; }
record Tracked(string Value)
{
    public long Stamp { get; } = ++Counter.Count;
}
```

```text
initializer runs: 1, stamp same: True
```

Uma construção, uma execução do inicializador, duas instâncias. Se você usa records para eventos ou comandos com um ID ou timestamp gerado, o `with` entrega um segundo objeto afirmando ser o mesmo evento.

## A armadilha da igualdade: campos ocultos participam do `==`

A igualdade de record também é sintetizada a partir dos campos de instância, e isso inclui os privados. A cópia desatualizada acima, portanto, não é igual a um record recém-construído com os mesmos dados visíveis:

```csharp
var c = new Name("Grace", "Lovelace");
Console.WriteLine(b == c); // False: b.Init and b._cached still say "Ada Lovelace"
```

Pior, um cache preguiçoso faz a igualdade depender do *histórico de leitura*, mesmo sem nenhum `with`:

```csharp
// .NET 10, C# 14
var x = new Name2("Ada", "Lovelace");
var y = new Name2("Ada", "Lovelace");
Console.WriteLine(x == y);   // True
_ = x.FullName;              // only reads a property
Console.WriteLine(x == y);   // False

record Name2(string First, string Last)
{
    private string? _fullName;
    public string FullName => _fullName ??= $"{First} {Last}";
}
```

```text
True
False
```

Ler um getter mudou o resultado de `==`. Se esses records são chaves de dicionário, membros de um conjunto ou são comparados em uma asserção de teste, você obtém falhas que desaparecem quando adiciona um `Console.WriteLine` para depurá-las. Esse é o argumento mais forte contra fazer cache dentro de um record.

## É uma cópia rasa, até o fim

O construtor de cópia copia valores de campos. Para campos de tipo por referência, o valor é uma referência, então os dois records apontam para o mesmo objeto:

```csharp
// .NET 10, C# 14
var o = new Order(1, new List<string> { "apple" });
var o2 = o with { Id = 2 };
o2.Items.Add("pear");
Console.WriteLine($"o.Items: {string.Join(",", o.Items)} same list: {ReferenceEquals(o.Items, o2.Items)}");

record Order(int Id, List<string> Items);
```

```text
o.Items: apple,pear same list: True
```

O mesmo vale para um campo `Lazy<T>` (as duas cópias compartilham o `Lazy` já avaliado), um `StringBuilder` ou uma classe mutável aninhada. Um record é tão imutável quanto seu campo menos imutável. Prefira `ImmutableArray<T>` ou `IReadOnlyList<T>` sustentado por um array que você nunca modifica, e trate o `with` como "copiar o nível superior".

## Herança: `with` mantém o tipo em tempo de execução

`<Clone>$` é virtual, e cada record derivado o sobrescreve com um tipo de retorno covariante. Um `with` por meio de uma variável do tipo base produz o tipo derivado:

```csharp
// .NET 10, C# 14
Person p = new Student("Alan", "Turing", "King's");
var q = p with { First = "Alonzo" };
Console.WriteLine(q.GetType().Name); // Student

record Person(string First, string Last);
record Student(string First, string Last, string College) : Person(First, Last);
```

A reflection em `Student` mostra `<Clone>$ returns Student`. Isso costuma ser o que você quer, mas significa que um `with` em uma referência base copia estado exclusivo do tipo derivado (aqui `College`) que o código chamador nem sequer consegue ver, incluindo quaisquer campos de cache desatualizados declarados no record derivado.

Para um `sealed record`, o compilador torna o construtor de cópia `private` e `<Clone>$` não virtual (o probe imprimiu `sealed copy ctor private: True; clone virtual: False`).

## O que uma expressão `with` pode atribuir

Como o `with` executa os acessores depois do clone, ele só consegue definir membros que têm um acessor `set` ou `init` e são acessíveis no ponto da chamada. Tentar "consertar" uma propriedade calculada desatualizada atribuindo a ela falha:

```csharp
// .NET 10, C# 14
record A(int X) { public int Computed { get; } = X * 2; }

var b = new A(1) with { Computed = 3 };
// error CS0200: Property or indexer 'A.Computed' cannot be assigned to -- it is read only
```

`with` em uma classe comum é rejeitado de cara, porque uma classe não tem `<Clone>$`:

```text
error CS8858: The receiver type 'Svc' is not a valid record type and is not a struct type.
```

Desde o C# 10, `with` também funciona em structs (incluindo `record struct`), tuplas e tipos anônimos. Para esses não há método clone nem construtor de cópia: o valor é copiado do mesmo jeito que qualquer atribuição de struct copia, e então os membros listados são atribuídos. A [documentação da expressão `with`](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression) afirma claramente que você não pode personalizar a semântica de cópia para tipos struct.

Membros `required` não obrigam você a se repetir em um `with`. O construtor de cópia sintetizado é marcado com `[SetsRequiredMembers]`, então `r with { }` em um record com `required string Name` compila e copia `Name`. Se os membros `required` confundem você em inicializadores, o [passo a passo do CS9035](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) cobre o lado do inicializador de objeto.

## Correções que realmente se sustentam

### 1. Calcular no acesso (a resposta padrão)

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string FullName => $"{First} {Last}";
}
```

Sem campo de apoio, nada para copiar, nada para ficar desatualizado, e nada extra em `Equals`/`GetHashCode`. A orientação da própria Microsoft na página do `with` diz o mesmo: propriedades calculadas em records "devem ser calculadas no acesso, não inicializadas quando a instância é criada". Interpolar duas strings é barato; meça antes de decidir que não é.

### 2. Validar ou recalcular nos acessores `init`

Os acessores `init` são o único pedaço do seu código que realmente roda durante um `with`. A [palavra-chave `field`](/pt-br/2025/04/c-14-the-field-keyword-and-field-backed-properties/) do C# 14 facilita colocar lógica ali sem declarar um campo de apoio. A validação funciona como você esperaria:

```csharp
// .NET 10, C# 14
record Person(string First, string Last)
{
    public string Last { get; init => field = string.IsNullOrEmpty(value)
        ? throw new ArgumentException("Last required")
        : value; } = Last;
}

var bad = new Person("Ada", "Lovelace") with { Last = "" }; // throws ArgumentException: Last required
```

Se um valor é realmente caro e você precisa fazer cache dele, invalide o cache a partir dos acessores `init` das entradas e tire o cache da igualdade:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    private string? _fullName;
    public string First { get; init { field = value; _fullName = null; } } = First;
    public string Last  { get; init { field = value; _fullName = null; } } = Last;
    public string FullName => _fullName ??= $"{First} {Last}";

    public virtual bool Equals(Name? other) =>
        other is not null && EqualityContract == other.EqualityContract
        && First == other.First && Last == other.Last;
    public override int GetHashCode() => HashCode.Combine(First, Last);
}
```

Com essa versão, `a with { First = "Grace" }` imprime `Grace Lovelace` mesmo quando `a.FullName` foi lido antes, e `b == new Name("Grace", "Lovelace")` é `True`. O custo é que agora você mantém `Equals` e `GetHashCode` à mão, e o compilador não avisa quando você adiciona uma propriedade e esquece de incluí-la.

### 3. Escrever seu próprio construtor de cópia

Você pode declarar o construtor de cópia por conta própria e copiar apenas o que deve sobreviver:

```csharp
// .NET 10, C# 14
record Fixed(string First, string Last)
{
    private string? _full;
    public string FullName => _full ??= $"{First} {Last}";

    protected Fixed(Fixed original)
    {
        First = original.First;
        Last = original.Last;
        // _full deliberately not copied
    }
}
```

Isso funciona (`f with { First = "Grace" }` dá `Grace Lovelace` depois que o cache do original foi preenchido), e é a forma documentada de fazer a cópia profunda de uma lista. Também tem as arestas mais afiadas:

- Agora você é responsável por copiar **todos** os campos. Adicione uma propriedade no mês que vem, esqueça este construtor, e o `with` a redefine silenciosamente para `default`.
- Em um record derivado, você precisa encadear para o construtor de cópia da base. Se omitir, você recebe dois erros, `CS1729: 'Base' does not contain a constructor that takes 0 arguments` e `CS8868: A copy constructor in a record must call a copy constructor of the base, or a parameterless object constructor if the record inherits from object.` A correção é `protected Derived(Derived other) : base(other) { ... }`.
- Ele precisa ser `public` ou `protected`, a menos que o record seja sealed.
- Não faz nada por `Equals`: um campo de cache ainda faz o `==` depender do histórico de leitura.

Use-o para cópias profundas de coleções, não como mecanismo de invalidação de cache.

### 4. Não coloque identidade em um inicializador

Para IDs e timestamps que precisam ser únicos por instância, não os gere em um inicializador de propriedade em um record que você pretende copiar com `with`. Ou passe-os explicitamente (`evt with { Id = Guid.NewGuid() }`) ou crie novos eventos por meio de uma factory em vez de `with`. Copiar um evento e manter seu ID é exatamente o que o `with` foi projetado para fazer.

## Um checklist para tipos record que você copia com `with`

- Todo valor derivado usa corpo de expressão, ou é recalculado a partir de acessores `init`.
- Nenhum campo privado de cache, a menos que você também sobrescreva `Equals` e `GetHashCode`.
- Nenhuma coleção mutável, ou um construtor de cópia personalizado que as clone.
- Nenhum inicializador `= Guid.NewGuid()` ou `= DateTime.UtcNow` em tipos que são copiados.
- Records derivados que declaram um construtor de cópia encadeiam para `base(original)`.

Se você está decidindo se um tipo deve ser um record, a [matriz de decisão record vs classe vs struct](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) cobre os trade-offs, e o ângulo do EF Core (uma cópia com `with` é uma instância que o change tracker nunca viu) está em [como usar records com o EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/). Desenvolvedores Dart esbarram na mesma questão de cópia rasa com `copyWith`, discutida em [records do Dart vs classes do Freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/).

## Relacionados

- [Record vs classe vs struct em C#: uma matriz de decisão](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)
- [Como usar records com o EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14: a palavra-chave `field` e propriedades com campo de apoio](/pt-br/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [Corrigir CS9035: o membro required deve ser definido no inicializador de objeto](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)

## Fontes

- [A expressão `with`, referência do C# (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)
- [Records, mutação não destrutiva (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record#nondestructive-mutation)
- [Proposta de records, "Copy and Clone members" (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)
- [A palavra-chave `field` (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field)
