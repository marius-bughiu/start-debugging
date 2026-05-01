---
title: "Flutter NoSuchMethod: the method was called on null"
description: "Esse erro do Flutter acontece quando se chama um método em uma referência de objeto null. Aprenda a diagnosticar e corrigir o NoSuchMethod usando a pilha de chamadas e breakpoints."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "pt-br"
translationOf: "2023/10/flutter-nosuchmethod-the-method-was-called-on-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esse erro acontece quando você tenta chamar um método em uma referência de objeto `null`. Esse método não existe porque o alvo da chamada é `null` ou não foi atribuído. Por exemplo:

```dart
foo.bar()
```

vai falhar com um erro `NoSuchMethod` sempre que `foo` for `null`. A mensagem será: `NoSuchMethod: the method 'bar' was called on null`.

É o equivalente a uma `NullReferenceException` em C#.

## Como corrigir?

Use a pilha de chamadas para descobrir em qual linha o erro ocorreu. Como o nome do método aparece na mensagem, em geral isso já é suficiente. Se não for, coloque um breakpoint nessa linha e, ao chegar nele, inspecione os valores das variáveis em busca de algum `null`. Quando encontrar, tente entender o que levou a esse estado e corrija.
