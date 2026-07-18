---
title: "Correção: ScaffoldMessenger.of() foi chamado com um contexto que não contém um Scaffold (Flutter)"
description: "Este erro significa que o BuildContext que você passou está acima do Scaffold ou do ScaffoldMessenger, não abaixo. Envolva a chamada em um Builder, extraia-a para o próprio widget ou use um GlobalKey."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "snackbar"
lang: "pt-br"
translationOf: "2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-18
---

`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold` (e seu gêmeo mais antigo, `Scaffold.of() called with a context that does not contain a Scaffold`) significa que o `BuildContext` que você entregou ao `.of()` está *acima* do `Scaffold` ou do `ScaffoldMessenger` que ele tenta encontrar, não abaixo. Quase sempre acontece quando você o chama a partir do mesmo método `build` que retorna o `Scaffold`. Corrija envolvendo a chamada em um `Builder`, extraindo-a para o próprio widget ou alcançando o messenger por meio de um `GlobalKey`. Testado no Flutter 3.x (3.44), Dart 3.x.

## O erro em contexto

Há duas mensagens muito relacionadas, e qual você recebe depende de qual API você chamou. A clássica, da API `Scaffold.of()` anterior à 2.0 que muitas respostas antigas do Stack Overflow ainda usam:

```
Scaffold.of() called with a context that does not contain a Scaffold.
No Scaffold ancestor could be found starting from the context that was passed
to Scaffold.of(). This usually happens when the context provided is from the
same StatefulWidget as that whose build function actually creates the Scaffold
widget being sought.
```

A moderna, de `ScaffoldMessenger.of()`, que é a API que você deveria usar para exibir um `SnackBar`:

```
No ScaffoldMessenger widget found.
Scaffold widgets require a ScaffoldMessenger widget ancestor.
Typically, the ScaffoldMessenger widget is introduced by the MaterialApp at
the top of your application widget tree.
```

As duas são o mesmo bug com roupas diferentes: uma busca por ancestral que começa alto demais na árvore e caminha na direção errada. Entender *por que* a busca falha é a diferença entre colar um `Builder` e torcer, e saber exatamente qual correção a sua situação precisa.

## Por que a busca começa no lugar errado

`ScaffoldMessenger.of(context)` e `Scaffold.of(context)` ambos fazem um percurso de ancestrais. Internamente eles chamam `context.dependOnInheritedWidgetOfExactType` (por meio de um `_ScaffoldMessengerScope` herdado), que começa no elemento de `context` e sobe *para cima* rumo à raiz, procurando o ancestral correspondente mais próximo. Ele nunca olha para baixo.

Agora imagine o widget que falha. Você escreveu um método `build` que retorna um `Scaffold`, e em algum ponto desse método você chama `Scaffold.of(context)` ou `ScaffoldMessenger.of(context)` usando o parâmetro `context` desse mesmo `build`. Esse `context` pertence ao elemento do *seu* widget. Seu widget é o **pai** do `Scaffold` que ele retorna. Então, quando a busca sobe a partir do seu elemento, o `Scaffold` que você acabou de criar está abaixo do ponto de partida, e o percurso nunca o alcança. Ele passa direto pelo seu widget e sobe para o que quer que esteja acima de você, não encontra nada apropriado e lança a asserção.

Esse é exatamente o cenário que a mensagem clássica aponta: "the context provided is from the same StatefulWidget as that whose build function actually creates the Scaffold widget being sought".

Há uma sutileza que vale a pena conhecer, porque explica por que você pode ou não ver o erro. `MaterialApp` insere um `ScaffoldMessenger` perto do topo da sua árvore para você. Isso significa que `ScaffoldMessenger.of(context)` normalmente tem sucesso *mesmo a partir de um contexto que não tem nenhum Scaffold acima*, porque ele encontra o messenger em nível de aplicativo. Então a variante "No ScaffoldMessenger widget found" só dispara quando genuinamente não há nenhum messenger ancestral: você está acima do `MaterialApp`, construiu o app com um `WidgetsApp` cru e sem messenger, ou criou um escopo `ScaffoldMessenger` personalizado e está chamando de fora dele. A falha muito mais comum em código real é a de `Scaffold.of()`, ou um `SnackBar` que aparece no lugar errado porque você resolveu o messenger errado.

## A reprodução mínima

O gatilho menor e mais confiável é um botão colocado diretamente no método `build` que retorna o `Scaffold`, chamando `.of()` com o `context` desse método:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            // context here is HomePage's context, which is ABOVE the Scaffold.
            Scaffold.of(context).showSnackBar(   // throws
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        ),
      ),
    );
  }
}
```

Troque `Scaffold.of` por `ScaffoldMessenger.of` e, como `MaterialApp` fornece um messenger, a falha desaparece, mas o `SnackBar` agora é gerenciado pelo messenger raiz em vez do `Scaffold` desta tela. Isso é aceitável para a maioria dos apps, e é exatamente por isso que a migração para `ScaffoldMessenger` foi feita. Mas, se você tem escopos `ScaffoldMessenger` aninhados, ainda pode resolver o errado a partir do contexto errado.

## Correção 1: use ScaffoldMessenger.of, não Scaffold.of

Se o seu erro é a variante de `Scaffold.of()` e você só está tentando exibir, ocultar ou remover um `SnackBar`, a primeira e melhor correção é simplesmente parar de usar `Scaffold.of()`. `Scaffold.of().showSnackBar()` foi descontinuado no Flutter 2.0 e removido; a API atual está em `ScaffoldMessenger`:

```dart
// Flutter 3.x (tested 3.44)
// Before (deprecated, throws from the same build context):
Scaffold.of(context).showSnackBar(mySnackBar);
Scaffold.of(context).hideCurrentSnackBar();
Scaffold.of(context).removeCurrentSnackBar();

// After (current API):
ScaffoldMessenger.of(context).showSnackBar(mySnackBar);
ScaffoldMessenger.of(context).hideCurrentSnackBar();
ScaffoldMessenger.of(context).removeCurrentSnackBar();
```

Como o messenger vive acima do `Scaffold` da sua tela (normalmente no nível do `MaterialApp`), a busca para cima tem sucesso a partir do contexto do seu `build`. Como bônus, os `SnackBar` agora persistem e animam através das transições de rota em vez de sumir quando você navega, que era todo o propósito do redesenho do `ScaffoldMessenger`. `showSnackBar` também retorna um `ScaffoldFeatureController` que você pode usar para aguardar o motivo de fechamento:

```dart
// Flutter 3.x (tested 3.44)
final controller = ScaffoldMessenger.of(context).showSnackBar(
  SnackBar(
    content: const Text('Item deleted'),
    action: SnackBarAction(label: 'Undo', onPressed: _undo),
  ),
);
final reason = await controller.closed; // SnackBarClosedReason.action, .timeout, ...
```

## Correção 2: obtenha um contexto abaixo do Scaffold com um Builder

Às vezes você realmente precisa de um contexto que seja descendente do `Scaffold`: você está chamando `Scaffold.of(context)` para algo que não é um `SnackBar` (abrir o drawer com `Scaffold.of(context).openDrawer()`, ler `Scaffold.of(context).hasAppBar`), ou configurou um `ScaffoldMessenger` local e precisa resolver *esse*. A correção mais barata é um `Builder`, que introduz um contexto novo cuja posição na árvore está abaixo do `Scaffold`:

```dart
// Flutter 3.x (tested 3.44)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Builder(
      builder: (innerContext) {          // innerContext is BELOW the Scaffold
        return ElevatedButton(
          onPressed: () {
            ScaffoldMessenger.of(innerContext).showSnackBar(
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        );
      },
    ),
  );
}
```

O `Builder` não faz nada além de chamar sua função `builder`, mas o `innerContext` que ele passa pertence a um elemento que é filho do `Scaffold`. Agora o percurso para cima atinge o `Scaffold` (e o escopo do messenger) imediatamente. Use o contexto interno, não o externo: esse é o truque inteiro.

## Correção 3: extraia a chamada para o próprio widget

`Builder` é um atalho para uma correção estrutural: separe o botão em um `StatelessWidget` ou `StatefulWidget` à parte. Seu método `build` recebe um contexto que está naturalmente abaixo do `Scaffold`, então `.of()` resolve corretamente e você nunca mais pensa nisso:

```dart
// Flutter 3.x (tested 3.44)
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: const Center(child: SaveButton()),
    );
  }
}

class SaveButton extends StatelessWidget {
  const SaveButton({super.key});

  @override
  Widget build(BuildContext context) {
    // This context is a descendant of the Scaffold above.
    return ElevatedButton(
      onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      ),
      child: const Text('Save'),
    );
  }
}
```

Esta é a opção a preferir para qualquer coisa além de um callback descartável. É mais legível que um `Builder` aninhado, mantém o widget da sua tela enxuto e torna o botão testável de forma independente.

## Correção 4: use um GlobalKey quando não houver contexto utilizável

As correções baseadas em contexto assumem que você está dentro da árvore de widgets no momento em que exibe a mensagem. Quando você não está (um `SnackBar` disparado de um `bloc`, um repositório, um callback em segundo plano ou um manipulador de erros que não tem `BuildContext`), alcance o messenger por meio de um `GlobalKey<ScaffoldMessengerState>` conectado ao `MaterialApp`:

```dart
// Flutter 3.x (tested 3.44)
final rootScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: rootScaffoldMessengerKey,
      home: const HomePage(),
    );
  }
}

// Anywhere, with no BuildContext at all:
void notifySaved() {
  rootScaffoldMessengerKey.currentState?.showSnackBar(
    const SnackBar(content: Text('Saved')),
  );
}
```

`currentState` é null até o app ter sido montado, então proteja com `?.`. Este é o padrão recomendado oficialmente para exibir um `SnackBar` de fora de um widget, e ele contorna por completo a pergunta "qual contexto?" porque não há nenhum contexto envolvido.

## Pegadinhas e casos parecidos

**`maybeOf` retorna null em vez de lançar.** Se você quer *tentar* exibir uma mensagem e silenciosamente não fazer nada quando não há messenger (raro, mas útil em código compartilhado que pode rodar fora de uma árvore Material), use `ScaffoldMessenger.maybeOf(context)?.showSnackBar(...)`. Ele faz a mesma busca, mas retorna `null` em vez de lançar a asserção. Não recorra a ele para encobrir um bug estrutural real: se você espera que haja um messenger ali, a asserção está lhe fazendo um favor.

**Chamar `.of()` em `initState`.** Uma variante comum é tentar exibir um `SnackBar` em `initState`. O contexto existe, mas o frame ainda não foi disposto e você ainda está dentro de build/mount. Adie: `WidgetsBinding.instance.addPostFrameCallback((_) => ScaffoldMessenger.of(context).showSnackBar(...))`. Melhor ainda, use o `GlobalKey` da Correção 4 para não depender do momento do `context`.

**Usar o contexto após um `await`.** Pegar `ScaffoldMessenger.of(context)` após uma lacuna assíncrona pode lançar ou resolver um messenger obsoleto se o widget foi descartado enquanto você aguardava. Capture o messenger *antes* do await, ou proteja com `mounted`. É a mesma disciplina de [usar BuildContext com segurança após um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) e [proteger setState com a verificação de mounted](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).

**O `SnackBar` aparece na tela errada.** Sem falha, mas a mensagem aparece em uma rota diferente da que você esperava. Isso é um problema de *qual messenger*, não de *nenhum messenger*: você resolveu o messenger raiz do `MaterialApp` quando queria um `ScaffoldMessenger` aninhado com o qual envolveu uma subárvore. Resolva a partir de um contexto dentro daquele escopo aninhado (Correção 2 ou Correção 3), ou guarde uma key para o messenger específico.

**`showModalBottomSheet` e `openDrawer` batem na mesma parede.** Qualquer chamada `Scaffold.of(context)` a partir do próprio contexto de `build` da tela falha de forma idêntica, não só `showSnackBar`. `Scaffold.of(context).openDrawer()` e `showModalBottomSheet(context: context, ...)` ambos precisam de um contexto abaixo do `Scaffold`. As correções do `Builder` e de extrair um widget se aplicam sem mudanças.

**É uma asserção, então builds de release se comportam diferente.** A falha de `of()` lança a asserção em debug e lança uma exceção em release. Não presuma que um build de release que "não falhou nos testes" seja seguro: se o messenger realmente estiver faltando, o release também vai lançar. Resolva em debug.

Se a sua falha real é outro widget Material reclamando que não encontra um ancestral (`No MaterialLocalizations found`, `No Directionality widget found`, `No MediaQuery widget ancestor found`), o mecanismo é a mesma busca para cima que erra, e a correção tem a mesma forma: dê à chamada um contexto que esteja abaixo do widget de que ela precisa, ou adicione o ancestral que falta. O erro do Flutter [procurar o ancestral de um widget desativado não é seguro](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) é o primo baseado em tempo deste erro estrutural.

## Relacionado

- [Como usar BuildContext com segurança após um await no Flutter](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) -- capturar o messenger antes de uma lacuna assíncrona para que ele continue válido quando o `SnackBar` disparar.
- [Como proteger setState com a verificação de mounted após uma lacuna assíncrona no Flutter](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) -- a mesma disciplina de ciclo de vida que mantém seguras as chamadas a `.of()` após um await.
- [Correção: procurar o ancestral de um widget desativado não é seguro no Flutter](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- a falha de busca de ancestral baseada em tempo, versus esta estrutural.
- [Correção: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/pt-br/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- outro erro de "lugar errado na árvore de widgets" que o framework detecta em tempo de build.

## Fontes

- [SnackBars managed by the ScaffoldMessenger, mudanças que quebram compatibilidade do Flutter](https://docs.flutter.dev/release/breaking-changes/scaffold-messenger) -- a migração de `Scaffold.of().showSnackBar` para `ScaffoldMessenger.of().showSnackBar`, o `scaffoldMessengerKey` e a asserção exata "No ScaffoldMessenger widget found".
- [ScaffoldMessenger.of, referência da API do Flutter](https://api.flutter.dev/flutter/material/ScaffoldMessenger/of.html) -- documenta que `of()` lança a asserção em debug e uma exceção em release quando não há nenhum messenger no escopo, e aponta para `maybeOf` e o padrão do `GlobalKey`.
- [ScaffoldMessenger.maybeOf, referência da API do Flutter](https://api.flutter.dev/flutter/material/ScaffoldMessenger/maybeOf.html) -- a busca que retorna null para quando um messenger pode estar legitimamente ausente.
- [Scaffold.of, referência da API do Flutter](https://api.flutter.dev/flutter/material/Scaffold/of.html) -- a mensagem clássica "context that does not contain a Scaffold" e o remédio do `Builder`.
