---
title: "C# 14: suporte do nameof para tipos genéricos não vinculados"
description: "C# 14 aprimora a expressão nameof para suportar tipos genéricos não vinculados como List<> e Dictionary<,>, eliminando a necessidade de argumentos de tipo de preenchimento."
pubDate: 2025-04-07
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/c-14-nameof-support-for-unbound-generic-types"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 14 introduz várias melhorias pequenas, mas úteis, na linguagem. Uma dessas novas características é um aprimoramento na expressão `nameof`: agora ela suporta _tipos genéricos não vinculados_. Em termos simples, você não precisa mais inserir um argumento de tipo de preenchimento só para obter o nome de um tipo genérico. Esta atualização remove um pequeno incômodo que os desenvolvedores C# enfrentaram por anos e torna o código que usa `nameof` mais limpo e fácil de manter.

## O que são tipos genéricos não vinculados

Em C#, um _tipo genérico_ é uma classe ou struct que tem parâmetros de tipo (por exemplo, `List<T>` ou `Dictionary<TKey, TValue>`). Um **tipo genérico não vinculado** é a própria definição do tipo genérico, sem nenhum argumento de tipo específico fornecido. Você pode reconhecer um genérico não vinculado pelos colchetes angulares vazios (como `List<>`) ou por vírgulas dentro dos colchetes angulares indicando o número de parâmetros de tipo (como `Dictionary<,>` para dois parâmetros de tipo). Ele representa o tipo genérico _de forma geral_, sem dizer o que são `T` ou `TKey`/`TValue`. Não podemos instanciar um tipo genérico não vinculado diretamente, porque ele não está totalmente especificado, mas podemos usá-lo em certos contextos (como reflection via `typeof`). Por exemplo, `typeof(List<>)` retorna um objeto `System.Type` para o tipo genérico aberto `List`.

Antes do C# 14, a linguagem **não** permitia que tipos genéricos não vinculados fossem usados na maioria das expressões. Eles apareciam principalmente em cenários de reflection ou atributos. Se você quisesse referenciar um tipo genérico pelo nome no código, normalmente precisava fornecer argumentos de tipo concretos, tornando-o um tipo genérico _fechado_. Por exemplo, `List<int>` ou `Dictionary<string, int>` são _tipos genéricos fechados_ porque todos os seus parâmetros de tipo estão especificados. Até agora, os desenvolvedores C# muitas vezes escolhiam um tipo arbitrário (como `object` ou `int`) só para satisfazer a sintaxe quando tudo o que realmente queriam era o nome do tipo genérico.

## Como `nameof` funcionava antes do C# 14

A expressão `nameof` é um recurso de tempo de compilação que produz o nome de uma variável, tipo ou membro como uma string. É comumente usada para evitar fixar identificadores em strings (por exemplo, para validação de argumentos ou notificações de mudança de propriedade). Antes do C# 14, `nameof` tinha uma limitação ao trabalhar com genéricos: você **não** podia usar um tipo genérico não vinculado como argumento. O argumento para `nameof` precisava ser uma expressão válida ou identificador de tipo no código, o que significava que tipos genéricos precisavam de argumentos de tipo concretos. Na prática, isso significava que para obter o nome de um tipo genérico, era preciso fornecer um parâmetro de tipo fictício.

Por exemplo, suponha que você queira a string `"List"` (o nome da classe genérica `List<T>`). No C# 13 ou anterior, você teria que escrever algo como:

```cs
string typeName = nameof(List<int>);  // evaluates to "List"
```

Aqui usamos `List<int>` com um argumento de tipo arbitrário (`int`), embora a escolha do tipo seja irrelevante para o resultado. Se você tentasse usar uma forma não vinculada como `List<>` sem um argumento de tipo, o código não compilaria. O compilador reclamaria com um erro sobre "nome genérico não vinculado" ou similar, pois isso não era permitido em um contexto que esperava uma expressão. Em outras palavras, você _tinha_ que especificar um parâmetro de tipo para tornar a expressão válida para `nameof`, mesmo que `nameof` no fim ignore o argumento de tipo e se importe apenas com o nome `"List"`.

Esse requisito era simplesmente uma peculiaridade das regras da linguagem. Podia levar a código estranho ou frágil. Por exemplo, os desenvolvedores frequentemente usavam um placeholder como `object` ou `int` para o parâmetro de tipo só para usar `nameof`. Se mais tarde o tipo genérico recebesse uma nova restrição (por exemplo, `T` precisaria ser um tipo de referência ou herdar de uma certa classe), o uso de `nameof` poderia quebrar porque o tipo fictício deixaria de satisfazer as restrições. Em alguns casos avançados, encontrar um tipo adequado para inserir não era trivial (por exemplo, se `T` estivesse restrito a uma classe interna ou a uma interface que nenhum tipo existente implementava, você teria que criar uma classe fictícia só para satisfazer o parâmetro genérico e poder usar `nameof`). Tudo isso era um trabalho extra para algo que na verdade não afeta o resultado de `nameof`.

## `nameof` com genéricos não vinculados em C# 14

C# 14 corrige esse problema permitindo que tipos genéricos não vinculados sejam usados diretamente em expressões `nameof`. Agora, o argumento de `nameof` pode ser uma definição de tipo genérico sem especificar seus parâmetros de tipo. O resultado é exatamente o que você esperaria: `nameof` retorna o nome do tipo genérico. Isso significa que você finalmente pode escrever `nameof(List<>)` e obter a string `"List"` sem precisar de nenhum argumento de tipo fictício.

Para ilustrar a mudança, vamos comparar como obteríamos o nome de um tipo genérico antes e depois do C# 14:

**Antes do C# 14:**

```cs
// Using a closed generic type (with a type argument) to get the name:
Console.WriteLine(nameof(List<int>));    // Output: "List"

// The following was not allowed in C# 13 and earlier – it would cause a compile error:
// Console.WriteLine(nameof(List<>));    // Error: Unbound generic type not allowed
```

**No C# 14 e versões posteriores:**

```cs
// We can use an unbound generic type directly:
Console.WriteLine(nameof(List<>));       // Output: "List"
Console.WriteLine(nameof(Dictionary<,>)); // Output: "Dictionary"
```

Como mostrado acima, `nameof(List<>)` agora avalia para `"List"`, e similarmente `nameof(Dictionary<,>)` retorna `"Dictionary"`. Não precisamos mais fornecer um argumento de tipo falso só para usar `nameof` com um tipo genérico.

Essa melhoria não se limita a obter apenas o nome do próprio tipo. Você também pode usá-la para obter os nomes dos membros de um tipo genérico não vinculado, assim como faria em um tipo normal. Por exemplo, `nameof(List<>.Count)` agora é uma expressão válida no C# 14 e produzirá a string `"Count"`. Em versões anteriores, você teria que escrever `nameof(List<int>.Count)` ou outro tipo concreto no lugar de `<int>` para obter o mesmo resultado. C# 14 permite que você omita os argumentos de tipo nesses contextos também. Em geral, em qualquer lugar onde você usaria `nameof(SomeGenericType<...>.MemberName)`, agora pode deixar o tipo genérico não vinculado se não tiver um tipo específico para usar ou não quiser se comprometer com um.

Vale notar que esse recurso é puramente sobre conveniência e clareza do código. A saída da expressão `nameof` não mudou: ainda é apenas o nome do identificador. O que mudou é que as regras da linguagem agora permitem um conjunto mais amplo de entradas para `nameof`. Isso alinha `nameof` com `typeof`, que já permitia tipos genéricos abertos. Na essência, a linguagem C# está reconhecendo que especificar um parâmetro de tipo nesses casos era um requisito desnecessário desde o início.

## Por que isso é útil

Permitir tipos genéricos não vinculados em `nameof` pode parecer um ajuste pequeno, mas traz alguns benefícios práticos:

-   **Código mais limpo e claro:** Você não precisa mais inserir argumentos de tipo irrelevantes só para satisfazer o compilador. `nameof(List<>)` expressa claramente "quero o nome do tipo genérico `List`", enquanto `nameof(List<int>)` pode fazer o leitor se perguntar por um momento "por que `int`?". Remover o ruído torna a intenção do código mais evidente.
-   **Sem tipos fictícios ou contornos:** No código pré-C# 14, os desenvolvedores frequentemente usavam tipos placeholder como `object` ou criavam implementações fictícias para usar `nameof` com genéricos. Isso não é mais necessário. Seu código pode referenciar diretamente o nome do tipo genérico sem nenhum contorno, reduzindo bagunça e dependências estranhas.
-   **Manutenibilidade aprimorada:** Usar genéricos não vinculados em `nameof` torna seu código menos frágil diante de mudanças. Se o tipo genérico ganhar novas restrições de parâmetro de tipo ou outras modificações, você não terá que revisitar cada uso de `nameof` para garantir que o argumento de tipo escolhido ainda se encaixe. Por exemplo, se você tinha `nameof(MyGeneric<object>)` e mais tarde `MyGeneric<T>` adiciona uma restrição `where T : struct`, esse código não compilaria mais. Com `nameof(MyGeneric<>)`, ele continuará funcionando independentemente de tais mudanças, já que não depende de nenhum argumento de tipo específico.
-   **Consistência com outras características da linguagem:** Essa mudança torna `nameof` mais consistente com como outros recursos de metaprogramação como `typeof` funcionam. Como você já podia fazer `typeof(GenericType<>)` para refletir um tipo genérico aberto, é intuitivo que também possa fazer `nameof(GenericType<>)` para obter seu nome. A linguagem agora parece mais consistente e lógica.
-   **Conveniência menor em cenários de reflection ou geração de código:** Se você escreve bibliotecas ou frameworks que lidam com tipos e nomes (por exemplo, gerando documentação, mensagens de erro ou fazendo binding de modelos onde você registra nomes de tipo), agora pode recuperar nomes de tipos genéricos de forma mais direta. É uma conveniência pequena, mas pode simplificar código que constrói strings de nomes de tipo ou usa `nameof` para logging e exceções envolvendo classes genéricas.

## O que muda para o seu código

O suporte a tipos genéricos não vinculados na expressão `nameof` é uma melhoria bem-vinda no C# 14 que torna a linguagem um pouco mais amigável ao desenvolvedor. Ao permitir construções como `nameof(List<>)`, C# elimina um incômodo antigo e deixa os desenvolvedores expressarem sua intenção sem código desnecessário. Essa mudança beneficia todos os usuários de C#: iniciantes podem evitar confusão ao usar `nameof` com genéricos, e desenvolvedores experientes obtêm código mais enxuto e resistente a mudanças futuras. É um ótimo exemplo da equipe do C# resolvendo um "papercut" da linguagem e melhorando a consistência. À medida que você adotar C# 14, mantenha esse recurso em mente sempre que precisar do nome de um tipo genérico, e aproveite escrever código mais limpo e conciso.

## Referências

1.  [What's new in C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#:~:text=Beginning%20with%20C,name)
2.  [Generics and attributes – C# | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/advanced-topics/reflection-and-attributes/generics-and-attributes#:~:text=constructed%20generic%20types%2C%20not%20on,Dictionary)
3.  [The nameof expression – evaluate the text name of a symbol – C# reference | Microsoft Learn](https://msdn.microsoft.com/en-us/library/dn986596.aspx#:~:text=Console.WriteLine%28nameof%28List,%2F%2F%20output%3A%20List)
4.  [Unbound generic types in `nameof` – C# feature specifications (preview) | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/unbound-generic-types-in-nameof#:~:text=Motivation)
5.  [What's new in C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
