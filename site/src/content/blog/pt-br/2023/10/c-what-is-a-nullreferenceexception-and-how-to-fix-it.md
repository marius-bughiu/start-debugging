---
title: "C# o que é uma NullReferenceException e como corrigir?"
description: "Entenda o que causa uma NullReferenceException em C#, como debugar e como prevenir usando checagens de null, o operador null-conditional e tipos de referência anuláveis."
pubDate: 2023-10-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/10/c-what-is-a-nullreferenceexception-and-how-to-fix-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
`NullReferenceException` é um erro de runtime bem comum que acontece quando o seu código tenta acessar ou manipular um objeto ou um membro de um objeto, mas a referência atual desse objeto está em `null` (ou seja, não aponta para nenhum objeto válido em memória). Em outras palavras, você está tentando fazer alguma operação em algo que não existe.

Veja um exemplo bem simples:

```cs
string myString = null;
int length = myString.Length;
```

No exemplo, temos uma variável string `myString` recebendo `null`. Quando tentamos acessar a propriedade `Length`, uma `NullReferenceException` é lançada, porque você não consegue pegar o tamanho de uma string que não existe.

## Como debugar?

Seu foco principal deve ser identificar a origem da referência null. O depurador permite localizar com precisão onde o problema está.

Primeiro, olhe com atenção os detalhes da exceção informados pelo depurador, que apontam a linha exata do código onde ocorreu a exceção. Essa linha é crucial para descobrir qual variável ou objeto é responsável pela referência null.

Em seguida, inspecione variáveis e objetos passando o mouse por cima ou usando as janelas `Locals` e `Watch` do seu editor. Essas ferramentas permitem examinar o estado da aplicação no momento da exceção. Preste atenção especial às variáveis usadas ou acessadas na linha que disparou a exceção. Se alguma delas estiver null quando não deveria, você provavelmente encontrou a origem do problema.

Além disso, olhe a pilha de chamadas na janela Call Stack para voltar pelas chamadas de método que levaram à exceção. Isso ajuda a entender o contexto em que a referência null aconteceu e a identificar a causa raiz. Depois de identificar a variável ou objeto responsável, é só corrigir o problema verificando valores null e inserindo checagens adequadas para evitar exceções futuras.

## Como prevenir?

Para prevenir `NullReferenceException`s, é fundamental checar valores `null` antes de tentar acessar propriedades ou métodos de objetos. Você pode usar comandos condicionais como `if` para verificar `null` antes de acessar membros de um objeto. Por exemplo:

```cs
string myString = null; 

if (myString != null) 
{ 
    int length = myString.Length; // This will only execute if 'myString' is not null. 
}
```

Ou pode usar o operador null-conditional (introduzido no C# 6.0) para acessar membros de objetos que podem ser null com segurança:

```cs
string myString = null; 
int? length = myString?.Length; // 'length' will be null if 'myString' is null.
```

### Tipos de referência anuláveis

Outra forma de evitar `NullReferenceException`s é habilitar os tipos de referência anuláveis, recurso introduzido no C# 8.0. Ele ajuda os desenvolvedores a escrever código mais seguro e confiável, oferecendo uma forma de expressar se um tipo de referência (por exemplo, classes e interfaces) pode ou não ser null. Esse recurso ajuda a detectar possíveis exceções de referência null em tempo de compilação e melhora a legibilidade e a manutenibilidade do código.

Quando você habilita tipos de referência anuláveis no seu código, o compilador passa a gerar avisos para possíveis problemas de referência null. É preciso adicionar anotações para deixar suas intenções claras, o que ajuda a reduzir ou eliminar esses avisos.

Tipos de referência anuláveis usam anotações para indicar se um tipo de referência pode ser `null`:

-   `T?`: indica que um tipo de referência `T` pode ser `null`.
-   `T`: indica que um tipo de referência `T` é não-anulável.
