---
title: "Como resolver: 'Point' não tem um tamanho predefinido, portanto sizeof só pode ser usado em um contexto unsafe"
description: "Resolva o erro de C# em que sizeof não pode ser usado com Point fora de um contexto unsafe. Duas soluções: habilitar código unsafe ou usar Marshal.SizeOf."
pubDate: 2023-11-09
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/how-to-fix-point-does-not-have-a-predefined-size-therefore-sizeof-can-only-be-used-in-an-unsafe-context"
translatedBy: "claude"
translationDate: 2026-05-01
---
O erro que você está enfrentando ocorre porque, em C#, `sizeof` só pode ser usado com tipos que têm um tamanho predefinido conhecido em tempo de compilação, e a estrutura `Point` não é um desses tipos a menos que você esteja em um contexto unsafe.

Existem duas formas de resolver isso.

## Usar código `unsafe`

Isso permitiria usar o operador `sizeof` com tipos de qualquer tamanho. Para fazê-lo, você precisará marcar seu método com a palavra-chave `unsafe` e também habilitar código unsafe nas configurações de build do seu projeto.

Basicamente, a assinatura do seu método muda para isto:

```cs
public static unsafe void YourMethod()
{
    // ... your unsafe code
    // IntPtr sizeOfPoint = (IntPtr)sizeof(Point);
}
```

E para permitir código unsafe, vá até as propriedades do projeto, à aba `Build`, e marque a opção "Allow unsafe code". Depois disso, o erro de compilação deve desaparecer.

## Usar `Marshal.SizeOf`

`Marshal.SizeOf` é seguro e não exige contexto unsafe. O método `SizeOf` retorna o tamanho não gerenciado de um objeto em bytes.

Tudo o que você precisa fazer é substituir `sizeof(Point)` por `Marshal.SizeOf(typeof(Point))`. Assim:

```cs
IntPtr sizeOfPoint = (IntPtr)Marshal.SizeOf(typeof(Point));
```

`Marshal.SizeOf` faz parte do namespace `System.Runtime.InteropServices`, então certifique-se de incluir a diretiva using correspondente no topo do seu arquivo:

```cs
using System.Runtime.InteropServices;
```

Vale notar que `Marshal.SizeOf` traz uma penalidade de desempenho muito pequena em comparação com o `sizeof` unsafe. É algo que você pode querer levar em conta ao escolher a solução que melhor atende às suas necessidades.
