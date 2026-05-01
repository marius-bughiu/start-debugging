---
title: "C# 11 - Generische Attribute"
description: "Erfahren Sie, wie Sie generische Attribute in C# 11 definieren und nutzen, einschließlich Einschränkungen für Typargumente und gängiger Fehlermeldungen."
pubDate: 2023-03-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/03/c-sharp-11-generic-attributes"
translatedBy: "claude"
translationDate: 2026-05-01
---
Endlich gibt es generische Attribute auch in C#! 🥳

Sie definieren eines genauso wie jede andere generische Klasse:

```cs
public class GenericAttribute<T> : Attribute { }
```

Und verwenden es wie jedes andere Attribut:

```cs
[GenericAttribute<string>]
public class MyClass { }
```

## Einschränkungen für generische Attribute

Beim Anwenden des Attributs müssen alle generischen Typargumente angegeben werden. Mit anderen Worten: Das generische Attribut muss vollständig konstruiert sein.

Folgendes funktioniert beispielsweise nicht:

```cs
public class MyGenericType<T>
{
    [GenericAttribute<T>()]
    public string Foo { get; set; }
}
```

Typen, die Metadaten-Annotationen erfordern, sind als Typargumente generischer Attribute nicht zulässig. Sehen wir uns einige Beispiele für Unzulässiges und die Alternativen an:

-   `dynamic` ist nicht erlaubt. Verwenden Sie stattdessen `object`
-   nullbare Referenztypen sind nicht erlaubt. Anstelle von `string?` können Sie einfach `string` verwenden
-   Tupeltypen mit der C#-Tupel-Syntax sind nicht erlaubt. Sie können stattdessen `ValueTuple` verwenden (z. B. `ValueTuple<string, int>` statt `(string foo, int bar)`)

## Fehler

> CS8968 'T': an attribute type argument cannot use type parameters

Dieser Fehler bedeutet, dass Sie nicht alle Typargumente für Ihr Attribut angegeben haben. Generische Attribute müssen vollständig konstruiert sein, das heißt, Sie können beim Anwenden keine **T**-Parameter verwenden (siehe die Beispiele oben).

> CS8970 Type 'string' cannot be used in this context because it cannot be represented in metadata.

Nullbare Referenztypen sind als Typparameter in generischen Attributen nicht erlaubt. Verwenden Sie `string` statt `string?`.

> CS8970 Type 'dynamic' cannot be used in this context because it cannot be represented in metadata.

`dynamic` kann nicht als Typargument für ein generisches Attribut verwendet werden. Verwenden Sie stattdessen `object`.

> CS8970 Type '(string foo, int bar)' cannot be used in this context because it cannot be represented in metadata.

Tupel sind als Typparameter in generischen Attributen nicht erlaubt. Verwenden Sie stattdessen das äquivalente `ValueTuple`.
