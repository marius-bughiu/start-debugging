---
title: "Solução: CS8618 \"Non-nullable property must contain a non-null value when exiting constructor\" em C#"
description: "CS8618 significa que um campo ou propriedade não anulável não foi inicializado antes de o construtor terminar. Atribua no construtor, dê um valor padrão, marque como required ou torne-o anulável."
pubDate: 2026-07-20
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "nullable"
lang: "pt-br"
translationOf: "2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor"
translatedBy: "claude"
translationDate: 2026-07-20
---

`CS8618` dispara quando um membro de referência não anulável (um campo ou uma propriedade automática) não tem garantia de conter um valor não nulo no momento em que um construtor termina. O compilador não consegue provar que o membro foi atribuído, então avisa que um `null` pode vazar. Corrija de uma de quatro formas, em ordem aproximada de preferência: atribua no construtor, dê um inicializador de campo, marque como `required` para que quem constrói precise defini-lo, ou torne o membro anulável (`string?`) se `null` for realmente válido. Isto foi verificado com C# 14 no .NET 11; o diagnóstico se comporta assim desde que os tipos de referência anuláveis chegaram no C# 8, e o .NET 6 foi a versão que ativou o contexto anulável por padrão em projetos novos.

## O erro em contexto

O compilador atual emite uma única mensagem unificada para campos e propriedades:

```
warning CS8618: Non-nullable variable must contain a non-null value when exiting constructor. Consider declaring it as nullable.
```

SDKs mais antigos (e muitas threads do StackOverflow ainda abertas) mostram as variantes específicas de campo e de propriedade, que é o que muita gente de fato digita na busca:

```
warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor.
warning CS8618: Non-nullable field '_name' must contain a non-null value when exiting constructor.
```

As três são o mesmo diagnóstico com a mesma causa. Repare na palavra *warning*, não *error*: `CS8618` não interrompe a build por padrão. Ele vira um erro que quebra a build apenas se você tiver `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` ou `<WarningsAsErrors>CS8618</WarningsAsErrors>` no seu projeto, algo que muitas equipes fazem justamente para que as lacunas de segurança contra null não possam ser ignoradas.

## Por que isso acontece

Os tipos de referência anuláveis, introduzidos no C# 8 e ativados por padrão nos templates desde o .NET 6 (`<Nullable>enable</Nullable>` no `.csproj`), dividem cada tipo de referência em dois estados: não anulável (`string`) e anulável (`string?`). Um membro não anulável é uma promessa: "isto nunca será null." O trabalho do compilador é cobrar essa promessa, e o lugar onde ele consegue verificar com mais facilidade é a construção. Quando um construtor retorna, cada campo e propriedade automática não anulável precisa ser comprovadamente não nulo. Se o compilador não conseguir provar isso, você recebe `CS8618`.

A expressão crítica é "comprovadamente." O compilador faz análise estática; ele não executa o seu código. Ele confia em exatamente três coisas: um inicializador de campo ou propriedade, uma atribuição direta dentro do construtor, e um método auxiliar anotado para dizer que atribui o membro. Um construtor que atribui o valor por algum caminho que o compilador não consegue seguir, ou um membro definido apenas depois por um framework, não conta para nada. Este é o mesmo modelo de "provar, não mostrar" por trás do [diagnóstico de membro obrigatório CS9035](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/): o compilador não vai deduzir a intenção a partir dos corpos dos seus métodos.

Uma armadilha sutil: proteger com uma verificação de null dentro do construtor não ajuda. Código como `if (name is null) throw new ArgumentNullException(nameof(name));` prova que o *parâmetro* não é null, mas o compilador continua vendo o *membro* como não atribuído a menos que você realmente o atribua. Isso surpreende as pessoas com frequência suficiente para ter seu próprio issue de longa data no Roslyn.

## Repro mínima

O menor tipo que dispara `CS8618`, em um projeto com o contexto anulável ativado:

```csharp
// .NET 11, C# 14, <Nullable>enable</Nullable>
public class Person
{
    public string Name { get; set; }    // CS8618: never assigned
    public string Email { get; set; }   // CS8618: never assigned
    public int Age { get; set; }        // fine, value type has a default
}
```

Dois avisos, um por propriedade de referência não anulável. `Age` fica em silêncio porque tipos de valor sempre têm um padrão (`0`); os avisos de nulabilidade são sobre tipos de referência. Adicione um construtor que defina apenas um membro e você ainda recebe um aviso:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name)
    {
        Name = name;      // Name is proven
    }

    public string Name { get; set; }
    public string Email { get; set; }   // CS8618: still not assigned on this path
}
```

O compilador verifica cada construtor de forma independente. Se qualquer construtor deixa um membro não anulável sem atribuição, esse construtor produz o aviso.

## A solução, em detalhe

Percorra estas opções em ordem. As três primeiras são as que você quer na maior parte do tempo; as duas últimas são válvulas de escape para quando o membro realmente é inicializado em algum lugar que o compilador não consegue ver.

### 1. Inicialize o membro em um construtor

Se o valor é necessário para construir um objeto válido, receba-o como parâmetro do construtor e atribua-o. Este é o design para o qual o aviso está te empurrando:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }

    public string Name { get; set; }
    public string Email { get; set; }
}
```

Ambos os membros agora estão comprovadamente atribuídos em todos os caminhos de construção, então os dois avisos desaparecem. Se você tem vários construtores, canalize-os por um só para que a atribuição fique em um único lugar: `public Person() : this("John", "Doe") { }` satisfaz o compilador porque o construtor encadeado faz o trabalho.

### 2. Dê ao membro um valor padrão com um inicializador de campo

Quando há um padrão sensato e você não quer forçar cada chamador a passar o valor, inicialize o membro onde ele é declarado:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}
```

Um inicializador de campo roda antes do corpo de qualquer construtor, então o membro é não nulo em todos os caminhos automaticamente. Esta é a solução mais limpa para valores mais ou menos opcionais como strings vazias ou coleções `new List<string>()`. Também é melhor do que tornar o tipo anulável se o membro nunca deveria ser null em tempo de execução, porque mantém o contrato de não nulo para todo mundo que ler a propriedade.

### 3. Marque o membro como `required` (C# 11 e posteriores)

Se o membro é obrigatório mas você não quer um parâmetro de construtor para ele, use o modificador `required`. Ele move a obrigação para o inicializador de objeto do chamador e, de bônus, silencia `CS8618`, porque o compilador agora sabe que o membro precisa ser definido antes de o objeto vazar:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; set; }
    public required string Email { get; set; }
}

// the caller is now forced to set both
var p = new Person { Name = "Ada", Email = "ada@example.com" };
```

Esta costuma ser a melhor resposta moderna para DTOs e objetos de configuração: sem construtor de boilerplate, sem valor padrão falso, e a garantia de não nulo é aplicada em cada ponto de chamada. O custo é que omitir um valor vira um erro de compilação (`CS9035`) no ponto de chamada em vez de um aviso sobre o tipo. Se você recorrer a isto, leia o artigo complementar sobre [CS9035 e membros required](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) para saber como é o erro do lado do chamador.

### 4. Torne o membro anulável se `null` for um estado válido

Se o membro realmente pode estar ausente, ele deveria ser `string?`, não `string`. Adicionar o `?` diz ao compilador e a cada leitor que este valor pode ser null, o que é honesto e move a verificação de null para onde o valor é consumido:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string? MiddleName { get; set; }   // legitimately optional
}
```

Não recorra a isto só para silenciar o aviso sobre um membro que nunca é realmente null. Marcar um membro como anulável quando na prática ele sempre está definido empurra verificações de null fantasma (ou operadores `!` de perdão de null) sobre cada consumidor. Reserve `?` para valores que são de fato opcionais.

### 5. Anote um método auxiliar com `[MemberNotNull]`, ou use `null!` para membros inicializados por um framework

Às vezes o membro está inicializado, só que não em algum lugar que o compilador siga. Duas ferramentas cobrem isso.

Se um método privado compartilhado faz a inicialização, diga ao compilador com `[MemberNotNull]`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Student
{
    public string Major { get; set; }

    public Student() => SetMajor();

    [MemberNotNull(nameof(Major))]
    private void SetMajor(string? major = null) => Major = major ?? "Undeclared";
}
```

`[MemberNotNull]` afirma que depois de o método retornar, o membro nomeado não é null, então um construtor que o chama é considerado como tendo atribuído o membro. Como `[SetsRequiredMembers]`, esta é uma promessa em que o compilador acredita sem verificar, então mantenha-a honesta.

O outro caso é um membro que um framework define por reflexão, o clássico sendo um `DbSet` do EF Core. O `DbContext` base os preenche, mas o compilador não consegue ver isso, então o idioma é inicializar com `null!`:

```csharp
// .NET 11, EF Core 11
public class TodoContext : DbContext
{
    public TodoContext(DbContextOptions<TodoContext> options) : base(options) { }

    public DbSet<TodoItem> TodoItems { get; set; } = null!;
}
```

O `null!` diz "assuma que isto não é null; eu sei que é definido em outro lugar." É uma supressão direcionada, não uma solução, então use apenas quando algo fora do seu construtor realmente faz a inicialização. Esse padrão aparece por todo o código do EF Core; o mesmo raciocínio vale para as entidades que o ORM materializa, coberto em [como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Armadilhas e variantes

Um punhado de situações produz `CS8618`, ou algo próximo, por motivos que a mensagem não detalha:

- **Uma verificação de null no parâmetro não atribui o membro.** Lançar `ArgumentNullException` quando um parâmetro é null prova que o parâmetro não é null mas deixa o membro sem atribuição no modelo do compilador. Você ainda precisa escrever `Name = name;`. Valide e atribua; validar sozinho não basta.

- **A construção padrão de um `struct` contorna o seu construtor.** Para um `struct`, o padrão sem parâmetros (`default(MyStruct)` ou `new MyStruct()` quando nenhum construtor sem parâmetros explícito roda) inicializa a zero cada campo, deixando os campos de referência não anuláveis como `null` sem aviso no local do `default`. O compilador avisa sobre os construtores declarados do seu struct, mas não consegue impedir que um chamador obtenha uma instância zerada. Não confie em `required` nem em um construtor para garantir campos não nulos em um struct; um valor `default` contorna os dois.

- **Reflexão e serializadores constroem objetos sem o seu construtor.** `Activator.CreateInstance`, `System.Text.Json` e ORMs podem construir um objeto sem rodar o construtor que teria atribuído os seus membros, então um membro que o compilador provou não nulo ainda pode ser `null` em tempo de execução. Se você usa `required`, note que o `System.Text.Json` respeita membros required desde o .NET 8 e vai lançar uma `JsonException` quando o JSON omitir um, que é a metade em tempo de execução do mesmo contrato. Quando você precisa de controle total sobre como um tipo é construído a partir de JSON, [um JsonConverter personalizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) assume a construção por completo.

- **Propriedades com campo de apoio e a palavra-chave `field`.** Com uma propriedade automática normal, o campo de apoio é o que a análise rastreia. Se você usa a palavra-chave `field` do C# 14 para adicionar lógica a um acessador, a mesma regra vale para o campo de apoio sintetizado pelo compilador: ele precisa ser não nulo quando o construtor termina, então inicialize-o como qualquer outro membro.

- **`= default!` versus `= null!`.** Para membros de referência eles significam a mesma coisa (`default` para um tipo de referência é `null`), e ambos silenciam o aviso. Prefira `null!` para membros de referência porque se lê como "intencionalmente null por enquanto," e reserve `default!` para membros genéricos onde o parâmetro de tipo pode ser um tipo de valor.

- **Desligar tudo quase nunca é a solução.** Você pode reduzir o escopo do contexto anulável com `#nullable disable` ao redor de um arquivo ou região, mas isso descarta a análise de segurança contra null para tudo lá dentro, não só para aquele membro. Se você quer silenciar um único membro que sabe estar correto, `null!` nesse membro é muito mais direcionado do que desabilitar o contexto. Um `#nullable disable` de arquivo inteiro é uma ferramenta de migração, não uma solução.

O modelo mental a manter: `CS8618` é o compilador fazendo cumprir a promessa que um membro não anulável faz. Quando você o vir, decida o que é de fato verdade e aja de acordo. O membro é obrigatório (atribua em um construtor, ou marque como `required`), tem um padrão razoável (dê um inicializador de campo), é de fato opcional (torne-o `string?`), ou é inicializado por código que o compilador não consegue ver (`[MemberNotNull]` ou `null!`). Recorrer a `null!` em um membro que se supõe que um chamador deva definir apenas move um aviso em tempo de compilação para uma `NullReferenceException` em tempo de execução, que é exatamente o bug que os tipos de referência anuláveis existem para prevenir.

## Relacionados

- [Solução: CS9035 "Required member 'X' must be set in the object initializer"](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) para o erro do lado do chamador que você recebe assim que marca um membro como `required`.
- [record vs class vs struct em C#: uma matriz de decisão](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para escolher a forma do tipo antes de decidir como os membros são inicializados.
- [Como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/) para o idioma do DbSet `null!` e os membros que o ORM materializa por reflexão.
- [Como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) para assumir a construção quando a serialização contorna o seu construtor.
- [Atribuição condicional de null no C# 14](/pt-br/2026/02/csharp-14-null-conditional-assignment/) para mais sobre como o C# raciocina acerca de null no código do dia a dia.

## Fontes

- Microsoft Learn, [Nullable reference type warnings (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (texto exato de `CS8618`, a seção "nonnullable reference not initialized" e as quatro técnicas de solução, incluindo `[MemberNotNull]` e `null!`).
- Microsoft Learn, [required modifier (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (como `required` move a obrigação para o chamador e satisfaz a verificação de não nulo).
- Microsoft Learn, [Working with nullable reference types in EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/nullable-reference-types) (o padrão `DbSet` = `null!` e por que o compilador não consegue ver a inicialização da classe base).
- GitHub, [dotnet/roslyn Issue #60283](https://github.com/dotnet/roslyn/issues/60283) (por que uma verificação de null no construtor não limpa `CS8618`).
