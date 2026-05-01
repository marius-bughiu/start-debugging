---
title: "C# 12 alias para qualquer tipo"
description: "A diretiva using alias foi relaxada no C# 12 para permitir criar alias para qualquer tipo, não apenas tipos nomeados. Isso significa que agora você pode criar alias para tuples, pointers, tipos de array, tipos genéricos, etc. Assim, em vez de usar a forma estrutural completa de um tuple, dá para criar um alias curto e descritivo..."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/08/c-12-alias-any-type"
translatedBy: "claude"
translationDate: 2026-05-01
---
A diretiva using alias foi relaxada no C# 12 para permitir criar alias para qualquer tipo, não apenas tipos nomeados. Isso significa que agora você pode criar alias para tuples, pointers, tipos de array, tipos genéricos, etc. Em vez de usar a forma estrutural completa de um tuple, dá para criar um alias curto e descritivo que pode ser usado em qualquer lugar.

Vamos a um exemplo rápido com alias de tuple. Primeiro, declare o alias:

```cs
using Point = (int x, int y);
```

Depois é só usar como qualquer outro tipo. Você pode usar como tipo de retorno, na lista de parâmetros de um método, ou até para criar novas instâncias do tipo. Praticamente sem limites.

Um exemplo de uso do alias de tuple declarado acima:

```cs
Point Copy(Point source)
{
    return new Point(source.x, source.y);
}
```

Como antes, os alias de tipo são válidos apenas no arquivo em que foram definidos.

### Restrições

Pelo menos por enquanto, você precisa informar o nome totalmente qualificado dos tipos para qualquer coisa que não seja um tipo primitivo. Por exemplo:

```cs
using CarDictionary = System.Collections.Generic.Dictionary<string, ConsoleApp8.Car<System.Guid>>;
```

No máximo, dá para se livrar do namespace da sua app definindo o alias dentro do próprio namespace.

```cs
namespace ConsoleApp8
{
    using CarDictionary = System.Collections.Generic.Dictionary<string, Car<System.Guid>>;
}
```

### Error CS8652

> The feature 'using type alias' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Esse erro significa que o seu projeto ainda não usa C# 12, então você não consegue usar os novos recursos da linguagem. Se quiser migrar para o C# 12 e não sabe como, dê uma olhada em [nosso guia para migrar o projeto para C# 12](/2023/06/how-to-switch-to-c-12/).
