---
title: "Asignación condicional nula en C# 14: usar ?. y ?[] en el lado izquierdo"
description: "C# 14 extiende los operadores condicionales nulos para que funcionen en el lado izquierdo de las asignaciones, eliminando verificaciones de null verbosas al asignar propiedades o indexadores."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "null-safety"
lang: "es"
translationOf: "2026/02/csharp-14-null-conditional-assignment"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 trae un cambio pequeño pero impactante: los operadores condicionales nulos `?.` y `?[]` ahora funcionan en el lado izquierdo de las asignaciones. Esto elimina un patrón común de envolver asignaciones de propiedades en verificaciones de null.

## El patrón verboso que reemplaza

Antes de C# 14, asignar a una propiedad solo cuando un objeto no es null requería verificaciones explícitas:

```csharp
if (customer is not null)
{
    customer.LastOrderDate = DateTime.UtcNow;
}

if (settings is not null)
{
    settings["theme"] = "dark";
}
```

Con objetos profundamente anidados, esto se volvía peor:

```csharp
if (order?.Customer?.Address is not null)
{
    order.Customer.Address.IsVerified = true;
}
```

## Asignación condicional nula en C# 14

C# 14 te permite escribir la misma lógica de forma más concisa:

```csharp
customer?.LastOrderDate = DateTime.UtcNow;

settings?["theme"] = "dark";

order?.Customer?.Address?.IsVerified = true;
```

La asignación solo se ejecuta si el lado izquierdo evalúa a una referencia no nula. El lado derecho nunca se evalúa cuando el destino es null.

## Cómo funciona

La expresión `P?.A = B` es equivalente a:

```csharp
if (P is not null)
{
    P.A = B;
}
```

Con una diferencia importante: `P` se evalúa solo una vez. Esto importa cuando `P` es una llamada a método o tiene efectos secundarios.

## Operadores de asignación compuesta

La asignación condicional nula también funciona con operadores compuestos como `+=`, `-=`, `*=` y otros:

```csharp
inventory?.StockLevel += restockAmount;

counter?.Value -= 1;

account?.Balance *= interestRate;
```

Cada uno de estos evalúa el lado izquierdo una sola vez y aplica la operación solo si el destino no es null.

## Incremento y decremento no se permiten

Una limitación: los operadores `++` y `--` no se pueden usar con la asignación condicional nula. Esto no compila:

```csharp
// Error: ++ and -- not allowed
counter?.Value++;
```

Usa la asignación compuesta en su lugar:

```csharp
counter?.Value += 1;
```

## Ejemplo práctico: manejadores de eventos

Un caso de uso común es asignar manejadores de eventos de forma condicional:

```csharp
public void Initialize(Button? submitButton, Button? cancelButton)
{
    submitButton?.Click += OnSubmit;
    cancelButton?.Click += OnCancel;
}
```

Sin la asignación condicional nula, necesitarías verificaciones de null separadas para cada botón.

## Encadenamiento con indexadores

El operador `?[]` funciona de la misma manera para asignaciones de indexadores:

```csharp
Dictionary<string, string>? headers = GetHeaders();

headers?["Authorization"] = $"Bearer {token}";
headers?["Content-Type"] = "application/json";
```

Si `headers` es null, ninguna asignación se ejecuta y no se lanza ninguna excepción.

## Cuándo usarlo

La asignación condicional nula funciona mejor cuando:
- Tienes objetos opcionales que pueden o no necesitar actualizaciones
- Estás trabajando con tipos de referencia anulables y quieres evitar verificaciones de null verbosas
- La asignación es una operación de "fire-and-forget" donde no necesitas saber si se ejecutó

La característica está disponible en .NET 10 con C# 14. Configura `<LangVersion>14</LangVersion>` en tu archivo de proyecto para habilitarla.

Para la especificación completa, consulta [Asignación condicional nula en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/null-conditional-assignment).
