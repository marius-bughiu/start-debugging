---
title: "Solução: [MemberNotNull] não tem efeito em um método factory estático e o CS8618 continua aparecendo"
description: "O CS8618 é verificado quando o construtor termina, e [MemberNotNull] em um método estático é ignorado em silêncio para membros de instância. Passe os valores para um construtor privado."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "nullable"
lang: "pt-br"
translationOf: "2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method"
translatedBy: "claude"
translationDate: 2026-10-28
---

`[MemberNotNull]` em um método factory estático não consegue eliminar o `CS8618`, porque o aviso é reportado no construtor, no momento em que o construtor termina, e o compilador nunca olha o que o factory faz depois. Além disso, um método estático não tem `this`, então quando o seu `[MemberNotNull]` nomeia um membro de instância o compilador ignora o atributo em silêncio: nenhum aviso no método, nenhum efeito para quem chama. A solução é levar a atribuição de volta para um construtor: faça o factory calcular os valores e passá-los para um construtor privado, ou marque os membros como `required` e atribua-os em um inicializador de objeto dentro do factory. Verificado com o SDK do .NET 10 10.0.302 (C# 14); o comportamento é o mesmo desde que o `[MemberNotNull]` chegou no C# 9.

## O erro em contexto

A saída do build aponta para o construtor privado, não para o factory que você anotou:

```
Widget.cs(8,13): warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor. Consider adding the 'required' modifier or declaring the property as nullable.
```

Não existe um segundo diagnóstico dizendo que o atributo foi ignorado. Esse silêncio é o que torna tudo confuso: o `[MemberNotNull(nameof(Name))]` parece que deveria fazer alguma coisa, e nada no build diz o contrário.

## Por que isso acontece

Duas regras diferentes se combinam aqui.

**O `CS8618` é verificado por construtor, na saída dele.** O compilador roda a análise de fluxo de nulabilidade sobre o corpo de cada construtor (mais os inicializadores de campos e propriedades) e faz uma única pergunta na chave de fechamento: todo membro de tipo de referência não anulável recebeu com certeza um valor não nulo? Ele não acompanha o objeto depois que o construtor retorna. Um factory que faz `var w = new Widget(); w.Name = name; return w;` atribui `Name` quando o construtor já terminou com `Name` ainda `null`, e é nessa saída que o aviso mora. O time do Roslyn decidiu desde cedo não rastrear a inicialização através de chamadas de método ("We've decided not to track initialization interprocedurally for now" em [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358)). `[MemberNotNull]` é a válvula de escape opcional para exatamente um caso: um helper chamado *de dentro* do construtor sobre `this`.

**`[MemberNotNull]` em um método estático só significa algo para membros estáticos.** O atributo é uma pós-condição: "quando este método retorna, estes membros do receptor não são nulos". Para um método de instância o receptor é `this` (ou o objeto sobre o qual você chamou). Um método estático não tem receptor, então os únicos membros pelos quais ele pode responder são campos e propriedades estáticos. Quando você lista um membro de instância, o Roslyn aceita o `nameof` (compila normalmente porque `nameof(Name)` é válido em qualquer lugar da classe) e depois descarta a anotação. Confirmei as duas metades no SDK 10.0.302: um método estático marcado com `[MemberNotNull(nameof(Nick))]` que nunca atribui `Nick` não gera `CS8774`, e um método de instância que o chama continua recebendo `CS8602` ao desreferenciar `Nick` em seguida. O mesmo atributo nomeando um campo estático é validado e respeitado.

Então o factory estático falha nas duas frentes: ele não é o construtor, e a anotação dele nomeia membros que ele não consegue descrever.

## Repro mínimo

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
using System.Diagnostics.CodeAnalysis;

public class Widget
{
    public string Name { get; set; }

    private Widget() { }                     // CS8618 is reported here

    [MemberNotNull(nameof(Name))]            // silently ignored: static method, instance member
    public static Widget Create(string name)
    {
        var w = new Widget();
        w.Name = name;
        return w;
    }
}
```

A segunda forma do mesmo erro é um helper estático que recebe a instância como parâmetro e é chamado a partir do construtor. Parece o padrão documentado, mas não é:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public class Gadget
{
    public string Name { get; set; }

    public Gadget(string name) => Init(this, name);   // CS8618 still fires here

    [MemberNotNull(nameof(Name))]
    private static void Init(Gadget g, string name) => g.Name = name;
}
```

`[MemberNotNull]` descreve o receptor da chamada, e `Init(this, name)` não tem receptor. Passar `this` como argumento não conta. A única versão estática que funciona é aquela em que tanto o helper quanto os membros são estáticos, por exemplo um construtor estático chamando um carregador estático:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public static class Config
{
    public static string ConnectionString;

    static Config() => Load();                 // no CS8618: static helper, static member

    [MemberNotNull(nameof(ConnectionString))]
    private static void Load() => ConnectionString = "Server=.;Database=app";
}
```

## A correção em detalhes

Todas as correções abaixo levam a atribuição de volta para onde o `CS8618` consegue enxergá-la: dentro de um construtor, ou atrás de um contrato que o compilador entende. Estão em ordem de preferência.

### 1. Passe os valores calculados para um construtor privado

Esse é o formato certo para quase todo factory. O factory faz o trabalho (validação, parsing, E/S) e então entrega valores prontos a um construtor que só atribui:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Widget
{
    public string Name { get; }

    private Widget(string name) => Name = name;

    public static Widget Create(string raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw);
        return new Widget(raw.Trim());
    }
}
```

Sem atributo, sem supressão, e `Name` pode virar somente leitura, algo que um factory do tipo "constrói e depois atribui" jamais poderia oferecer. Se você tem vários membros, o construtor simplesmente ganha parâmetros. Um [record](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) com um construtor posicional privado é a versão compacta da mesma ideia.

### 2. Transforme o helper estático em uma função que retorna o valor

Para o formato `Init(this, ...)`, mude o helper para que ele retorne o que calculou, e deixe o construtor fazer a atribuição:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Gadget
{
    public string Name { get; }

    public Gadget(string raw) => Name = Normalize(raw);

    private static string Normalize(string raw) => raw.Trim().ToLowerInvariant();
}
```

Um método estático com valor de retorno é mais fácil de testar do que um que altera um parâmetro, e o compilador vê uma atribuição simples no construtor. Quando o helper produz vários valores, retorne uma tupla e faça a desconstrução: `(Name, Slug) = Parse(raw);` é uma atribuição definitiva dos dois membros.

### 3. Torne o helper um método de instância e chame-o a partir do construtor

Se a inicialização realmente é um bloco de código imperativo compartilhado, mantenha-a em um helper, mas faça dele um método de instância para que o `[MemberNotNull]` descreva `this`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Report
{
    public string Title { get; private set; }

    private Report(string raw) => Normalize(raw);

    [MemberNotNull(nameof(Title))]
    private void Normalize(string raw) => Title = raw.Trim();

    public static Report Create(string raw) => new(raw);
}
```

Esse é o padrão que a [página do Microsoft Learn sobre atributos de nulabilidade](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis#helper-methods-membernotnull-and-membernotnullwhen) documenta. Diferente do caso estático, o compilador verifica o helper: se `Normalize` puder retornar sem atribuir `Title`, você recebe `CS8774: Member 'Title' must have a non-null value when exiting.`

Uma armadilha: chamar o helper de instância a partir do factory sobre o objeto novo (`var r = new Report(); r.Normalize(raw);`) faz `r.Title` ser não nulo pelo resto do factory, porque `[MemberNotNull]` se aplica a qualquer receptor sobre o qual você o chama. Ainda assim não faz nada pelo `CS8618`, porque o construtor já tinha terminado antes de essa linha rodar.

### 4. Marque os membros como `required` e use um inicializador de objeto no factory

Se você prefere construção no estilo de propriedades, `required` move a obrigação do construtor para a expressão de criação do objeto, e o factory é o único lugar que pode criar um:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Invoice
{
    public required string Number { get; init; }
    public required string Customer { get; init; }

    private Invoice() { }

    public static Invoice Create(string number, string customer) =>
        new() { Number = number.Trim(), Customer = customer.Trim() };
}
```

O `CS8618` some porque um membro `required` não é responsabilidade do construtor. Você também ganha uma rede de segurança que o factory original nunca teve: esqueça um deles e o build falha com `CS9035: Required member 'Invoice.Customer' must be set in the object initializer or attribute constructor.` Isso é um erro, não um aviso. O [passo a passo do CS9035](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) cobre o lado de quem chama nesse contrato.

### 5. Use `[SetsRequiredMembers]` em um construtor privado

Se o tipo tem membros `required` para os chamadores públicos, mas o factory quer passar valores de forma posicional, adicione um construtor que promete atribuir todos eles:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Tag
{
    public required string Value { get; init; }

    public Tag() { }

    [SetsRequiredMembers]
    private Tag(string value) => Value = value;

    public static Tag Create(string raw) => new(raw.Trim().ToLowerInvariant());
}
```

Assim como `[MemberNotNull]`, `[SetsRequiredMembers]` é confiado, não verificado: se esse construtor esquecer um membro, nada avisa. Mantenha o construtor curto o bastante para conferir de olho.

### 6. Último recurso: suprima no construtor, não na propriedade

Se o tipo é construído por um framework que exige um construtor sem parâmetros e preenche os membros depois, restrinja a supressão a esse construtor para não perder a análise em nenhum outro lugar:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class LegacyRow
{
    public string Name { get; private set; }

#pragma warning disable CS8618 // Name is always assigned by Create before the instance escapes
    private LegacyRow() { }
#pragma warning restore CS8618

    public static LegacyRow Create(string name) => new() { Name = name };
}
```

Isso é honesto sobre o que está acontecendo, e o comentário diz ao próximo leitor qual método sustenta a promessa. Prefira isso a `= null!` na propriedade: `null!` silencia o aviso para todo construtor que o tipo venha a ter, inclusive os adicionados depois que de fato esquecem de atribuir.

## Armadilhas e variantes

- **Apague o atributo morto.** Depois de corrigir o factory, remova `[MemberNotNull]` de qualquer método estático que nomeie membros de instância. Ele não faz nada, o compilador nunca vai te avisar, e a próxima pessoa vai copiá-lo. Uma busca rápida por `MemberNotNull` na solução inteira, conferindo cada resultado em busca de `static`, encontra todos.

- **Factories assíncronos esbarram no `CS8774` por outro motivo.** Um `static async Task<T> CreateAsync()` é a razão mais comum para usar um factory, já que construtores não podem fazer `await`. Se em vez disso você colocar `[MemberNotNull]` em um helper de instância `async Task InitAsync()`, o compilador verifica a pós-condição nos pontos de `await`, onde o método pode devolver o controle a quem chamou, e não quando a task termina, então atribuir o membro depois de um `await` continua gerando `CS8774`. O Roslyn trata isso como comportamento intencional ([dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022)). A solução é a mesma da correção 1: faça `await` da E/S dentro do factory estático e então passe os resultados para um construtor privado.

- **Em um factory `TryCreate`, anote o parâmetro `out`, não os membros.** O que importa para quem chama é se o objeto retornado é nulo, e isso é uma pós-condição de parâmetro:

  ```csharp
  // .NET 10 SDK 10.0.302, C# 14
  using System.Diagnostics.CodeAnalysis;

  public sealed class Sku
  {
      public string Code { get; }
      private Sku(string code) => Code = code;

      public static bool TryCreate(string? raw, [NotNullWhen(true)] out Sku? sku)
      {
          sku = string.IsNullOrWhiteSpace(raw) ? null : new Sku(raw.Trim());
          return sku is not null;
      }
  }
  ```

  Os membros em si são não anuláveis e garantidos pelo construtor privado, então nada mais precisa de atributo.

- **Você não pode colocar `[MemberNotNull]` em um construtor.** O atributo só se aplica a métodos e propriedades. Pedir que um construtor derivado responda por um membro da classe base é uma solicitação em aberto ([dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526)). Passe o valor para cima via `base(...)` em vez disso.

- **Helpers de instância chamados sobre outro objeto fluem, mas só localmente.** `other.Init(); other.Name.Length` não gera aviso, porque o receptor é `other`. Isso é útil dentro do corpo de um factory, mas nunca satisfaz retroativamente o construtor que criou `other`.

- **Membros preguiçosos são outro problema.** Se `Name` legitimamente não tem valor até o primeiro uso, ele é anulável ou pertence a um `Lazy<T>`. Compare as opções em [Lazy&lt;T&gt; vs LazyInitializer vs double-checked locking](/pt-br/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/) em vez de brigar com o `CS8618`.

## Relacionados

- [Solução: CS8618 "Non-nullable property must contain a non-null value when exiting constructor"](/pt-br/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) para o aviso em geral e o padrão de helper de instância com `[MemberNotNull]`.
- [Solução: CS9035 "Required member 'X' must be set in the object initializer"](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) para o erro que aparece quando um factory baseado em `required` esquece um membro.
- [record vs class vs struct em C#: uma matriz de decisão](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para escolher um formato de tipo que torne natural a inicialização no construtor.
- [O que uma expressão with do C# realmente copia](/pt-br/2026/10/what-does-a-csharp-with-expression-actually-copy/) para outro caso em que a construção pula o código que você espera que rode.
- [Atribuição condicional nula no C# 14](/pt-br/2026/02/csharp-14-null-conditional-assignment/) para mais sobre como o compilador raciocina sobre null.

## Fontes

- Microsoft Learn, [Attributes interpreted by the compiler: Nullable static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) (a seção "Helper methods: MemberNotNull and MemberNotNullWhen" e seu exemplo de helper no construtor).
- Microsoft Learn, [MemberNotNullAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullattribute) (alvos do atributo: métodos e propriedades).
- Microsoft Learn, [Nullable reference type warnings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (`CS8618`, `CS8774`).
- GitHub, [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) (a inicialização não é rastreada através de chamadas de método).
- GitHub, [dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526) (`[MemberNotNull]` não é permitido em construtores).
- GitHub, [dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022) (`CS8774` em métodos `[MemberNotNull]` assíncronos é intencional).
