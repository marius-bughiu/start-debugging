---
title: "Atribuição condicional nula em C# 14: usando ?. e ?[] no lado esquerdo"
description: "C# 14 estende os operadores condicionais nulos para funcionarem no lado esquerdo de atribuições, eliminando verificações de null verbosas ao definir propriedades ou indexadores."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "null-safety"
lang: "pt-br"
translationOf: "2026/02/csharp-14-null-conditional-assignment"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 traz uma mudança pequena mas impactante: os operadores condicionais nulos `?.` e `?[]` agora funcionam no lado esquerdo de atribuições. Isso elimina um padrão comum de envolver atribuições de propriedades em verificações de null.

## O padrão verboso que ele substitui

Antes do C# 14, atribuir a uma propriedade somente quando um objeto não é null exigia verificações explícitas:

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

Com objetos profundamente aninhados, isso ficava pior:

```csharp
if (order?.Customer?.Address is not null)
{
    order.Customer.Address.IsVerified = true;
}
```

## Atribuição condicional nula em C# 14

C# 14 permite que você escreva a mesma lógica de forma mais concisa:

```csharp
customer?.LastOrderDate = DateTime.UtcNow;

settings?["theme"] = "dark";

order?.Customer?.Address?.IsVerified = true;
```

A atribuição só é executada se o lado esquerdo avaliar para uma referência não nula. O lado direito nunca é avaliado quando o destino é null.

## Como funciona

A expressão `P?.A = B` é equivalente a:

```csharp
if (P is not null)
{
    P.A = B;
}
```

Com uma diferença importante: `P` é avaliado apenas uma vez. Isso importa quando `P` é uma chamada de método ou tem efeitos colaterais.

## Operadores de atribuição composta

A atribuição condicional nula também funciona com operadores compostos como `+=`, `-=`, `*=` e outros:

```csharp
inventory?.StockLevel += restockAmount;

counter?.Value -= 1;

account?.Balance *= interestRate;
```

Cada um deles avalia o lado esquerdo uma vez e aplica a operação somente se o destino não for null.

## Incremento e decremento não são permitidos

Uma limitação: os operadores `++` e `--` não podem ser usados com atribuição condicional nula. Isso não compila:

```csharp
// Error: ++ and -- not allowed
counter?.Value++;
```

Use atribuição composta no lugar:

```csharp
counter?.Value += 1;
```

## Exemplo prático: manipuladores de eventos

Um caso de uso comum é definir manipuladores de eventos condicionalmente:

```csharp
public void Initialize(Button? submitButton, Button? cancelButton)
{
    submitButton?.Click += OnSubmit;
    cancelButton?.Click += OnCancel;
}
```

Sem a atribuição condicional nula, você precisaria de verificações de null separadas para cada botão.

## Encadeamento com indexadores

O operador `?[]` funciona da mesma forma para atribuições de indexadores:

```csharp
Dictionary<string, string>? headers = GetHeaders();

headers?["Authorization"] = $"Bearer {token}";
headers?["Content-Type"] = "application/json";
```

Se `headers` for null, nenhuma das atribuições é executada e nenhuma exceção é lançada.

## Quando usar

A atribuição condicional nula funciona melhor quando:
- Você tem objetos opcionais que podem ou não precisar de atualizações
- Você está trabalhando com tipos de referência anuláveis e quer evitar verificações de null verbosas
- A atribuição é uma operação fire-and-forget na qual você não precisa saber se foi executada

O recurso está disponível no .NET 10 com C# 14. Defina `<LangVersion>14</LangVersion>` no arquivo do seu projeto para habilitá-lo.

Para a especificação completa, consulte [Atribuição condicional nula no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/null-conditional-assignment).
