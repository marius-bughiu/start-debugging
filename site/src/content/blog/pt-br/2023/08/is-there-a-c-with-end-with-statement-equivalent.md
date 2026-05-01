---
title: "Existe em C# um equivalente à instrução With...End With?"
description: "A instrução With...End With do VB permite executar uma série de comandos que se referem repetidamente a um único objeto, usando uma sintaxe simplificada para acessar seus membros. Existe um equivalente em C#? Não. O mais próximo seriam os inicializadores de objeto, mas eles só servem para instanciar objetos novos."
pubDate: 2023-08-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/08/is-there-a-c-with-end-with-statement-equivalent"
translatedBy: "claude"
translationDate: 2026-05-01
---
A instrução With...End With do VB permite executar uma série de comandos que se referem repetidamente a um único objeto. Assim, os comandos podem usar uma sintaxe simplificada para acessar os membros do objeto. Por exemplo:

```vb
With car
    .Make = "Mazda"
    .Model = "MX5"
    .Year = 1989
End With
```

## Existe um equivalente sintático em C#?

Não. Não existe. O mais próximo seriam os inicializadores de objeto, mas eles só servem para instanciar objetos novos; não podem ser usados para atualizar instâncias já existentes, como a instrução with permite.

Por exemplo, ao criar uma nova instância de um objeto você pode usar o inicializador de objeto:

```cs
var car = new Car
{
    Make = "Mazda",
    Model = "MX5",
    Year = 1989
};
```

Mas ao atualizar o objeto não há uma sintaxe simplificada equivalente. Você teria que referenciar o objeto em cada atribuição ou chamada de membro, assim:

```cs
car.Make = "Aston Martin";
car.Model = "DBS";
car.Year = 1967;
```
