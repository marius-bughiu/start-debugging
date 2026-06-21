---
title: "Jerarquías de clases cerradas en C# 15: la palabra clave closed en .NET 11 Preview 5"
description: "C# 15 agrega el modificador closed en .NET 11 Preview 5, dando a las jerarquías de clases exhaustividad en tiempo de compilación en las expresiones switch. Asi funciona y el unico detalle a tener en cuenta."
pubDate: 2026-06-21
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-21
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) se lanzo el 9 de junio de 2026, y dentro del trabajo del lenguaje C# 15 se cuela una característica que corrige en silencio una de las brechas mas antiguas del sistema de tipos: no había forma de indicarle al compilador "esta clase base tiene exactamente estos subtipos". Ahora si la hay. El nuevo modificador `closed` declara una jerarquía de clases cerrada, y las expresiones switch sobre ella obtienen verificación completa de exhaustividad en tiempo de compilación.

Esta es la pieza complementaria de las [uniones de tipos](/es/2026/04/csharp-15-union-types-dotnet-11-preview-2/). Las uniones componen tipos no relacionados; las jerarquías cerradas bloquean un árbol de herencia que ya posees. Juntas le dan a C# una historia de exhaustividad completa.

## Que hace closed en realidad

Marca una clase base como `closed` y el compilador solo permite subtipos directos que vivan en el mismo ensamblado. Como el conjunto de subtipos ahora es conocido y finito, el compilador puede verificar que un `switch` maneje cada caso alcanzable.

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

static string Describe(GateState state) => state switch
{
    Closed => "closed",
    Open(var percent) => $"{percent}% open"
};
```

Sin rama `default`, sin patrón de descarte, sin `throw new InvalidOperationException("unreachable")`. El compilador ya sabe que `Closed` y `Open` son las únicas opciones. Agrega un tercer subtipo mas adelante y cada switch no exhaustivo se enciende con una advertencia, que es exactamente la red de seguridad para refactorizaciones que los patrones de clase sellada mas visitante nunca te dieron.

## Las reglas que muerden

Vale la pena memorizar algunas restricciones:

- Una clase `closed` es **implícitamente abstracta**. No puedes instanciar la base directamente, y no puedes combinar `closed` con `sealed`, `static` ni un modificador `abstract` explícito.
- Los subtipos directos deben declararse en el **mismo ensamblado**. La herencia entre ensamblados esta bloqueada, que es lo que hace que el conjunto cerrado sea conocible.
- Aplica a clases y `record class`, pero **no a structs**.

## El unico detalle a tener en cuenta en Preview 5

Aquí esta la parte que te hará tropezar. El compilador emite un marcador `System.Runtime.CompilerServices.ClosedAttribute`, pero el runtime en Preview 5 todavía no incluye ese atributo. Hasta que lo haga, cada proyecto que use `closed` tiene que declarar el atributo por su cuenta:

```csharp
namespace System.Runtime.CompilerServices;

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class ClosedAttribute : Attribute { }
```

Coloca eso en cualquier archivo del proyecto y la característica compila. Espera que desaparezca en una preview posterior una vez que la BCL lleve el tipo. Este es el impuesto habitual de las previews, así que no incrustes el parche en una biblioteca compartida que planeas publicar.

Las jerarquías cerradas, los enums cerrados y las uniones de tipos están todos detrás de `<LangVersion>preview</LangVersion>` en C# 15 hoy, rumbo a la disponibilidad general con .NET 11 en noviembre de 2026. Si alguna vez escribiste un switch con un default inalcanzable solo para satisfacer al compilador, esta es la característica que por fin lo elimina. Todos los detalles están en las [notas de la versión de C# de Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/csharp.md).
