---
title: "C# parâmetros ref readonly"
description: "O modificador ref readonly no C# oferece uma forma mais transparente de passar referências somente leitura. Veja como ele melhora o modificador in, com restrições mais claras e visibilidade para quem chama."
pubDate: 2023-10-28
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/10/csharp-ref-readonly-parameters"
translatedBy: "claude"
translationDate: 2026-05-01
---
O modificador `ref readonly` permite uma forma mais transparente de passar referências somente leitura para um método. Passar referências readonly já era possível em C# com o modificador `in` desde a versão 7.2, mas essa sintaxe tinha algumas limitações, ou melhor, restrições de menos.

E como o novo modificador funciona? Vamos supor a seguinte assinatura de método:

```cs
void FooRef(ref readonly int bar) { }
```

Chamar o método passando simplesmente uma variável inteira ou um valor vai gerar um **aviso** do compilador. Atenção: é apenas um aviso. Ele aponta uma ambiguidade na sua implementação, mas o seu código continua executando se você insistir.

```cs
var x = 42;

FooRef(x);
FooRef(42);
```

-   `FooRef(x)` dispara o aviso CS9192: Argument 1 should be passed with 'ref' or 'in' keyword
-   `FooRef(42)` dispara o aviso CS9193: Argument 1 should be a variable because it is passed to a 'ref readonly' parameter

Vamos um a um.

## `FooRef(x)`: usando `ref` ou `in`

Essa é uma das melhorias em relação ao modificador `in`. O `ref readonly` deixa explícito para quem chama que o valor está sendo passado por referência. Com o `in`, isso não era transparente para o chamador e podia gerar confusão.

Para corrigir o CS9192, basta alterar a chamada para `FooRef(ref x)` ou `FooRef(in x)` explicitamente. As duas anotações são quase equivalentes; a principal diferença é que `in` é mais permissivo e aceita valores não atribuíveis, enquanto `ref` exige uma variável atribuível.

Por exemplo:

```cs
readonly int y = 43;

FooRef(in y);
FooRef(ref y);
```

`FooRef(in y)` funciona sem problemas, enquanto `FooRef(ref y)` dispara um erro do compilador dizendo que o valor ref precisa ser uma variável atribuível.

## `FooRef(42)`: só variáveis são permitidas

Essa é a outra melhoria do `ref readonly` em relação ao `in`: ele passa a reclamar quando você tenta passar um rvalue, ou seja, um valor sem localização. Isso casa com o aviso anterior, porque, se você tentar `FooRef(ref 42)`, vai receber imediatamente o erro de compilação CS1510: A ref or out value must be an assignable variable.
