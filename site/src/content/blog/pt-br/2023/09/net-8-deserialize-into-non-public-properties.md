---
title: ".NET 8 desserializar em propriedades não públicas"
description: "Aprenda a desserializar JSON em propriedades não públicas no .NET 8 usando o atributo JsonInclude e construtores parametrizados."
pubDate: 2023-09-21
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-deserialize-into-non-public-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
De forma parecida com [serializar para membros não públicos](/2023/09/net-8-include-non-public-members-in-json-serialization/), dá para desserializar para membros não públicos fornecendo um construtor com parâmetros que correspondam aos nomes dos membros não públicos e anotando esses membros com o atributo `JsonInclude`.

Vamos direto a um exemplo:

```cs
public class MyClass
{
    public MyClass(int privateProperty, int protectedProperty, int internalProperty)
    {
        PrivateProperty = privateProperty;
        ProtectedProperty = protectedProperty;
        InternalProperty = internalProperty;
    }

    [JsonInclude]
    private int PrivateProperty { get; }

    [JsonInclude]
    protected int ProtectedProperty { get; }

    [JsonInclude]
    internal int InternalProperty { get; }

    public int PublicProperty { get; set; }
}
```

Repare que não anotamos `PublicProperty` de forma alguma nem a colocamos no construtor. Isso não é necessário, porque a propriedade é pública e tem um setter público, então pode ser atribuída depois que a instância do objeto é criada.

Para testar a desserialização no tipo definido acima, dá para fazer assim:

```cs
string json = "{\"PrivateProperty\":1,\"ProtectedProperty\":2,\"InternalProperty\":3,\"PublicProperty\":4}";
var myObj = JsonSerializer.Deserialize<MyClass>(json);
```

## Lidando com múltiplos construtores na desserialização

Caso a sua classe tenha vários construtores, você precisa indicar ao desserializador qual usar com o [JsonConstructorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonconstructorattribute.-ctor?view=net-8.0).

```cs
public MyClass() { }

[JsonConstructor]
public MyClass(int privateProperty, int protectedProperty, int internalProperty)
{
    PrivateProperty = privateProperty;
    ProtectedProperty = protectedProperty;
    InternalProperty = internalProperty;
}
```
