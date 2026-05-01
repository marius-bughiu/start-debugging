---
title: "C# Acessar o campo de apoio de uma propriedade privada usando Unsafe Accessor"
description: "Use UnsafeAccessorAttribute no .NET 8 para acessar os campos de apoio autogerados de propriedades automáticas privadas em C# sem reflexão."
pubDate: 2023-11-08
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/c-access-private-property-backing-field-using-unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um recurso pouco conhecido do `UnsafeAccessorAttribute` é que ele também permite acessar os campos de apoio autogerados de propriedades automáticas, campos com nomes impronunciáveis.

A forma de acessá-los é muito parecida com a de acessar campos, com a única diferença sendo o padrão do nome do membro, que se parece com isto:

```plaintext
<MyProperty>k__BackingField
```

Vamos usar a seguinte classe como exemplo:

```cs
class Foo
{
    private string InstanceProperty { get; set; } = "instance-property";
}
```

Abaixo você encontra o unsafe accessor para o campo de apoio dessa propriedade e exemplos de como ler o campo de apoio privado e como modificar seu valor.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<InstanceProperty>k__BackingField")]
extern static ref string InstancePropertyBackingField(Foo @this);

var instance = new Foo();

// Read
_ = InstancePropertyBackingField(instance);

// Modify
InstancePropertyBackingField(instance) = Guid.NewGuid().ToString();
```
