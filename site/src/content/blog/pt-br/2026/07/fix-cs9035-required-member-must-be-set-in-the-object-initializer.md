---
title: "Correção: CS9035 \"Required member 'X' must be set in the object initializer\" em C#"
description: "CS9035 significa que um membro marcado como required não foi atribuído. Atribua-o no inicializador de objeto, ou adicione um construtor com [SetsRequiredMembers] que atribua cada membro required."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer"
translatedBy: "claude"
translationDate: 2026-07-06
---

`CS9035` dispara em tempo de compilação quando você cria uma instância de um tipo que tem um membro `required`, mas esse membro não é atribuído. O compilador quer que cada campo ou propriedade `required` seja definido antes de o objeto sair da construção. Corrija do jeito direto: adicione o membro ao inicializador de objeto, por exemplo `new Person { Name = "Ada" }`. Se um construtor já atribui o membro, avise o compilador colocando `[SetsRequiredMembers]` nesse construtor para que ele pare de exigir o inicializador. Isto está verificado com C# 14 no .NET 11; o modificador `required` e este diagnóstico se comportam da mesma forma desde o C# 11 no .NET 7.

## O erro em contexto

A mensagem completa nomeia o membro exato que falta ao compilador:

```
error CS9035: Required member 'Person.Name' must be set in the object initializer or attribute constructor.
```

Você verá um `CS9035` por membro required não atribuído, então um tipo com três propriedades required e um `new Person()` vazio produz três erros de uma vez. É um diagnóstico de tempo de compilação, não uma exceção em tempo de execução: o build falha, nada roda. Esse é o propósito inteiro de `required`: a verificação passou de um `NullReferenceException` que você acertava em produção para um sublinhado vermelho que você vê no editor.

## Por que isto acontece

O modificador `required`, introduzido no C# 11, marca um campo ou propriedade como obrigatório no momento da inicialização. Quando qualquer expressão constrói uma nova instância do tipo, o compilador verifica que cada membro `required` está atribuído, seja por meio de um inicializador de objeto ou de um construtor que promete defini-los. Se ele não consegue provar isso, emite `CS9035`.

A palavra-chave é "provar". O compilador não roda o seu código. Ele confia apenas em duas coisas: um membro que você atribui diretamente no inicializador de objeto, e um construtor explicitamente anotado com `[SetsRequiredMembers]`. Um construtor que por acaso atribui o membro no seu corpo mas não tem o atributo não conta para nada; o compilador não vai ler o corpo para descobrir isso. É por isso que o erro sobrevive mesmo quando o seu construtor claramente define o valor: você tem que avisar o compilador, não mostrar a ele.

Três situações produzem o erro:

- Você chama `new T()` ou `new T { ... }` sem atribuir cada membro `required`.
- Você escreveu um construtor que define os membros required mas esqueceu `[SetsRequiredMembers]`, então o compilador ainda exige um inicializador.
- Você adicionou `required` a um membro de um tipo base, e o caminho de construção de um tipo derivado já não o satisfaz.

## Reprodução mínima

O menor tipo que dispara `CS9035`:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }   // not required, optional
}
```

Cada uma destas construções falha ao compilar:

```csharp
// .NET 11, C# 14
var a = new Person();                        // CS9035 x2 (Name and Email)
var b = new Person { Name = "Ada" };         // CS9035 x1 (Email still missing)
var c = new Person { Age = 36 };             // CS9035 x2 (Name and Email)
```

Somente quando ambos os membros required estão presentes ela compila:

```csharp
// .NET 11, C# 14 -- compiles
var ok = new Person { Name = "Ada", Email = "ada@example.com" };
```

Note que `Age` fica de fora e isso está tudo bem. `required` é por membro; membros opcionais continuam opcionais. Ao compilador importa apenas que os membros que carregam o modificador `required` estejam atribuídos.

## A correção em detalhe

Percorra estas opções em ordem. A primeira é a resposta na grande maioria dos casos; o restante cobre as situações onde um inicializador não é o que você quer.

### 1. Atribua os membros required no inicializador de objeto

A correção pretendida é definir cada membro required no local da chamada:

```csharp
// .NET 11, C# 14
var person = new Person
{
    Name = "Ada Lovelace",
    Email = "ada@example.com",
    // Age is optional, omit it freely
};
```

É para isso que serve `required`: o contrato do tipo diz que estes campos são obrigatórios, e o inicializador honra isso. Se você se pega repetindo os mesmos valores, isso é um sinal de que o tipo quer um construtor, que é a próxima correção.

### 2. Adicione um construtor anotado com [SetsRequiredMembers]

Quando um construtor já recebe os valores e os atribui, decore-o com `System.Diagnostics.CodeAnalysis.SetsRequiredMembers`. Este atributo assegura ao compilador que o construtor inicializa cada membro required, então os chamadores não precisam mais de um inicializador de objeto:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }

    [SetsRequiredMembers]
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }
}

// now this compiles, no initializer needed
var person = new Person("Ada", "ada@example.com");
```

Um detalhe delicado: `[SetsRequiredMembers]` é uma asserção, não uma garantia verificada. O compilador acredita na sua palavra e não verifica que o construtor de fato atribui cada membro required. Se você adiciona o atributo mas esquece de definir `Email` no corpo, você não recebe nenhum `CS9035` nem nenhum aviso, apenas um `null` onde você prometeu um valor. Mantenha o atributo honesto.

Se você mantém um construtor sem parâmetros ao lado do anotado, os chamadores da versão sem parâmetros ainda precisam do inicializador. O atributo só isenta o construtor específico onde ele está.

### 3. Remova `required` se o membro não for realmente obrigatório

Se o membro tem um padrão sensato ou é genuinamente opcional, ele não deveria ser `required` em primeiro lugar. Remover o modificador remove a obrigação:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public string Email { get; init; } = "";   // was required, now optional with a default
}
```

Esta é a escolha certa surpreendentemente com frequência. Recorra a `required` apenas quando não houver um padrão razoável e construir sem o valor deixaria o objeto em um estado inválido. Dar um padrão a uma propriedade e remover `required` é mais limpo do que forçar cada local de chamada a passar uma string vazia.

### 4. Para records, use um construtor posicional ou com [SetsRequiredMembers]

Um record posicional gera uma propriedade `init` por parâmetro, mas essas não são `required` por padrão. Se você adiciona explicitamente uma propriedade `required` a um record com um construtor primário, o construtor primário não a satisfaz automaticamente, e você recebe `CS9035` quando usa a forma posicional. Isso confunde as pessoas porque parece que o construtor deveria contar. Veja a discussão de design em [dotnet/csharplang #6780](https://github.com/dotnet/csharplang/discussions/6780) para o raciocínio. A correção é definir a propriedade em um inicializador em cima da chamada posicional, ou adicionar `[SetsRequiredMembers]` a um construtor que a atribui:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public record Product(string Sku)
{
    public required string Name { get; init; }

    [SetsRequiredMembers]
    public Product(string sku, string name) : this(sku) => Name = name;
}

// both work now
var withInit = new Product("A-100") { Name = "Widget" };
var withCtor = new Product("A-100", "Widget");
```

Se você quer que toda a construção do record seja aplicada por meio dos parâmetros posicionais, prefira propriedades `init` simples em vez de propriedades `required`. Misturar records posicionais e membros `required` é uma fonte de confusão; decida qual modelo o tipo usa. Para uma visão mais ampla de quando um record vale a pena, veja [record vs class vs struct em C#](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).

## Pontos delicados e variantes

Um punhado de situações produz `CS9035`, ou algo parecido, por razões que não são óbvias a partir da mensagem:

- **`[SetsRequiredMembers]` é confiança, não prova.** Como coberto acima, o compilador não verifica o construtor. Um construtor com o atributo que pula um membro required compila limpo e te entrega um `null`. Trate o atributo como um contrato que você é responsável por cumprir.

- **System.Text.Json respeita `required`.** Desde o .NET 8, o desserializador JSON aplica os membros required: se o JSON de entrada omite uma propriedade required, a desserialização lança uma `JsonException` em tempo de execução em vez de produzir um objeto pela metade. Este é um erro em tempo de execução, não `CS9035`, mas é o mesmo contrato aparecendo no caminho de desserialização. Se você vê uma falha de desserialização mencionando um membro required, ao JSON falta um campo que o tipo exige. Para o formato geral desse erro, veja [o valor JSON não pôde ser convertido](/pt-br/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/), e se você precisa de lógica de construção personalizada, [como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Um converter que constrói o objeto por si mesmo contorna a verificação de membros required, então também é uma saída de emergência quando um tipo que você não controla está brigando com você.

- **Reflexão e `Activator.CreateInstance` pulam a verificação por completo.** `required` é aplicado pelo compilador de C#, não pelo runtime. `Activator.CreateInstance(typeof(Person))` compila e roda, deixando os membros de referência required como `null`. Se um framework constrói seus objetos por meio de reflexão sem honrar `[SetsRequiredMembers]`, você pode acabar com um objeto "impossível" que o compilador nunca teria deixado você escrever à mão. ORMs e serializadores que materializam objetos são os suspeitos de sempre; verifique se eles suportam membros required antes de confiar no modificador para esses tipos. Isto importa em especial para entidades, veja [como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/).

- **A herança carrega a obrigação para baixo.** Se uma classe base tem um membro `required`, cada tipo derivado também deve satisfazê-lo na construção, e um construtor derivado que não o define precisa de `[SetsRequiredMembers]` ou deixa o requisito para o inicializador do chamador. Adicionar `required` a um membro base é uma mudança que quebra o código-fonte de todos os construtores na hierarquia que dependiam de o membro ser opcional.

- **`init` versus `set` não importa para `required`.** `required` é ortogonal à acessibilidade do setter. Você pode marcar um membro `required` com `init` (definível apenas durante a construção) ou com um `set` normal. O modificador controla se o membro deve ser atribuído; o acessador controla quando ele pode ser atribuído. Um padrão comum é `public required string Name { get; init; }`: obrigatório definir, e apenas na construção.

- **O membro deve ser pelo menos tão acessível quanto o tipo.** Um membro `required` tem que poder ser definido por qualquer código que possa construir o tipo. Um tipo `public` com um membro `required` que tem um acessador init `internal` produz um diagnóstico diferente (`CS9032`/`CS9033`), porque chamadores externos poderiam construir o tipo mas não satisfazer o seu requisito. Se você estreita o acessador de um membro required, estreite também o construtor ou o tipo.

O modelo mental a reter: `required` move uma regra de "você deve fornecer isto" de uma esperança em tempo de execução para uma garantia em tempo de compilação, e `CS9035` é essa garantia fazendo o seu trabalho. Quando você o vê, a correção é sempre uma de "forneça o valor no local da chamada" ou "avise o compilador que um construtor já o fornece". Decida qual é verdadeira para o tipo, então preencha o inicializador ou adicione `[SetsRequiredMembers]`, e nunca recorra ao atributo como uma forma de silenciar o erro sem de fato definir o membro.

## Relacionados

- [record vs class vs struct em C#: uma matriz de decisão](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) para escolher a forma de tipo certa antes de espalhar `required` por cima.
- [Como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/) para como membros required interagem com as entidades que o ORM materializa por reflexão.
- [Como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) para assumir o controle da construção quando o serializador padrão briga com seus membros required.
- [Correção: o valor JSON não pôde ser convertido](/pt-br/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) para o lado de tempo de execução do mesmo contrato durante a desserialização.
- [Como declarar propriedades de extensão em C# 14](/pt-br/2026/06/how-to-declare-extension-properties-in-csharp-14/) para mais do que o modelo de propriedades do C# 14 pode e não pode expressar.

## Fontes

- Microsoft Learn, [modificador required (referência de C#)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (semântica de `required`, o atributo `SetsRequiredMembers`, e a regra de que o compilador não verifica o corpo do construtor).
- Microsoft Learn, [Inicializadores de objeto e coleção](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/object-and-collection-initializers) (como membros required devem ser definidos por meio de um inicializador ou construtor de atributo).
- GitHub, [dotnet/csharplang Discussion #6780](https://github.com/dotnet/csharplang/discussions/6780) (por que `CS9035` é disparado para records que combinam um construtor primário com propriedades `required` explícitas).
