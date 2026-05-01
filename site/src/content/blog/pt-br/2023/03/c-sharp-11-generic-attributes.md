---
title: "C# 11 - Atributos genéricos"
description: "Aprenda a definir e usar atributos genéricos no C# 11, incluindo restrições nos argumentos de tipo e mensagens de erro comuns."
pubDate: 2023-03-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/03/c-sharp-11-generic-attributes"
translatedBy: "claude"
translationDate: 2026-05-01
---
Pessoal, atributos genéricos finalmente chegaram ao C#! 🥳

Você pode definir um da mesma forma que define qualquer outra classe genérica:

```cs
public class GenericAttribute<T> : Attribute { }
```

E usá-lo como qualquer outro atributo:

```cs
[GenericAttribute<string>]
public class MyClass { }
```

## Restrições de atributos genéricos

Ao aplicar o atributo, todos os argumentos de tipo genérico devem ser fornecidos. Em outras palavras, o atributo genérico precisa estar totalmente construído.

Por exemplo, isso não vai funcionar:

```cs
public class MyGenericType<T>
{
    [GenericAttribute<T>()]
    public string Foo { get; set; }
}
```

Tipos que exigem anotações de metadados não são permitidos como argumentos de tipo de atributo genérico. Vejamos alguns exemplos do que não é permitido e suas alternativas:

-   `dynamic` não é permitido. Use `object` em seu lugar
-   tipos de referência anuláveis não são permitidos. Em vez de `string?` você pode simplesmente usar `string`
-   tipos de tupla com a sintaxe de tuplas do C# não são permitidos. Você pode usar `ValueTuple` em seu lugar (por exemplo, `ValueTuple<string, int>` em vez de `(string foo, int bar)`)

## Erros

> CS8968 'T': an attribute type argument cannot use type parameters

Esse erro significa que você não especificou todos os argumentos de tipo para o seu atributo. Atributos genéricos precisam estar totalmente construídos, o que significa que você não pode usar parâmetros **T** ao aplicá-los (veja os exemplos acima).

> CS8970 Type 'string' cannot be used in this context because it cannot be represented in metadata.

Tipos de referência anuláveis não são permitidos como parâmetros de tipo em atributos genéricos. Use `string` em vez de `string?`.

> CS8970 Type 'dynamic' cannot be used in this context because it cannot be represented in metadata.

`dynamic` não pode ser usado como argumento de tipo de um atributo genérico. Use `object` em seu lugar.

> CS8970 Type '(string foo, int bar)' cannot be used in this context because it cannot be represented in metadata.

Tuplas não são permitidas como parâmetro de tipo em atributos genéricos. Use o `ValueTuple` equivalente.
