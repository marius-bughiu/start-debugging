---
title: "Como capturar erros assíncronos não tratados no Flutter com runZonedGuarded e PlatformDispatcher.instance.onError"
description: "FlutterError.onError só enxerga erros lançados dentro de callbacks do framework. Futures sem await, timers, streams e o código depois de um await vão para outro lugar. Veja qual handler captura qual erro, medido no Flutter 3.44.8, e a configuração do main() que captura todos eles, inclusive na web."
pubDate: 2026-10-18
template: how-to
tags:
  - "flutter"
  - "dart"
  - "error-handling"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Resposta curta:** no Flutter 3.44 você precisa de dois handlers, não de um. `FlutterError.onError` recebe os erros lançados dentro de callbacks do framework (build, layout, paint, um `onPressed` síncrono). `PlatformDispatcher.instance.onError` recebe tudo o mais que ninguém capturou no isolate raiz: uma `Future` sem await, um callback de `Timer`, uma stream sem `onError` e qualquer código que rode depois de um `await`, incluindo o corpo de um handler de botão `async`. Configure os dois no início de `main()` e retorne `true` no callback do dispatcher. `runZonedGuarded` é a forma mais antiga de capturar o segundo grupo e continua sendo a única opção no Flutter web, porque o engine web nunca chama `PlatformDispatcher.onError`. Erros lançados em um isolate que você mesmo cria não chegam a nenhum dos dois handlers, a menos que você passe uma porta `onError`.

Tudo abaixo foi medido no Flutter 3.44.8 (stable) com Dart 3.12.2, em um build release de um app desktop macOS que dispara cada tipo de erro e registra qual handler o recebeu. O roteamento dos handlers é o mesmo no Android e no iOS, já que ele fica no código compartilhado do engine e do framework.

## Por que FlutterError.onError não vê erros assíncronos

A maioria das perguntas do tipo "meu reporter de crashes não vê esse erro" vem de assumir que `FlutterError.onError` é um captura-tudo global. Não é. O framework o chama a partir de seus próprios blocos `try`/`catch`: quando o `build` de um widget lança, quando um `RenderObject` lança durante o layout ou o paint, quando o callback de um gesture recognizer lança, quando um callback do scheduler lança e quando um handler de mensagem de plataforma lança. Cada um desses pontos embrulha o erro em um `FlutterErrorDetails` com uma string de `context` como "while handling a gesture" ou "during a platform message callback" e o entrega a `FlutterError.reportError`, que chama `FlutterError.onError`.

Um erro lançado quando não há nenhum frame do framework na pilha de chamadas nunca passa por um desses blocos `try`/`catch`. Considere este botão:

```dart
// Flutter 3.44.8, Dart 3.12.2
ElevatedButton(
  onPressed: () async {
    await api.save();          // throws SocketException
    showSnackBar('Saved');
  },
  child: const Text('Save'),
)
```

O gesture recognizer chama `onPressed`, a closure executa até o primeiro `await`, devolve uma `Future` e o bloco `try` do recognizer termina sem erro. Quando `api.save()` falha mais tarde, a exceção completa essa `Future` com um erro. Ninguém a aguarda (o recognizer ignorou o valor de retorno), então o erro fica "não tratado" e sobe pela cadeia de zonas. Na zona raiz, o engine do Flutter o encaminha para `PlatformDispatcher.instance.onError`. Se ele não estiver definido, o erro é impresso no log e ignorado. O app continua rodando, e é por isso que esses erros costumam passar despercebidos até que um usuário reporte um botão que "não faz nada".

## A matriz de handlers, medida

Montei um pequeno app macOS no Flutter 3.44.8 que, depois do primeiro frame, dispara um tipo de erro por execução e registra qual handler o recebeu. A configuração foi a documentada: `FlutterError.onError` mais `PlatformDispatcher.instance.onError` em `main()`, sem zonas.

| O que lançou | Handler que o recebeu |
| --- | --- |
| Throw síncrono em `onPressed` | `FlutterError.onError` (context: "while handling a gesture") |
| Throw em `build` | `FlutterError.onError` |
| Throw depois de um `await` em um `onPressed` `async` | `PlatformDispatcher.instance.onError` |
| `Future.delayed(..., () => throw ...)` sem await | `PlatformDispatcher.instance.onError` |
| Callback de `Timer` | `PlatformDispatcher.instance.onError` |
| `Stream.error(...).listen((_) {})` sem `onError` | `PlatformDispatcher.instance.onError` |
| `MethodChannel.invokeMethod` sem await em um canal inexistente | `PlatformDispatcher.instance.onError` (`MissingPluginException`) |
| `Isolate.run(() => throw ...)` sem await | `PlatformDispatcher.instance.onError` |
| Ponto de entrada de `Isolate.spawn` que lança, sem porta `onError` | Nenhum. O engine imprimiu `Unhandled exception` a partir de `dart_isolate.cc` |
| O mesmo, com `onError: port.sendPort` | O listener do `RawReceivePort` |

`Isolate.run` cai no dispatcher porque relança o erro do filho na `Future` devolvida no isolate raiz, e essa `Future` não foi aguardada. Um `Isolate.spawn` puro não faz isso: o erro morre junto com o isolate filho. O próprio comentário de documentação do engine em `onError` diz isso diretamente: ele "is not directly invoked by errors in child isolates of the root isolate."

## O main() recomendado, passo a passo

Esta é a configuração que captura todas as linhas da tabela no Android, iOS, macOS, Windows e Linux.

1. Chame `WidgetsFlutterBinding.ensureInitialized()` primeiro se você fizer qualquer trabalho assíncrono antes de `runApp` (inicializar seu reporter de crashes, ler preferências).
2. Atribua `FlutterError.onError`. Chame `FlutterError.presentError(details)` dentro dele para que a caixa vermelha de erro e o dump no console continuem aparecendo nos builds de debug, e depois encaminhe `details.exception` e `details.stack` para o seu reporter.
3. Atribua `PlatformDispatcher.instance.onError`. Encaminhe o erro e a stack e retorne `true`.
4. Chame `runApp`.
5. Para cada isolate criado com `Isolate.spawn`, passe uma porta `onError` e encaminhe o que chegar para o mesmo reporter.

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ErrorReporter.instance.initialize();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details); // keep the debug console output
    ErrorReporter.instance.report(
      details.exception,
      details.stack ?? StackTrace.empty,
      fatal: false,
      context: details.context?.toDescription(),
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
    return true; // handled: do not print the default "Unhandled Exception"
  };

  runApp(const MyApp());
}

// For isolates you spawn yourself.
Future<Isolate> spawnReported<T>(void Function(T) entry, T message) {
  final errors = RawReceivePort((Object? pair) {
    final list = pair! as List<Object?>;
    ErrorReporter.instance.report(
      list[0]!,
      StackTrace.fromString(list[1]! as String),
      fatal: false,
    );
  });
  return Isolate.spawn(entry, message, onError: errors.sendPort);
}
```

A porta `onError` recebe uma lista de dois elementos: o `toString()` do erro e a stack trace como string. Você perde o tipo original da exceção na fronteira do isolate, então registre a string como ela chega em vez de tentar fazer uma checagem com `is`.

Se você usa o Firebase Crashlytics, a configuração documentada por ele tem o mesmo formato: `FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError` e `PlatformDispatcher.instance.onError` chamando `recordError(error, stack, fatal: true)` e retornando `true`. Outros SDKs de crash, o Sentry incluído, instalam handlers equivalentes durante a própria inicialização, então não os sobrescreva depois sem encadear com o handler anterior.

## O que faz o valor de retorno de PlatformDispatcher.onError

O tipo de retorno do callback é `bool`, e isso importa. O engine documenta assim: retorne `true` se você tratou o erro; caso contrário, retorne `false` e "a fallback mechanism such as printing to stderr will be used". Executei o caso da `Future` sem await com o callback retornando `false`. O callback rodou e, em seguida, o engine também imprimiu `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: unawaited Future` com a stack completa. Com `true`, só o meu handler rodou.

Em nenhum dos casos o processo encerrou. Um erro Dart não tratado no Flutter não derruba o app: o event loop segue para o próximo evento. Isso é bom para os usuários, mas ruim para a visibilidade, porque o único sintoma é uma ação pela metade. Se você quer uma política de falhar rápido, implemente você mesmo no handler (por exemplo `if (kReleaseMode) exit(1);`, como a documentação do Flutter mostra para `FlutterError.onError`) e pense bastante antes de publicar isso.

## runZonedGuarded: quando você ainda precisa dele

Antes de o Flutter 3.3 (agosto de 2022) adicionar `PlatformDispatcher.onError`, o conselho padrão era envolver `runApp` em `runZonedGuarded`, de modo que todo erro assíncrono gerado por código rodando naquela zona chegasse ao seu callback `onError` em vez de à zona raiz. Ainda funciona, e verifiquei que captura as mesmas linhas que o dispatcher:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      ErrorReporter.instance.report(details.exception, details.stack ?? StackTrace.empty);
    };
    runApp(const MyApp());
  }, (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
  });
}
```

Com essa configuração, a `Future` sem await, o throw depois de um `await` em `onPressed` e o `Isolate.run` sem await chegaram todos ao callback da zona. O erro de `build` continuou indo para `FlutterError.onError`, porque o framework o captura antes que ele possa virar um erro de zona. Portanto, a zona substitui o dispatcher, não o `FlutterError.onError`.

Se você definir os dois (dispatcher atribuído dentro da zona protegida), a zona vence. Na minha execução, só o callback de `runZonedGuarded` disparou para a `Future` sem await, e `PlatformDispatcher.instance.onError` nunca foi chamado, porque o erro foi tratado antes de chegar à zona raiz. Isso é inofensivo, mas significa que um SDK de crash que dependa do dispatcher não verá nada dos erros gerados dentro da sua zona. Escolha um único mecanismo.

Há três motivos para continuar usando uma zona em 2026:

- **Flutter web.** O engine web guarda o callback e nunca o chama. No código-fonte da 3.44.8, `lib/web_ui/lib/src/engine/platform_dispatcher.dart` tem `// TODO(dnfield): make this work on web.` acima do setter, e a issue de acompanhamento [flutter/flutter#100277](https://github.com/flutter/flutter/issues/100277) continua aberta. Na web, `runZonedGuarded` é a única forma de capturar erros assíncronos globalmente.
- **Valores de zona.** Se você depende de `zoneValues` (um logger com escopo de requisição, um relógio de teste), você já está criando uma zona e pode adicionar o handler de erro nela.
- **Tratamento com escopo.** Uma zona pode envolver um único subsistema, por exemplo um job de sincronização, para que seus erros sejam marcados e roteados separadamente do restante do app.

Para um app multiplataforma que também é publicado na web, a configuração pragmática é: atribuir o handler do dispatcher (ele cobre mobile e desktop) e envolver o corpo de `main` em `runZonedGuarded` apenas quando `kIsWeb` for true. Mantenha os dois callbacks apontando para o mesmo reporter.

## O aviso "Zone mismatch"

Desde o Flutter 3.10, os builds de debug verificam se o binding foi inicializado na mesma zona que depois chama `runApp`. Esta é a versão quebrada mais comum:

```dart
// Flutter 3.44.8: triggers "Zone mismatch" in debug builds
void main() {
  WidgetsFlutterBinding.ensureInitialized(); // root zone
  runZonedGuarded(() => runApp(const MyApp()), reportError); // child zone
}
```

Meu build de debug o reportou via `FlutterError.onError` com o context "during runApp":

```text
Zone mismatch.
The Flutter bindings were initialized in a different zone than is now being used.
```

É um aviso, não um crash, e na minha execução a `Future` sem await ainda chegou ao callback da zona, porque `initState` rodou dentro da zona de `runApp`. O perigo está nos callbacks que o binding registrou no engine enquanto estava na zona raiz: eventos de ponteiro, mensagens de plataforma e callbacks de frame são invocados na zona que estava ativa quando foram registrados. Erros vindos desses caminhos podem contornar sua zona protegida, que é exatamente a inconsistência que o aviso descreve. A correção é mover `ensureInitialized()` (e qualquer `await` que dependa dele) para dentro do corpo de `runZonedGuarded`, como na seção anterior. Defina `BindingBase.debugZoneErrorsAreFatal = true` como primeira instrução de `main` se quiser que o CI falhe nesse caso.

## Armadilhas que escondem erros mesmo assim

- **`catchError` que não retorna nada.** `future.catchError((e) => log(e))` em uma `Future<int>` lança um `ArgumentError` em tempo de execução no Dart 3, porque o handler precisa retornar um valor do tipo da future. Use `try`/`await`/`catch` no lugar.
- **`unawaited()` esconde a intenção, não os erros.** Envolver uma chamada em `unawaited(...)` silencia o lint `unawaited_futures`, mas o erro ainda vai para o dispatcher. Normalmente é isso que você quer, mas não trate isso como tratamento de erros.
- **Uma `StreamSubscription` sem `onError`.** Todo evento de erro em uma subscription assim é reportado como não tratado. Com uma stream de longa duração que erra repetidamente, seu reporter recebe um relatório por evento. Adicione `onError` às subscriptions que você controla e cancele-as, como explicado em [o guia de dispose de StreamSubscription](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).
- **Crashes nativos.** Um segfault no código Kotlin, Swift ou C de um plugin nunca chega ao Dart. Para esses casos você precisa do lado nativo do seu SDK de crash.
- **`flutter test`.** O framework de testes executa cada teste em sua própria zona e falha o teste em qualquer erro não tratado, então os handlers definidos em `main()` não são exercitados por testes de widget. Teste seu reporting chamando diretamente as funções dos handlers.
- **Ordem dos handlers com SDKs.** Se um SDK define `FlutterError.onError` e você o atribui de novo depois, você o substitui silenciosamente. Salve o valor anterior (`final previous = FlutterError.onError;`) e chame-o a partir do seu handler.

## Leituras relacionadas

- [How to handle network errors gracefully in a Flutter app](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) trata de capturar erros onde eles acontecem, o que é sempre melhor do que depender do handler global.
- [How to write a Dart isolate for CPU-bound work](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) explica `Isolate.run` versus `Isolate.spawn`, o que decide se o erro de um isolate chega ou não ao isolate raiz.
- [What is the difference between a Dart isolate and a thread](/pt-br/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) explica por que os erros não conseguem cruzar a fronteira de um isolate como objetos.
- [How to use BuildContext safely after an await in Flutter](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) trata do outro bug clássico em handlers de botão `async`.

## Fontes

- Flutter docs: [Handling errors in Flutter](https://docs.flutter.dev/testing/errors)
- Flutter docs: [Zone mismatch message](https://docs.flutter.dev/release/breaking-changes/zone-errors) e [flutter/flutter#122836](https://github.com/flutter/flutter/pull/122836)
- API reference: [PlatformDispatcher.onError](https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html), [FlutterError.onError](https://api.flutter.dev/flutter/foundation/FlutterError/onError.html), [runZonedGuarded](https://api.dart.dev/stable/dart-async/runZonedGuarded.html), [Isolate.spawn](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- Issue: [Implement PlatformDispatcher.onError for web (flutter/flutter#100277)](https://github.com/flutter/flutter/issues/100277)
- Firebase: [Customize your Crashlytics crash reports (Flutter)](https://firebase.google.com/docs/crashlytics/flutter/customize-crash-reports)
