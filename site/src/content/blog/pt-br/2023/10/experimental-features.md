---
title: "C# como marcar recursos como experimentais"
description: "A partir do C# 12, um novo ExperimentalAttribute permite marcar tipos, métodos, propriedades ou assemblies como experimentais. Aprenda a usá-lo com diagnosticId, tags pragma e UrlFormat."
pubDate: 2023-10-29
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/experimental-features"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do C# 12 chega o novo `ExperimentalAttribute`, que permite marcar tipos, métodos, propriedades ou assemblies como recursos experimentais. Isso dispara um aviso do compilador no uso, que pode ser desligado por uma tag `#pragma`.

O atributo `Experimental` exige que um parâmetro `diagnosticId` seja passado no construtor. Esse ID de diagnóstico fará parte da mensagem de erro do compilador gerada sempre que o recurso experimental for utilizado. Observação: se quiser, você pode usar o mesmo diagnostic-id em vários atributos.

**Importante:** não use hífens (`-`) ou outros caracteres especiais no seu `diagnosticId`, pois isso pode quebrar a sintaxe do `#pragma` e impedir que os usuários desliguem o aviso. Por exemplo, usar `BAR-001` como diagnostic id não vai permitir suprimir o aviso e ainda dispara um aviso do compilador na tag pragma.

> CS1696 Single-line comment or end-of-line expected.

[![](/wp-content/uploads/2023/10/image-3.png)](/wp-content/uploads/2023/10/image-3.png)

Também é possível especificar um `UrlFormat` dentro do atributo para encaminhar os desenvolvedores à documentação do recurso experimental. Você pode informar uma URL absoluta, como `https://acme.com/warnings/BAR001`, ou uma URL com formatação de string genérica (`https://acme.com/warnings/{0}`) e deixar o framework fazer a mágica.

Vamos ver alguns exemplos.

## Marcando um método como experimental

```cs
using System.Diagnostics.CodeAnalysis;

[Experimental("BAR001")]
void Foo() { }
```

Basta anotar o método com o atributo `Experimental` e fornecer um `diagnosticId`. Ao chamar `Foo()`, o seguinte aviso do compilador será gerado:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.

Você pode contornar esse aviso usando tags pragma:

```cs
#pragma warning disable BAR001
Foo();
#pragma warning restore BAR001
```

## Apontando para a documentação

Como dito acima, você pode informar um link para a documentação por meio da propriedade `UrlFormat` do atributo. Isso é totalmente opcional.

```cs
[Experimental("BAR001", UrlFormat = "https://acme.com/warnings/{0}")]
void Foo() { }
```

Com isso, clicar nos códigos de erro no Visual Studio leva até a página de documentação informada. Além disso, a URL também passa a aparecer na mensagem de erro de diagnóstico:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed. (https://acme.com/warnings/BAR001)

## Outros usos

O atributo pode ser usado em quase qualquer lugar que você imaginar: assemblies, módulos, classes, structs, enums, propriedades, campos, eventos, e por aí vai. Para ver a lista completa de usos permitidos, podemos olhar sua definição:

```cs
[AttributeUsage(AttributeTargets.Assembly |
                AttributeTargets.Module |
                AttributeTargets.Class |
                AttributeTargets.Struct |
                AttributeTargets.Enum |
                AttributeTargets.Constructor |
                AttributeTargets.Method |
                AttributeTargets.Property |
                AttributeTargets.Field |
                AttributeTargets.Event |
                AttributeTargets.Interface |
                AttributeTargets.Delegate, Inherited = false)]
public sealed class ExperimentalAttribute : Attribute { ... }
```
