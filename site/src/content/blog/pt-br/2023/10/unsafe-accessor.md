---
title: "C# UnsafeAccessor: membros privados sem reflexão (.NET 8)"
description: "Use o atributo `[UnsafeAccessor]` no .NET 8 para ler campos privados e chamar métodos privados sem overhead, sem reflexão e totalmente compatível com AOT."
pubDate: 2023-10-31
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
A reflexão permite obter informações de tipo em tempo de execução e usar essas informações para acessar membros privados de uma classe. Isso pode ser bastante útil ao lidar com classes que estão fora do seu controle, fornecidas por um pacote de terceiros. Apesar de poderosa, a reflexão também é bem lenta, o que é um dos principais motivos para evitá-la. Não mais.

O .NET 8 traz uma nova forma de acessar membros privados sem overhead por meio do atributo `UnsafeAccessor`. O atributo pode ser aplicado a um método `extern static`. A implementação do método é fornecida pelo runtime com base nas informações do atributo e na assinatura do método. Se nenhuma correspondência for encontrada para as informações fornecidas, a chamada do método lançará uma `MissingFieldException` ou uma `MissingMethodException`.

Vamos ver alguns exemplos de uso do `UnsafeAccessor`. Considere a seguinte classe com membros privados:

```cs
class Foo
{
    private Foo() { }
    private Foo(string value) 
    {
        InstanceProperty = value;
    }

    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";

    private int instanceField = 1;
    private static int staticField = 2;

    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}
```

## Criando instâncias de objeto usando construtores privados

Como descrito acima, começamos declarando os métodos `static extern`.

-   anotamos os métodos com o atributo `UnsafeAccessor`: `[UnsafeAccessor(UnsafeAccessorKind.Constructor)]`
-   e fazemos com que as assinaturas dos construtores correspondam. No caso de construtores, o tipo de retorno precisa ser o tipo da classe para a qual estamos redirecionando (`Foo`). A lista de parâmetros também precisa coincidir.
-   o nome do método extern não precisa corresponder a nada nem seguir uma convenção específica. Algo importante que você vai perceber é que não é possível ter dois métodos `extern static` com o mesmo nome e parâmetros diferentes, similar a sobrecarga, então você precisa fornecer nomes únicos para cada sobrecarga.

Você deve terminar com algo assim:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructor();

[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructorWithParameters(string value);
```

A partir desse ponto, criar instâncias de objeto usando os construtores privados é trivial.

```cs
var instance1 = PrivateConstructor();
var instance2 = PrivateConstructorWithParameters("bar");
```

## Invocando métodos privados de instância

O primeiro argumento do método `extern static` será uma instância de objeto do tipo que contém o método privado. Os demais argumentos precisam coincidir com a assinatura do método que estamos chamando. O tipo de retorno também precisa coincidir.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
extern static string InstanceMethod(Foo @this, int value);

Console.WriteLine(InstanceMethod(instance1, 42)); 
// Output: "instance-method:42"
```

## Lendo / escrevendo propriedades privadas de instância

Você vai notar que não existe `UnsafeAccessorKind.Property`. Isso porque, assim como acontece com métodos de instância, propriedades de instância podem ser acessadas pelos seus métodos getter e setter:

-   `get_{PropertyName}`
-   `set_{PropertyName}`

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
extern static string InstanceGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
extern static void InstanceSetter(Foo @this, string value);

Console.WriteLine(InstanceGetter(instance1));
// Output: "instance-property"

InstanceSetter(instance1, "bar");

Console.WriteLine(InstanceGetter(instance1));
// Output: "bar"
```

## Métodos e propriedades estáticos

Eles se comportam de forma idêntica aos membros de instância, com a única diferença de que você precisa especificar `UnsafeAccessorKind.StaticMethod` no atributo `UnsafeAccessor`. Você precisa, inclusive, fornecer uma instância de objeto desse tipo na hora de fazer a chamada.

E classes `static`? Classes estáticas atualmente não são suportadas por `UnsafeAccessor`. Existe uma proposta de API que pretende preencher essa lacuna, mirando o .NET 9: [\[API Proposal\]: UnsafeAccessorTypeAttribute for static or private type access](https://github.com/dotnet/runtime/issues/90081)

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
extern static string StaticMethod(Foo @this, int value);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
extern static string StaticGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
extern static void StaticSetter(Foo @this, string value);
```

## Campos privados

Os campos são um pouco mais especiais em termos de sintaxe do método `extern static`. Não temos mais métodos getter e setter disponíveis, então usamos a palavra-chave `ref` para obter uma referência ao campo, que podemos usar tanto para ler quanto para escrever o valor.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
extern static ref int InstanceField(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
extern static ref int StaticField(Foo @this);

// Read the field value
var x = InstanceField(instance1);
var y = StaticField(instance1);

// Update the field value
InstanceField(instance1) = 3;
StaticField(instance1) = 4;
```

Quer testar esse recurso? Você pode [encontrar todos os exemplos acima no GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor/Program.cs).
