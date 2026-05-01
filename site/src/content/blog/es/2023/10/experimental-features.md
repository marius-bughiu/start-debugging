---
title: "C# Cómo marcar características como experimentales"
description: "A partir de C# 12, un nuevo ExperimentalAttribute te permite marcar tipos, métodos, propiedades o ensamblados como experimentales. Aprende a usarlo con diagnosticId, etiquetas pragma y UrlFormat."
pubDate: 2023-10-29
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/experimental-features"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de C# 12, se introduce un nuevo `ExperimentalAttribute` que te permite marcar tipos, métodos, propiedades o ensamblados como características experimentales. Esto disparará una advertencia del compilador al usarlos, que puede deshabilitarse mediante una etiqueta `#pragma`.

El atributo `Experimental` requiere que se pase un parámetro `diagnosticId` en el constructor. Ese ID de diagnóstico formará parte del mensaje de error del compilador que se genera cada vez que se utiliza la característica experimental. Nota: si quieres, puedes usar el mismo diagnostic-id en varios atributos.

**Importante:** No uses guiones (`-`) ni otros caracteres especiales en tu `diagnosticId`, ya que podrían romper la sintaxis del `#pragma` e impedir que los usuarios deshabiliten la advertencia. Por ejemplo, usar `BAR-001` como diagnostic id no permitirá suprimir la advertencia y disparará una advertencia del compilador en la etiqueta pragma.

> CS1696 Single-line comment or end-of-line expected.

[![](/wp-content/uploads/2023/10/image-3.png)](/wp-content/uploads/2023/10/image-3.png)

También puedes especificar un `UrlFormat` dentro del atributo para guiar a los desarrolladores hacia la documentación relacionada con la característica experimental. Puedes especificar una URL absoluta, como `https://acme.com/warnings/BAR001`, o una URL con un formato de cadena genérico (`https://acme.com/warnings/{0}`) y dejar que el framework haga su magia.

Veamos algunos ejemplos.

## Marcar un método como experimental

```cs
using System.Diagnostics.CodeAnalysis;

[Experimental("BAR001")]
void Foo() { }
```

Simplemente anotas el método con el atributo `Experimental` y le proporcionas un `diagnosticId`. Cuando se hace una llamada a `Foo()`, se generará la siguiente advertencia del compilador:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.

Puedes evitar esta advertencia usando etiquetas pragma:

```cs
#pragma warning disable BAR001
Foo();
#pragma warning restore BAR001
```

## Especificar un enlace a la documentación

Como se mencionó arriba, puedes especificar un enlace a la documentación usando la propiedad `UrlFormat` del atributo. Esto es totalmente opcional.

```cs
[Experimental("BAR001", UrlFormat = "https://acme.com/warnings/{0}")]
void Foo() { }
```

Al hacerlo, al pulsar sobre los códigos de error en Visual Studio se te llevará a la página de documentación indicada. Y, además, también incluirá la URL en el mensaje de error de diagnóstico:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed. (https://acme.com/warnings/BAR001)

## Otros usos

El atributo se puede usar en casi cualquier lugar que imagines. En ensamblados, módulos, clases, structs, enums, propiedades, campos, eventos, lo que quieras. Para ver una lista completa de usos permitidos podemos consultar su definición:

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
