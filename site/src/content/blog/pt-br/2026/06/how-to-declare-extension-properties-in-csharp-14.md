---
title: "Como declarar propriedades de extensão em C# 14"
description: "As propriedades de extensão chegam no C# 14 por meio do novo bloco extension. Declare propriedades de extensão somente leitura, com setter, estáticas e genéricas, por que propriedades automáticas são rejeitadas e como o compilador as converte em acessadores get_/set_."
pubDate: 2026-06-24
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "extension-members"
lang: "pt-br"
translationOf: "2026/06/how-to-declare-extension-properties-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-06-24
---

Resposta rápida: declare uma propriedade de extensão dentro de um bloco `extension` em uma classe estática. Nomeie o receptor para adicionar uma propriedade de instância (`extension(string s) { public int WordCount => ...; }`), omita o nome para adicionar uma estática (`extension(Point) { public static Point Origin => ...; }`). O corpo da propriedade é o getter; adicione um acessador `set` para uma propriedade gravável. A única regra que pega todo mundo: não existem campos de extensão, então uma propriedade automática como `public int Count { get; set; }` não vai compilar. Cada acessador precisa calcular ou encaminhar para armazenamento real.

Esse recurso chega no C# 14, que exige o SDK do .NET 10 ou posterior (funciona da mesma forma sob o SDK do .NET 11). Configure `<LangVersion>14</LangVersion>` ou `<LangVersion>latest</LangVersion>` no seu `.csproj`. As propriedades de extensão são uma parte do recurso mais amplo de membros de extensão; este artigo é o guia focado na metade das propriedades. Se você quer o panorama mais amplo que também cobre operadores e membros estáticos, leia a [introdução aos membros de extensão do C# 14](/pt-br/2026/02/csharp-14-extension-members/).

## Por que você nunca pôde escrever `string.WordCount` antes do C# 14

Os métodos de extensão existem desde o C# 3.0, mas eles só estendiam um tipo de membro: métodos. Se você quisesse adicionar um valor calculado a um tipo que não controla, tinha que escrevê-lo como uma chamada de método:

```csharp
// Before C# 14 - the only option was a method
public static class StringExtensions
{
    public static int WordCount(this string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
}

// Call site reads like a function, not a property
int n = "hello there world".WordCount();
```

Esse `()` no final é o sinal. `WordCount` é conceitualmente uma propriedade da string, mas a linguagem o forçava ao formato de método. Propriedades automáticas, propriedades calculadas e indexadores sobre tipos que você não controla estavam simplesmente fora de alcance. O C# 14 fecha essa lacuna com o bloco `extension`, um contêiner que pode conter propriedades, operadores e membros estáticos ao lado dos antigos métodos no estilo `this`.

## Declare uma propriedade de extensão em três passos

1. Crie uma classe estática de nível superior e não genérica para hospedar a extensão. É a mesma regra de contenção dos métodos de extensão clássicos: a classe não pode ser aninhada nem genérica.
2. Abra um bloco `extension` e declare o receptor. Escreva `extension(string s)` para nomear a instância que a propriedade estende, ou `extension(string)` sem nome para uma propriedade estática sobre o próprio tipo.
3. Declare a propriedade dentro do bloco com um getter de corpo de expressão (ou um corpo completo de `get`/`set`). Referencie o parâmetro receptor pelo nome que você deu a ele no passo 2.

Juntando tudo, o exemplo de `WordCount` se torna uma propriedade real:

```csharp
// .NET 11, C# 14 - an instance extension property
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(s);

        public int WordCount =>
            s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

Agora o local de chamada perde os parênteses e se lê exatamente como um membro nativo:

```csharp
string title = "hello there world";
Console.WriteLine(title.WordCount);  // 3
Console.WriteLine(title.IsBlank);    // False
```

O nome do receptor (`s` aqui) está no escopo de cada membro dentro do bloco, então propriedades relacionadas compartilham uma única declaração do que elas estendem. Esse é justamente o propósito do bloco: ele agrupa os membros pelo tipo que aumentam em vez de repetir `this string` em cada assinatura.

## Propriedades de extensão com setter precisam de um lugar para colocar o valor

As propriedades de extensão não são somente leitura por padrão. Você pode adicionar um acessador `set`, mas como o runtime não dá a uma extensão nenhum lugar para armazenar dados, o setter precisa encaminhar o valor para armazenamento que já existe no receptor. Um caso claro é expor uma visão alternativa sobre um campo que o tipo já possui:

```csharp
// .NET 11, C# 14 - a get/set extension property over existing state
public class Sensor
{
    public double Celsius { get; set; }
}

public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        public double Fahrenheit
        {
            get => sensor.Celsius * 9 / 5 + 32;
            set => sensor.Celsius = (value - 32) * 5 / 9;
        }
    }
}
```

O setter lê `value` como qualquer setter de propriedade e grava por meio do campo `Celsius` real:

```csharp
var s = new Sensor { Celsius = 20 };
Console.WriteLine(s.Fahrenheit);  // 68
s.Fahrenheit = 212;
Console.WriteLine(s.Celsius);     // 100
```

O que você não pode fazer é pedir ao compilador que invente armazenamento para você. Este é o erro de compilação mais comum que as pessoas encontram:

```csharp
public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        // ERROR: an extension property cannot be an auto-property,
        // because there is no backing field to generate.
        public string Label { get; set; }
    }
}
```

Não há campos de extensão no C# 14, então não há campo de apoio para sintetizar. Cada acessador precisa ter um corpo que calcule um valor ou o roteie por meio de membros que o receptor já possui. Se você realmente precisa anexar novo estado a instâncias de um tipo que não controla, uma propriedade de extensão é a ferramenta errada; recorra a um `ConditionalWeakTable<TKey, TValue>` com a instância como chave e exponha-o por meio do getter e do setter.

## Mutar um struct exige um receptor `ref`

O exemplo de `Sensor` funciona porque `Sensor` é uma classe, então o setter muta o objeto que todos compartilham. Para um tipo de valor, o receptor é copiado por padrão, e um setter mutaria essa cópia descartável. Declare o receptor `ref` para gravar de volta no original, exatamente como `this ref` funcionava para métodos de extensão que mutavam:

```csharp
// .NET 11, C# 14 - ref receiver so the setter mutates the caller's struct
public static class PointExtensions
{
    extension(ref System.Drawing.Point p)
    {
        public int ManhattanLength
        {
            get => Math.Abs(p.X) + Math.Abs(p.Y);
        }
    }
}
```

Um receptor `ref` também significa que a propriedade só pode ser usada sobre uma variável endereçável, não sobre um valor temporário como o resultado de uma chamada de método. Essa restrição é a mesma que os métodos de extensão `ref` sempre carregaram, e é o que mantém a mutação segura.

## Propriedades de extensão estáticas dispensam o nome do receptor

Omita o nome do parâmetro e o bloco estende o próprio tipo em vez de uma instância. É assim que você adiciona constantes nomeadas ou valores no estilo de fábrica que se leem como membros estáticos de um tipo que você não controla:

```csharp
// .NET 11, C# 14 - a static extension property on a type you don't own
using System.Drawing;

public static class PointExtensions
{
    extension(Point)
    {
        public static Point Origin => Point.Empty;
    }
}
```

O local de chamada parece um membro estático que sempre esteve ali:

```csharp
Point start = Point.Origin;
```

Membros estáticos e de instância podem viver em blocos separados dentro da mesma classe. Use um bloco com receptor nomeado para os membros de instância e um bloco de tipo puro para os estáticos; o compilador aceita ambos os estilos lado a lado em uma única classe estática.

## Propriedades de extensão genéricas: cada parâmetro de tipo precisa alcançar o receptor

Coloque os parâmetros de tipo na palavra-chave `extension` e eles fluem para cada membro dentro do bloco. Isso permite adicionar propriedades a tipos genéricos abertos como `IReadOnlyList<T>`:

```csharp
// .NET 11, C# 14 - generic extension properties
public static class ListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public bool IsEmpty => list.Count == 0;

        public T? LastOrDefaultValue =>
            list.Count > 0 ? list[^1] : default;
    }
}
```

Há uma restrição rígida que o compilador aplica: cada parâmetro de tipo declarado no bloco precisa ser usado pelo tipo receptor. `extension<T>(IReadOnlyList<T> list)` é válido porque `T` aparece em `IReadOnlyList<T>`. Um bloco como `extension<T>(string s)` que declara `T` mas nunca o usa no receptor é um erro de compilação, porque o compilador não tem de onde inferir `T` no local de chamada. As restrições também vão no bloco:

```csharp
public static class ComparableExtensions
{
    extension<T>(IReadOnlyList<T> list) where T : IComparable<T>
    {
        public T Max
        {
            get
            {
                var max = list[0];
                for (int i = 1; i < list.Count; i++)
                    if (list[i].CompareTo(max) > 0) max = list[i];
                return max;
            }
        }
    }
}
```

## Como o compilador converte uma propriedade de extensão, e como desambiguar

Uma propriedade de extensão é açúcar puramente em tempo de compilação. O compilador transforma o bloco em métodos acessadores estáticos comuns em um tipo aninhado oculto: um getter chamado `get_PropertyName` e, se presente, um setter chamado `set_PropertyName`, cada um recebendo o receptor como seu primeiro argumento. Quando você escreve `title.WordCount`, o compilador o reescreve como uma chamada a esse acessador `get_WordCount` gerado. A ordem dos parâmetros de tipo na forma convertida é primeiro os parâmetros do receptor, depois quaisquer parâmetros de método, o que só importa se você inspecionar os metadados gerados.

Duas consequências decorrem disso. Primeiro, a resolução usa as mesmas regras de escopo dos métodos de extensão: vence o candidato no espaço de nomes ou `using` mais próximo, e quando duas propriedades de extensão de mesmo nome estão igualmente no escopo você recebe um erro de ambiguidade em vez de uma escolha silenciosa. Você resolve isso restringindo as diretivas `using`, ou qualificando por meio da classe estática para que o compilador saiba a qual acessador você se refere. Segundo, como a propriedade existe apenas no local de chamada, ela nunca aparece na reflexão em tempo de execução sobre o tipo estendido: `typeof(string).GetProperty("WordCount")` retorna `null`. As propriedades de extensão são uma conveniência da linguagem, não uma modificação em tempo de execução do tipo, então qualquer coisa que reflita sobre membros reais (serializadores, data binding, ORMs) não as verá.

## A nulabilidade é sua para declarar

Como você escreve o parâmetro receptor por conta própria, você decide se a propriedade aceita um receptor nulo. Anote o receptor como anulável para escrever uma propriedade que seja segura de chamar sobre uma referência nula, algo que uma propriedade de instância comum nunca pode ser:

```csharp
// .NET 11, C# 14 - a null-tolerant extension property
public static class StringExtensions
{
    extension(string? s)
    {
        public bool HasText => !string.IsNullOrWhiteSpace(s);
    }
}

string? maybe = null;
Console.WriteLine(maybe.HasText);  // False, no NullReferenceException
```

Isso combina bem com o tratamento de nulos no local de chamada que chegou junto; veja [a atribuição condicional a nulo do C# 14](/pt-br/2026/02/csharp-14-null-conditional-assignment/) para as melhorias de `?.` e `?[]` no lado esquerdo de uma atribuição.

## Os casos extremos que vale a pena conhecer antes de publicar

Algumas regras e limites poupam você de um erro de compilação confuso:

- **Sem campos, sem propriedades automáticas, sem eventos, sem construtores.** Os blocos `extension` do C# 14 dão suporte a métodos, propriedades, indexadores e operadores. Campos são explicitamente excluídos, que é justamente por que as propriedades automáticas são rejeitadas.
- **O contêiner precisa ser uma classe estática não genérica e não aninhada.** Coloque seus parâmetros de tipo no bloco `extension`, não na classe.
- **Uma colisão de nome com um membro real perde.** Se o tipo estendido já tem uma propriedade `WordCount`, a real sempre vence e sua propriedade de extensão nunca é considerada. Extensões apenas preenchem lacunas; nunca sobrescrevem.
- **Indexadores seguem o mesmo formato.** Você pode declarar `public T this[int i] => ...` dentro de um bloco `extension` de instância, o que dá indexadores de extensão em tipos que não os têm.

As propriedades de extensão são a fatia mais ergonômica do trabalho de membros de extensão, e elas se compõem de forma limpa com o resto do C# 14. Se você está adicionando membros calculados a um tipo que controla versus um que não, pondere-as contra as outras ferramentas de modelagem da versão: tanto [o truque de membros de extensão para retornar múltiplos valores](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) quanto [os operadores de atribuição composta definidos pelo usuário](/pt-br/2026/04/csharp-14-user-defined-compound-assignment-operators/) se apoiam na mesma família de sintaxe.

## Fontes

- [Explore extension members in C# 14 (tutorial do Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members)
- [C# 14: Exploring extension members (.NET Blog)](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/)
- [Andrew Lock: C# 14 extension members, AKA extension everything](https://andrewlock.net/exploring-dotnet-10-preview-features-3-csharp-14-extensions-members/)
