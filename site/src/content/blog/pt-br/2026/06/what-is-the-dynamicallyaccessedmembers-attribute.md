---
title: "O que é o atributo DynamicallyAccessedMembers?"
description: "DynamicallyAccessedMembers informa ao trimmer do .NET e ao compilador AOT quais membros de um Type você acessa por reflexão, para que sejam mantidos em vez de removidos pelo trimming. Ele transforma uma MissingMethodException silenciosa em runtime em um aviso IL2070 em tempo de build. Veja o que o atributo faz, como funciona a análise de fluxo de dados por trás dele e como anotar corretamente parâmetros, campos e parâmetros de tipo genéricos."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/what-is-the-dynamicallyaccessedmembers-attribute"
translatedBy: "claude"
translationDate: 2026-06-20
---

`[DynamicallyAccessedMembers]` é o atributo que você coloca em um `Type` (ou em um nome de tipo do tipo `string`) para dizer ao trimmer do .NET e ao compilador Native AOT "vou acessar estes membros por reflexão, então não os apague." É o contrato que permite à análise estática seguir uma reflexão que ela de outra forma não conseguiria enxergar. Sem ele, o trimmer remove qualquer membro cuja acessibilidade ele não consiga provar, e seu `type.GetMethod("Run").Invoke(...)` lança uma `MissingMethodException` em runtime no app publicado, mesmo que tenha funcionado no `dotnet run`. Com ele, o mesmo código ou compila limpo ou te dá um aviso preciso em tempo de build (`IL2070`, `IL2075`, `IL2077` e companhia) apontando o ponto exato onde um `Type` não anotado flui para uma chamada de reflexão. O atributo vive em `System.Diagnostics.CodeAnalysis`, distribuído em `System.Runtime.dll`, e está estável desde o .NET 5. Tudo abaixo tem como alvo o SDK do .NET 11 (`11.0.100`) e o C# 14, mas a mecânica se aplica a partir do .NET 6, quando os avisos de análise de trim foram emitidos pela primeira vez.

## Por que o trimmer precisa de uma dica

O trimming, e o build [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) que o exige, funcionam por análise de alcançabilidade. O trimmer começa no seu ponto de entrada, percorre cada chamada de método, acesso a campo e referência de tipo que consegue ver estaticamente, marca tudo o que toca como "mantido" e apaga o resto. É assim que um app self-contained encolhe de 70 MB para 15 MB: o framework é enorme e o seu app usa apenas uma fração dele.

A reflexão quebra esse percurso. Quando você escreve `type.GetMethods()`, o trimmer não tem ideia de qual tipo `type` contém em runtime, então não consegue saber quais métodos manter. Ele tem duas opções: manter todos os métodos de todos os tipos que poderiam fluir para aquela chamada (o que derrota o trimming por completo), ou não manter nada e deixar você descobrir em runtime. Ele não faz nem uma coisa nem outra. Em vez disso, os próprios métodos da BCL que usam reflexão são anotados, e o trimmer exige que o `Type` que você passa a eles carregue uma promessa correspondente. `[DynamicallyAccessedMembers]` é como você faz essa promessa.

Olhe a assinatura de `Type.GetMethods()` no código-fonte do .NET e você verá que o método de instância é, na prática, anotado para exigir `PublicMethods` em `this`. Então este helper inofensivo produz um aviso:

```csharp
// .NET 11, C# 14. Compiled with <PublishTrimmed>true</PublishTrimmed>.
static void UseMethods(Type type)
{
    // warning IL2070: 'this' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to
    // 'System.Type.GetMethods()'. The parameter 'type' of method
    // 'UseMethods(Type)' does not have matching annotations.
    foreach (var method in type.GetMethods())
    {
        // ...
    }
}
```

O trimmer está dizendo: estou prestes a deixar você enumerar os métodos públicos de qualquer que seja o `type`, mas ninguém prometeu que esses métodos sobreviveriam ao trimming. Anote a origem do `Type` para que a promessa esteja no sistema de tipos.

## A correção: declare o requisito no parâmetro

A correção é copiar o requisito para o parâmetro que fornece o `Type`:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var method in type.GetMethods()) // no warning
    {
        // ...
    }
}
```

Agora `UseMethods` está satisfeito internamente, mas o requisito não desaparece. Ele se move para os chamadores. Qualquer um que chame `UseMethods` precisa passar a ele um `Type` que, por sua vez, seja sabidamente um que mantém seus métodos públicos. É esse o modelo inteiro: o atributo não preserva nada por si só. Ele é uma anotação de fluxo que empurra a obrigação cadeia de chamadas acima até chegar a um ponto onde o tipo concreto é conhecido.

## Onde a obrigação realmente termina

O requisito para de se propagar em um de dois lugares. O primeiro é `typeof`. Quando você escreve `typeof(Customer)`, o trimmer conhece o tipo exato e consegue preservar o que quer que o destino exija:

```csharp
// .NET 11. typeof gives the trimmer a concrete type, so it keeps
// Customer's public methods and the call is clean.
UseMethods(typeof(Customer));
```

O segundo é uma fronteira de API pública. Se o `Type` vem de um parâmetro, de um campo ou de um valor de retorno de método, você também anota esse local, e a cadeia continua para fora. Aqui está o caso do campo, que é o que as pessoas deixam passar:

```csharp
// .NET 11, C# 14.
static Type _type = typeof(Customer);

static void UseMethodsHelper()
{
    // warning IL2077: 'type' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to 'UseMethods(Type)'.
    // The field '_type' does not have matching annotations.
    UseMethods(_type);
}
```

O campo não carrega nenhuma promessa, então passá-lo para um parâmetro anotado gera aviso. Anote o campo, e agora o trimmer impõe a promessa em cada atribuição feita a esse campo:

```csharp
// .NET 11, C# 14.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type _type = typeof(Customer); // assignment of a concrete type: clean

static void UseMethodsHelper() => UseMethods(_type); // clean
```

Atribua a esse campo anotado algo sobre o qual o trimmer não consiga raciocinar (um parâmetro `Type` não anotado, um `Type.GetType("…")` a partir de uma string em runtime) e você recebe um aviso na atribuição. A promessa agora é determinante em ambas as direções.

## As flags de DynamicallyAccessedMemberTypes

O único argumento do construtor é um enum `[Flags]`, então você combina valores com `|` para manter exatamente o que sua reflexão acessa e nada mais. Os valores principais e suas flags numéricas:

| Valor | O que preserva |
| --- | --- |
| `None` | Nada. |
| `PublicParameterlessConstructor` | O construtor público padrão (o que `Activator.CreateInstance(type)` precisa). |
| `PublicConstructors` | Todos os construtores públicos. |
| `NonPublicConstructors` | Todos os construtores não públicos. |
| `PublicMethods` / `NonPublicMethods` | Métodos públicos / não públicos. |
| `PublicFields` / `NonPublicFields` | Campos públicos / não públicos. |
| `PublicProperties` / `NonPublicProperties` | Propriedades públicas / não públicas. |
| `PublicEvents` / `NonPublicEvents` | Eventos públicos / não públicos. |
| `PublicNestedTypes` / `NonPublicNestedTypes` | Tipos aninhados. |
| `Interfaces` | Interfaces que o tipo implementa. |
| `All` | Tudo (valor `-1`). |

A regra é pedir o mínimo. Se tudo o que você faz é `Activator.CreateInstance(type)`, peça `PublicParameterlessConstructor`, não `All`. Cada flag que você adiciona são membros que o trimmer fica proibido de apagar, o que é tamanho de binário que você paga no app final. `All` é a resposta preguiçosa que silenciosamente desfaz a maior parte do benefício do trimming para aquele tipo.

O .NET 9 e 10 adicionaram uma segunda família de flags `...WithInherited` e `All...`, por exemplo `AllMethods`, `AllConstructors` e `NonPublicMethodsWithInherited`. A flag `PublicMethods` simples já inclui métodos públicos herdados porque eles fazem parte da superfície pública do tipo, mas as variantes não públicas historicamente não percorriam as classes base. As flags `WithInherited` fecham essa lacuna quando você usa reflexão sobre membros privados ou protegidos herdados. Recorra a elas apenas quando sua reflexão realmente cruzar a fronteira de herança.

## Anotando parâmetros de tipo genéricos e valores de retorno

O atributo não está limitado a parâmetros e campos. Seu `AttributeUsage` cobre parâmetros, campos, propriedades, valores de retorno, parâmetros genéricos, classes, interfaces, structs e métodos. Dois desses merecem destaque.

Um parâmetro de tipo genérico pode carregar o requisito, e é assim que você escreve uma factory baseada em reflexão que permanece segura para trimming:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static T Create<[DynamicallyAccessedMembers(
    DynamicallyAccessedMemberTypes.PublicParameterlessConstructor)] T>()
{
    return Activator.CreateInstance<T>(); // clean
}

// The constraint flows to the call site. typeof is implicit in the type argument.
var c = Create<Customer>(); // trimmer keeps Customer's parameterless ctor
```

Aplicar o atributo a um método é um caso especial documentado: ele é tratado como se aplicado ao parâmetro `this`, então só faz sentido em métodos de instância de um tipo atribuível a `Type`. O alvo de valor de retorno permite que um método prometa algo sobre o `Type` que ele devolve:

```csharp
// .NET 11, C# 14. The caller can reflect over public methods of the returned Type.
[return: DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type ResolveHandler(string name) =>
    name == "customer" ? typeof(Customer) : typeof(Order);
```

## Quando o padrão genuinamente não pode ser anotado

Às vezes o fluxo de dados é real e correto, mas o analisador não consegue segui-lo, por exemplo um `Type[]` em que você sabe, por construção, que cada elemento mantém seu construtor, mas o trimmer não consegue enxergar essa invariante. Para esses casos, `[UnconditionalSuppressMessage]` silencia um aviso específico e, ao contrário de `[SuppressMessage]`, é persistido no IL para que a análise de trim o respeite:

```csharp
// .NET 11, C# 14.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only ever holds types stored through the annotated setter.")]
get => _types[i];
```

Essa é uma promessa que você está fazendo sob palavra de honra. A documentação é direta ao dizer que só é válido suprimir quando os membros sobre os quais se reflete são alvos de reflexão genuínos em outras partes do programa, porque membros que não são alvos de reflexão visíveis podem ser inlinados, renomeados ou movidos pelo otimizador, e o seu código suprimido vai então quebrar de um jeito que nenhum aviso previu.

A outra válvula de escape é `[DynamicDependency]`, que mantém membros nomeados, mas não informa a análise. É um último recurso para padrões que nem mesmo `[DynamicallyAccessedMembers]` consegue expressar, como carregar um membro por string de um assembly separado:

```csharp
// .NET 11, C# 14.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

Se você se vê recorrendo a qualquer uma das válvulas de escape em muitos pontos de chamada, esse é o sinal de que a API é fundamentalmente moldada por reflexão e deveria ser substituída por geração de código em tempo de compilação. Serializadores e mapeadores baseados em reflexão são o exemplo canônico: em vez de anotar tudo ao redor de percursos de `GetProperties()`, você adota um gerador de código-fonte que emite o código de acesso em tempo de build. Se esse termo for novo para você, [o que é um gerador de código-fonte e quando você precisa de um](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) é a introdução, e é a razão pela qual existe o `System.Text.Json` com gerador de código-fonte.

## Como isso se relaciona com RequiresUnreferencedCode

É fácil confundir `[DynamicallyAccessedMembers]` com `[RequiresUnreferencedCode]`. Eles resolvem problemas adjacentes. `[DynamicallyAccessedMembers]` é para reflexão analisável: você sabe exatamente quais membros de um `Type` você acessa, então declara isso e o trimmer os mantém. `[RequiresUnreferencedCode]` é para reflexão que não pode ser tornada segura para trimming de jeito nenhum, uma admissão de que o método faz algo que o trimmer não consegue modelar. Anotar um método com ele não conserta nada; ele propaga um aviso `IL2026` para cada chamador, do mesmo modo que `[DynamicallyAccessedMembers]` propaga seu requisito, até o aviso chegar a uma API pública onde o autor da biblioteca pode documentar a limitação. Use `[DynamicallyAccessedMembers]` quando você consegue expressar o requisito e recorra a `[RequiresUnreferencedCode]` apenas quando você genuinamente não consegue.

O fluxo de trabalho prático é o mesmo que rege toda a história de trimming e AOT: ligue o analisador, trate cada aviso `IL2xxx` como um defeito real e não como ruído, e leve a contagem a zero antes de publicar. Defina `<IsTrimmable>true</IsTrimmable>` em uma biblioteca para obter avisos restritos àquele projeto, ou compile um pequeno app de teste de trimming com `<PublishTrimmed>true</PublishTrimmed>` e uma entrada `TrimmerRootAssembly` para ver todos os avisos por todo o grafo de dependências. Um build limpo é o contrato. Quando uma chamada incompatível com AOT escapa do analisador e só falha em runtime, você está de volta a depurar uma [PlatformNotSupportedException no Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/), que é exatamente a falha silenciosa que essas anotações existem para evitar. E se você está montando isso para um serviço web real, [como usar Native AOT com minimal APIs do ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) percorre a receita de build limpo de ponta a ponta.

O modelo mental que faz tudo isso se encaixar: `[DynamicallyAccessedMembers]` não preserva código. Ele propaga um requisito ao longo do fluxo de um valor `Type`, da chamada de reflexão de volta até onde quer que aquele `Type` tenha nascido, e a preservação acontece apenas no `typeof` ou na atribuição concreta onde o requisito finalmente aterrissa. Acerte esse fluxo e o trimming deixa de ser uma fonte de crashes misteriosos que só ocorrem em produção e passa a ser um recurso de compilador no qual você pode de fato confiar.

## Relacionados

- [O que é Native AOT e quanto ele custa para você?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) explica por que o trimming é obrigatório sob AOT e o que mais você abre mão.
- [O que é um gerador de código-fonte e quando preciso de um?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) cobre a geração de código em tempo de compilação que substitui a reflexão que você não consegue anotar.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) é o passo a passo de build limpo onde esses avisos aparecem na prática.
- [Correção: PlatformNotSupportedException no Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) é a falha em runtime que um build anotado e sem avisos previne.

## Fontes

- [DynamicallyAccessedMembersAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembersattribute), MS Learn (definição, alvos de AttributeUsage, o caso especial do método-como-this).
- [DynamicallyAccessedMemberTypes Enum](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembertypes), MS Learn (a lista completa de flags, incluindo as adições WithInherited do .NET 9/10).
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (exemplos de IL2070/IL2077, UnconditionalSuppressMessage, DynamicDependency, recomendações).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (catálogo de avisos e o modelo de fluxo de dados).
