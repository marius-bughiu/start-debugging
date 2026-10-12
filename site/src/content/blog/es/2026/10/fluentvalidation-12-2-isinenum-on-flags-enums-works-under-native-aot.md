---
title: "FluentValidation 12.2 corrige el fallo de IsInEnum() en apps native AOT con enums [Flags]"
description: "FluentValidation 12.2.0, publicada el 10 de octubre de 2026, reemplaza Enum.GetValues por Enum.GetValuesAsUnderlyingType dentro de EnumValidator, así que IsInEnum() sobre un enum [Flags] ya no lanza NotSupportedException en un binario native AOT."
pubDate: 2026-10-12
tags:
  - "fluentvalidation"
  - "native-aot"
  - "dotnet"
  - "csharp"
  - "validation"
lang: "es"
translationOf: "2026/10/fluentvalidation-12-2-isinenum-on-flags-enums-works-under-native-aot"
translatedBy: "claude"
translationDate: 2026-10-12
---

[FluentValidation 12.2.0](https://github.com/FluentValidation/FluentValidation/releases/tag/12.2.0) llegó a NuGet el 10 de octubre de 2026. La mayor parte del changelog es mantenimiento (mensajes en lituano y bielorruso, un par de correcciones en `PropertyChain`), pero una línea importa mucho si publicas con `PublishAot`: "Change EnumValidator to work under native AOT". Antes de esta versión, `RuleFor(x => x.Access).IsInEnum()` sobre un enum `[Flags]` compilaba, pasaba todas las pruebas basadas en JIT y luego hacía fallar el binario nativo publicado en la primera llamada de validación.

## Cómo se veía el fallo

Aquí tienes una app mínima. Es la forma que encontrarías en cualquier minimal API publicada con AOT que valide un enum de permisos u opciones:

```csharp
using FluentValidation;

var v = new GrantValidator();
Console.WriteLine(v.Validate(new Grant(Access.Read | Access.Write)).IsValid);
Console.WriteLine(v.Validate(new Grant((Access)64)).IsValid);

[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Delete = 4 }

public record Grant(Access Access);

public class GrantValidator : AbstractValidator<Grant>
{
    public GrantValidator() => RuleFor(x => x.Access).IsInEnum();
}
```

La publiqué con `<PublishAot>true</PublishAot>` en el SDK de .NET 10.0.302 (osx-arm64), una vez contra FluentValidation 12.1.1 y otra contra 12.2.0. Con 12.1.1 el binario muere de inmediato:

```text
Unhandled exception. System.NotSupportedException: 'Access[]' is missing native code or metadata.
   at System.Array.CreateInstance(Type, Int32) + 0x5c
   at System.RuntimeType.GetEnumValues() + 0x88
```

Con 12.2.0 el mismo código imprime `True` y `False`, que es la respuesta correcta para una combinación válida y un bit no definido.

## Por qué solo se veían afectados los enums [Flags]

`EnumValidator` toma dos caminos. Los enums sin flags pasan por `Enum.IsDefined`, que siempre ha sido seguro para AOT. Los enums con flags pasan por un método privado `EvaluateFlagEnumValues` que construye una máscara a partir de cada valor declarado, y en 12.1.x lo hacía con `Enum.GetValues(Type)`. Esa sobrecarga está marcada con `[RequiresDynamicCode]` porque tiene que asignar un `Access[]` en runtime, e ILC no puede pregenerar un tipo de arreglo que nunca vio de forma estática.

La publicación sí te avisaba, solo que no en voz alta. De forma predeterminada, el trimmer colapsa las advertencias de terceros en una sola línea:

```text
warning IL3053: Assembly 'FluentValidation' produced AOT analysis warnings.
```

Solo con `-p:TrimmerSingleWarn=false` ves el `IL3050` real que apunta a `EnumValidator.cs(103)` y a `Enum.GetValues(Type)`.

## La corrección de una línea

El [PR #2371](https://github.com/FluentValidation/FluentValidation/pull/2371) reemplaza la llamada por `Enum.GetValuesAsUnderlyingType(enumType)`, disponible desde .NET 8 (que es el target mínimo de FluentValidation 12). Devuelve los valores encapsulados (boxed) como su tipo entero subyacente, así que no se crea ningún arreglo tipado como enum, y el bucle existente con `Convert.ToInt64` sigue funcionando sin cambios. Sin cambios de API, sin cambios de comportamiento, e incluso elimina un ciclo de box/unbox por cada valor.

```csharp
// FluentValidation 12.2.0, EnumValidator.EvaluateFlagEnumValues
foreach (var enumValue in Enum.GetValuesAsUnderlyingType(enumType)) {
    var enumValueAsInt64 = Convert.ToInt64(enumValue);
    // ...
}
```

Con 12.2.0, la advertencia `IL3053` de FluentValidation desaparece por completo de la salida de publicación en este ejemplo.

## La otra corrección que conviene conocer

12.2.0 también corrige `context.PropertyPath` dentro de un `.When()` en `RuleForEach` ([#2363](https://github.com/FluentValidation/FluentValidation/pull/2363)). La condición veía la ruta del elemento anterior (o `null` para el primero), porque el contexto se actualizaba después de ejecutar la condición. Si construyes claves de error o líneas de registro a partir de `PropertyPath` dentro de condiciones, estabas obteniendo rutas desfasadas en uno.

## Qué hacer

Actualiza el paquete:

```bash
dotnet add package FluentValidation --version 12.2.0
```

Si distribuyes con native AOT, configura también `TrimmerSingleWarn` en `false` en CI al menos una vez. Las líneas `IL3053` colapsadas son la vía por la que errores como este llegan a producción. Y si todavía estás decidiendo si necesitas FluentValidation en ASP.NET Core 11, la comparé con la opción integrada en [validación en minimal APIs vs FluentValidation](/es/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/).
