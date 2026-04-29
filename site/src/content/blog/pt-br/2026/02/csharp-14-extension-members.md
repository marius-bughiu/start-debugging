---
title: "Membros de extensão em C# 14: propriedades, operadores e membros estáticos de extensão"
description: "C# 14 introduz membros de extensão, permitindo adicionar propriedades, operadores e membros estáticos de extensão a tipos existentes usando a nova palavra-chave extension."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "pt-br"
translationOf: "2026/02/csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 chega com .NET 10 e traz a evolução mais pedida para métodos de extensão desde sua introdução em C# 3.0. Agora você pode definir propriedades de extensão, operadores de extensão e membros estáticos de extensão usando a nova palavra-chave `extension`.

## De métodos de extensão a blocos de extensão

Antes, adicionar funcionalidade a um tipo que você não possui significava criar uma classe estática com métodos estáticos e um modificador `this`. Esse padrão funcionava para métodos, mas deixava propriedades e operadores fora de alcance.

C# 14 introduz **blocos de extensão**, uma sintaxe dedicada que agrupa membros de extensão relacionados:

```csharp
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsNullOrEmpty => string.IsNullOrEmpty(s);

        public int WordCount => s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

O bloco `extension(string s)` declara que todos os membros dentro estendem `string`. Agora você pode acessá-los como propriedades:

```csharp
string title = "Hello World";
Console.WriteLine(title.IsNullOrEmpty);  // False
Console.WriteLine(title.WordCount);       // 2
```

## Operadores de extensão

Operadores eram antes impossíveis de adicionar a tipos que você não controla. C# 14 muda isso:

```csharp
public static class PointExtensions
{
    extension(Point p)
    {
        public static Point operator +(Point a, Point b)
            => new Point(a.X + b.X, a.Y + b.Y);

        public static Point operator -(Point a, Point b)
            => new Point(a.X - b.X, a.Y - b.Y);
    }
}
```

Agora instâncias de `Point` podem usar `+` e `-` mesmo que o tipo original não os tivesse definido.

## Membros estáticos de extensão

Os blocos de extensão também suportam membros estáticos que aparecem como membros estáticos do tipo estendido:

```csharp
public static class GuidExtensions
{
    extension(Guid)
    {
        public static Guid Empty2 => Guid.Empty;

        public static Guid CreateDeterministic(string input)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
            return new Guid(hash.AsSpan(0, 16));
        }
    }
}
```

Chame como se fosse um membro estático de `Guid`:

```csharp
var id = Guid.CreateDeterministic("user@example.com");
```

## O que ainda não é suportado

C# 14 foca em métodos, propriedades e operadores. Campos, eventos, indexadores, tipos aninhados e construtores não são suportados em blocos de extensão. Eles podem chegar em versões futuras do C#.

## Quando usar membros de extensão

Propriedades de extensão brilham quando você tem valores calculados que parecem propriedades naturais de um tipo. O exemplo `string.WordCount` lê melhor do que `string.GetWordCount()`. Operadores de extensão funcionam bem para tipos matemáticos ou de domínio onde operadores fazem sentido semântico.

O recurso está disponível agora no .NET 10. Atualize seu projeto para `<LangVersion>14</LangVersion>` ou `<LangVersion>latest</LangVersion>` para começar a usar blocos de extensão.

Para a documentação completa, consulte [Membros de extensão no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members).
