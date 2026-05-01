---
title: "C# 14: a palavra-chave field e propriedades respaldadas por field"
description: "C# 14 introduz a palavra-chave contextual field nos acessadores de propriedades, permitindo adicionar lógica personalizada às auto-properties sem declarar um campo de apoio separado."
pubDate: 2025-04-05
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/c-14-the-field-keyword-and-field-backed-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 14 introduz uma nova palavra-chave contextual, **`field`**, que pode ser usada dentro dos acessadores de uma propriedade (os blocos `get`, `set` ou `init`) para se referir ao armazenamento de apoio da propriedade. Em termos simples, `field` é um marcador que representa a variável oculta onde o valor de uma propriedade é guardado. Esta palavra-chave permite adicionar lógica personalizada a propriedades implementadas automaticamente sem declarar manualmente um campo privado separado. Ela apareceu primeiro em prévia no C# 13 (exigindo .NET 9 com a versão do idioma definida como preview) e é oficialmente parte da linguagem no C# 14.

**Por que isso é útil?** Antes do C# 14, se você quisesse adicionar lógica (como validação ou notificação de mudança) a uma propriedade, precisava transformá-la em uma propriedade completa com um campo privado de apoio. Isso significava mais código repetitivo e o risco de outros membros da classe usarem esse campo diretamente, contornando a lógica da propriedade. A nova palavra-chave `field` resolve esses problemas deixando o compilador gerar e gerenciar o campo de apoio para você, enquanto você simplesmente usa `field` no código da propriedade. O resultado são declarações de propriedade mais limpas e fáceis de manter, evitando que o armazenamento de apoio "vaze" para o restante do escopo da sua classe.

## Benefícios e cenários de uso de `field`

A palavra-chave `field` foi introduzida para tornar as declarações de propriedade mais concisas e menos propensas a erros. Veja os principais benefícios e cenários em que ela é útil:

-   **Eliminar campos de apoio manuais:** Você não precisa mais escrever um campo privado para cada propriedade só para adicionar comportamento personalizado. O compilador fornece automaticamente um campo de apoio oculto, acessado pela palavra-chave `field`. Isso reduz código repetitivo e mantém sua definição de classe mais limpa.
-   **Manter o estado da propriedade encapsulado:** O campo de apoio criado pelo compilador só é acessível pelos acessadores da propriedade (via `field`), não em outros lugares da sua classe. Isso impede o uso acidental do campo a partir de outros métodos ou propriedades, garantindo que invariantes ou validações no acessador da propriedade não possam ser ignoradas.
-   **Lógica de propriedade mais fácil (validação, inicialização preguiçosa etc.):** Oferece um caminho suave para adicionar lógica a auto-properties. Cenários comuns incluem:
    
    -   _Validação ou verificação de intervalo:_ por exemplo, garantir que um valor seja não negativo ou esteja em um intervalo antes de aceitá-lo.
    -   _Notificação de mudança:_ por exemplo, disparar eventos `INotifyPropertyChanged` após definir um novo valor.
    -   _Inicialização preguiçosa ou padrão:_ por exemplo, em um getter, inicializar `field` no primeiro acesso ou retornar um valor padrão se não estiver definido.


    Em versões anteriores do C#, esses cenários exigiam escrever uma propriedade completa com um campo separado. Com `field`, você pode implementá-los diretamente na lógica de `get`/`set` da propriedade, sem campos extras.
-   **Misturar acessadores automáticos e personalizados:** O C# 14 permite que um acessador seja auto-implementado e o outro tenha um corpo usando `field`. Por exemplo, você pode fornecer um `set` personalizado e deixar o `get` como automático, ou vice-versa. O compilador gera o que for necessário para o acessador que você não escrever. Isso não era possível antes: anteriormente, adicionar um corpo a um acessador exigia fornecer uma implementação explícita para ambos.

No geral, `field` melhora a legibilidade e a manutenibilidade ao remover código redundante e focar apenas no comportamento personalizado de que você precisa. É conceitualmente similar a como a palavra-chave `value` funciona em um setter (representando o valor que está sendo atribuído); aqui, `field` representa o armazenamento subjacente da propriedade.

## Antes vs. depois: campo de apoio manual vs. palavra-chave `field`

Para ver a diferença, vamos comparar como você declararia uma propriedade que impõe alguma regra **antes** do C# 14 e **depois**, usando a nova palavra-chave `field`.

**Cenário:** Suponha que queremos uma propriedade `Hours` que nunca possa ser definida como um número negativo. Em versões mais antigas do C#, faríamos o seguinte:

**Antes do C# 14, usando um campo de apoio manual:**

```cs
public class TimePeriodBefore
{
    private double _hours;  // backing field

    public double Hours
    {
        get { return _hours; }
        set 
        {
            if (value < 0)
                throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
            _hours = value;
        }
    }
}
```

Neste código pré-C#14, tivemos que introduzir um campo privado `_hours` para guardar o valor. O getter da propriedade retorna esse campo, e o setter realiza uma verificação antes de atribuir a `_hours`. Funciona, mas é verboso: há código extra para declarar e gerenciar `_hours`, e `_hours` é acessível em qualquer parte da classe (ou seja, outros métodos **podem** escrever em `_hours` e contornar a lógica de validação se não houver cuidado).

**A partir do C# 14, usando a palavra-chave `field`:**

```cs
public class TimePeriod
{
    public double Hours
    {
        get;  // auto-implemented getter (compiler provides it)
        set => field = (value >= 0) 
            ? value 
            : throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
    }
}
```

Aqui, a propriedade `Hours` é declarada sem campo de apoio explícito. Usamos `get;` sem corpo, indicando um getter automático, e fornecemos um corpo para `set` que usa `field`. A expressão `field = ...` dentro do setter diz ao compilador para atribuir ao campo de apoio da propriedade. O compilador gerará automaticamente um campo privado nos bastidores e implementará o acessador `get` para retornar esse campo. No setter acima, se o `value` for negativo, lançamos uma exceção; caso contrário, atribuímos ao `field` (que o armazena). **Não** precisamos declarar `_hours` por nossa conta, e nem é preciso escrever o corpo do getter: o compilador faz isso por nós. O resultado é uma definição de propriedade mais concisa com o mesmo comportamento.

Repare como a versão em C# 14 é bem mais limpa:

-   removemos o campo explícito `_hours`; o compilador cuida dele.
-   o acessador `get` continua sendo um simples auto-implementado (`get;`), que o compilador transformará em "retorne o campo de apoio".
-   o acessador `set` contém apenas a lógica que nos importa (a verificação de não negatividade); a atribuição de armazenamento real é tratada por `field = value`.

Você também pode usar `field` em um acessador `get`, se necessário. Por exemplo, para implementar inicialização preguiçosa, você poderia fazer algo como:

```cs
public string Name 
{
    get => field ??= "Unknown";
    set => field = value;
}
```

Nesse caso, na primeira vez que `Name` é acessado, se ele não estiver definido, o getter atribui um valor padrão `"Unknown"` ao campo de apoio e o retorna. As próximas leituras ou qualquer atribuição usarão o mesmo `field`. Sem esse recurso, você precisaria de um campo privado e mais código no getter para conseguir o mesmo comportamento.

## Como o compilador lida com a palavra-chave `field`

Quando você usa `field` dentro de um acessador de propriedade, o compilador gera silenciosamente um campo de apoio oculto para essa propriedade (muito parecido com o que ele faz para uma propriedade auto-implementada). Você nunca verá esse campo no seu código-fonte, mas o compilador dá a ele um nome interno (por exemplo, algo como `<Hours>k__BackingField`) e o usa para armazenar o valor da propriedade. Veja o que acontece nos bastidores:

-   **Geração do campo de apoio:** Se ao menos um acessador de uma propriedade usa `field` (ou se você tem uma propriedade auto-implementada sem corpos), o compilador cria um campo privado para guardar o valor. Você não precisa declarar esse campo. No exemplo `TimePeriod.Hours` acima, o compilador geraria um campo para armazenar o valor das horas, e os acessadores `get` e `set` operariam sobre esse campo (de forma implícita ou via a palavra-chave `field`).
-   **Implementação de getter/setter:**
    -   Para um acessador auto-implementado (como `get;` ou `set;` sem corpo), o compilador gera automaticamente a lógica simples para retornar ou definir o campo de apoio.
    -   Para um acessador no qual você forneceu um corpo usando `field`, o compilador insere sua lógica e trata `field` como uma referência ao campo de apoio nesse código gerado. Por exemplo, `set => field = value;` torna-se algo como `set { backingField = value; }` na saída compilada, preservando ao redor qualquer lógica adicional que você tenha escrito.
    -   Você pode misturar acessadores automáticos e personalizados. Por exemplo, se escrever um corpo para `set` (usando `field`) e deixar `get` como `get;`, o compilador gera o `get` para você. Inversamente, você poderia escrever um `get` personalizado (por exemplo, `get => ComputeSomething(field)`) e ter um `set;` auto-implementado, caso em que o compilador gera o setter para simplesmente atribuir ao campo de apoio.
-   **O comportamento é equivalente a campos manuais:** O resultado compilado usando `field` é essencialmente o mesmo de quando você escrevia manualmente um campo privado e o usava na propriedade. Não há penalidade de desempenho nem mágica além de poupar você do código repetitivo. É puramente um recurso de conveniência em tempo de compilação. Por exemplo, as duas implementações de `Hours` acima (com e sem `field`) compilam para um IL muito semelhante: ambas têm um campo privado para armazenar o valor e acessadores de propriedade que manipulam esse campo. A diferença é que o compilador do C# 14 escreveu uma delas para você.
-   **Inicializadores de propriedade:** Se você usar um inicializador em uma propriedade que utiliza `field` (por exemplo, `public int X { get; set => field = value; } = 42;`), o inicializador inicializará diretamente o campo de apoio _antes_ de o construtor executar, exatamente como acontece com auto-properties tradicionais. Ele **não** chamará a lógica do setter durante a construção do objeto. (Isso é importante de notar se o seu setter tem efeitos colaterais; eles não ocorrerão para o valor inicial definido por meio de um inicializador. Se você precisa que a lógica do setter rode na inicialização, atribua a propriedade no construtor em vez de usar um inicializador.)
-   **Atributos no campo de apoio:** Se você precisar aplicar atributos ao campo de apoio gerado, o C# permite _atributos direcionados ao campo_ usando a sintaxe `[field: ...]`. Isso já era possível com auto-properties e funciona aqui também. Por exemplo, você pode escrever `[field: NonSerialized] public int Id { get; set => field = value; }` para marcar o campo gerado automaticamente como não serializável. (Isso só funciona se realmente existir um campo de apoio para a propriedade, ou seja, você tem ao menos um acessador usando `field` ou uma auto-property.)

TLDR; o compilador gera um campo de apoio privado e conecta seus acessadores de propriedade para usá-lo. Você obtém a funcionalidade de uma propriedade completa com uma fração do código. A propriedade continua, do ponto de vista da implementação, sendo uma auto-property real: você simplesmente ganhou um gancho para injetar lógica nela.

## Regras de sintaxe e uso de `field`

Ao usar a palavra-chave `field`, lembre-se das seguintes regras e limitações:

-   **Apenas dentro de acessadores de propriedade/indexador:** `field` só pode ser usada **dentro** do corpo de um acessador de propriedade ou indexador (o bloco de código ou expressão para `get`, `set` ou `init`). É uma palavra-chave _contextual_, ou seja, fora do acessador de uma propriedade `field` não tem significado especial (seria considerada apenas um identificador). Se você tentar usar `field` em um método comum ou fora de uma propriedade, terá um erro de compilação: o compilador não saberá a qual campo de apoio você está se referindo.
-   **Palavra-chave contextual (não totalmente reservada):** Como `field` não é uma palavra-chave reservada globalmente, tecnicamente você poderia ter variáveis ou membros chamados `field` em outras partes do código. Porém, dentro do acessador de uma propriedade, `field` é tratada como palavra-chave e se referirá ao campo de apoio, e não a qualquer variável chamada `field`. Veja "conflitos de nomes" abaixo para lidar com esse cenário.
-   **Uso em acessadores get/set/init:** Você pode usar `field` dentro de um acessador `get`, `set` ou `init`. Em um setter ou acessador init, geralmente atribuímos a `field` (por exemplo, `field = value;`). Em um getter, você pode retornar ou modificar `field` (por exemplo, `return field;` ou `field ??= defaultValue;`). Você pode usar `field` em um acessador apenas, ou em ambos, conforme necessário:
    -   Se usar `field` em **apenas um acessador**, pode deixar o outro como auto-implementado (`get;` ou `set;` sem corpo) e o compilador ainda criará o campo de apoio e fará a ligação de tudo.
    -   Se usar `field` em **ambos** os acessadores, também tudo bem: você está efetivamente escrevendo a lógica de get e set (mas ainda sem declarar o campo manualmente). Isso pode ser feito se tanto a leitura quanto a escrita exigirem tratamento especial. Por exemplo, um setter pode aplicar uma condição e um getter pode fazer alguma transformação ou carga preguiçosa no primeiro acesso, ambos usando o mesmo `field`.
-   **Não dá para referenciar `field` fora do acessador:** Você não pode armazenar a referência `field` para usar em outro lugar, nem acessar diretamente o campo de apoio gerado pelo compilador fora da propriedade. Para todos os efeitos, esse campo de apoio é anônimo no seu código-fonte (embora o compilador dê a ele um nome interno). Se você precisa interagir com o valor, faça isso pela propriedade ou dentro dos seus acessadores usando `field`.
-   **Não vale para eventos:** A palavra-chave `field` é projetada para propriedades (e indexadores). Ela **não** está disponível para os acessadores add/remove de eventos. (Eventos em C# também podem ter campos de apoio para o delegate, mas a equipe da linguagem decidiu não estender `field` aos acessadores de eventos.)
-   **Não misturar com declarações de campo explícitas:** Se você optar por declarar seu próprio campo de apoio para uma propriedade, não deve usar `field` nos acessadores dessa propriedade. Nesse caso, basta referenciar seu campo explícito pelo nome, como tradicionalmente. A palavra-chave `field` substitui a necessidade de um campo explícito nesses cenários. Ou seja, uma propriedade tem um campo implícito gerenciado pelo compilador (quando você usa `field` ou acessadores automáticos), ou você o gerencia, mas não os dois.

Resumindo: use `field` dentro dos acessadores da sua propriedade para se referir ao armazenamento oculto dessa propriedade, e em nenhum outro lugar. Siga as regras normais de escopo do C# para tudo que estiver fora de propriedades.

## Lidando com conflitos de nomes (quando você tem sua própria variável `field`)

Como `field` não era uma palavra reservada em versões mais antigas do C#, é possível (embora incomum) que algum código tenha usado "field" como nome de variável ou de campo. Com a introdução da palavra-chave contextual `field` em acessadores, esse código pode ficar ambíguo ou quebrar. O design da linguagem leva isso em conta:

-   **`field` em um acessador sombreia identificadores:** Dentro dos acessadores de propriedade, a nova palavra-chave `field` **sombreia** qualquer identificador chamado `field` que possa existir naquele escopo. Por exemplo, se você tinha uma variável local ou parâmetro chamado `field` dentro de um setter (talvez de código antigo), o compilador agora interpretará `field` como a palavra-chave do campo de apoio, e não como sua variável. No C# 14, isso resulta em erro de compilação se você tentar declarar ou usar uma variável chamada `field` em um acessador, porque agora `field` deve ser a palavra-chave.
-   **Use `@field` ou `this.field` para se referir ao campo real:** Se você _realmente_ tem um campo de membro literalmente chamado "field" na sua classe (não recomendado, mas possível), ou uma variável em escopo chamada "field", ainda é possível referenciá-la escapando o nome. O C# permite prefixar um identificador com `@` para usá-lo mesmo que seja uma palavra-chave. Por exemplo, se sua classe tem `private int field;` e você precisa referenciá-la em um acessador, pode escrever `@field` para acessá-la como identificador. Da mesma forma, você poderia usar `this.field` para referir-se explicitamente ao campo de membro. Usar `@` ou um qualificador contorna a interpretação da palavra-chave contextual e permite acessar a variável real.

```cs
private int field = 10; // a field unfortunately named "field" 
public int Example
{
    get { return @field; } // use @field to return the actual field 
    set { @field = value; } // or this.field = value; either works 
}
```

-   No entanto, se for possível, é melhor renomear o membro para evitar confusão. No C# moderno, `field` por si só em um acessador deve ser reservado para o campo de apoio do compilador. Inclusive, se você atualizar uma base de código antiga para o C# 14, o compilador avisará se encontrar usos de `field` que antes se referiam a outra coisa, indicando que você deve desambiguá-los.
-   **Evitar o nome por completo:** Como prática geral, evite usar `field` como nome de identificador no seu código. Agora que ela é uma palavra-chave (em contexto), tratá-la como um nome comum confundirá leitores e pode levar a erros. Se você usava `field` como nome de variável, considere renomeá-la ao migrar para o C# 14. Convenções comuns de nomenclatura (como prefixar campos privados com `_` ou similar) evitariam naturalmente esse conflito na maioria dos casos.

## Referências

1.  [`field` – Field backed property declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field#:~:text=The%20,contextual%20keyword)​
2.  ​[C# Feature Proposal Notes – _"`field` keyword in properties"_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/field-keyword#:~:text=Auto%20properties%20only%20allow%20for,accessors%20from%20within%20the%20class)
3.  ​[What's new in C# 14](/2024/12/csharp-14/)
