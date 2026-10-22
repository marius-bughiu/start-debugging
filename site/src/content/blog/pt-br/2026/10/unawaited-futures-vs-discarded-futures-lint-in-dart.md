---
title: "unawaited_futures vs discarded_futures no Dart: qual lint pega qual chamada sem await"
description: "unawaited_futures só olha dentro de corpos async, discarded_futures só dentro de corpos síncronos, e os dois deixam passar arrow functions, tear-offs e literais de coleção. Medido caso a caso no Dart 3.12.2 e no Flutter 3.44.8, com o analysis_options.yaml que eu recomendo."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "lints"
  - "async"
lang: "pt-br"
translationOf: "2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Resposta curta:** os dois lints dividem o trabalho de acordo com o tipo de corpo de função em que a chamada está. `unawaited_futures` reporta um `Future` descartado dentro de um corpo `async`. `discarded_futures` reporta um `Future` (ou `FutureOr`) descartado dentro de um corpo síncrono, o que no Flutter significa `initState`, `dispose` e todo bloco `onPressed: () { ... }`. Eles nunca disparam na mesma linha. Se você for habilitar só um, habilite `unawaited_futures`: é barato e cada ocorrência provavelmente é um bug. Adicione `discarded_futures` quando estiver disposto a escrever `unawaited(...)` em cada chamada fire-and-forget intencional no código de widgets. Tudo abaixo foi medido com `dart analyze` no Dart 3.12.2 (Flutter 3.44.8, `meta` 1.19.0).

Nenhuma das duas regras está no núcleo nem no conjunto recommended de `package:lints`, nem no `package:flutter_lints` 6.0.0, então um projeto novo criado com `flutter create` não reporta nenhuma delas até você ativá-las.

## A comparação em resumo

| | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- |
| Onde olha | statements dentro de corpos `async` / `async*` | statements dentro de corpos síncronos |
| Tipos que reporta | `Future` e subtipos (incl. `TickerFuture`) | `Future`, subtipos e `FutureOr` |
| Disponível desde | antiga, anterior ao Dart 2.18 | Dart 2.18 |
| Em `lints` / `flutter_lints` | não / não | não / não |
| Ocorrência típica no Flutter | `Navigator.pushNamed(...)` dentro de `onPressed: () async { ... }` | `_load();` em `initState`, `_controller.forward();` |
| Silenciada por `unawaited(...)` | sim | sim |
| Silenciada por `@awaitNotRequired` (`meta` 1.17.0+) | sim | sim |
| Correção em massa com `dart fix --apply` | não (apenas quick fix da IDE) | não (apenas quick fix da IDE) |
| Nível de ruído em um app Flutter | baixo | médio a alto |

## Por que existem duas regras em vez de uma

As duas regras são wrappers finos do mesmo visitor, `UnusedFuturesVisitor`, em `pkg/linter/lib/src/util/unused_futures.dart`. O visitor percorre três tipos de nós: expression statements, seções de cascata e interpolações de string. Para cada expressão, ele pergunta à regra se a expressão é "interessante", e esse filtro é toda a diferença entre os dois lints. Este é o filtro de `unawaited_futures.dart` na tag `3.12.2`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/unawaited_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule is not currently concerned with `FutureOr`.
  if (type == null || !type.isOrImplementsFuture) {
    return false;
  }
  // This rule is only concerned with code in async functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isAsynchronous ?? false;
},
```

E o de `discarded_futures.dart`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/discarded_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule does concern itself with `FutureOr`.
  if (type == null || !type.isOrImplementsFutureOrFutureOr) {
    return false;
  }
  // This rule is only concerned with code in sync functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isSynchronous ?? false;
},
```

Duas consequências saem direto desse código. Primeiro, quem decide é o `FunctionBody` envolvente mais próximo, não o método externo. Um closure de bloco `() { save(); }` escrito dentro de um método `async` é um corpo síncrono, então pertence ao `discarded_futures`. Segundo, `FutureOr` só é coberto no lado síncrono. Um `FutureOr<int>` descartado dentro de um método `async` não é reportado por nenhuma das regras.

A motivação também difere. `unawaited_futures` mira o `await` esquecido: você já está em uma função `async`, então a correção é uma palavra-chave. `discarded_futures` mira o `async` esquecido: uma função síncrona que dispara trabalho assíncrono normalmente indica que a própria função deveria ter sido `async` e que quem a chama deveria esperar por ela. A documentação oficial de `discarded_futures` diz exatamente isso, e aponta para `unawaited_futures` como a regra que assume quando a função passa a ser `async`.

## O arquivo de casos: o que dispara onde

Coloquei em um único arquivo todos os formatos de chamada que consegui imaginar e rodei `dart analyze` com as duas regras habilitadas sobre `package:lints/recommended.yaml`:

```yaml
# analysis_options.yaml, Dart 3.12.2
include: package:lints/recommended.yaml
linter:
  rules:
    - unawaited_futures
    - discarded_futures
```

```dart
// Dart 3.12.2, meta 1.19.0
import 'dart:async';
import 'package:meta/meta.dart';

Future<void> save() async {}
FutureOr<int> maybeAsync() => 1;
@awaitNotRequired
Future<void> log(String m) async {}

class Repo {
  Future<void> flush() async {}
}

Future<void> asyncCaller() async {
  save(); // A1
  maybeAsync(); // A2 FutureOr in async
  final f = save(); // A3 assigned
  unawaited(save()); // A4
  log('x'); // A5 awaitNotRequired
  Repo()..flush(); // A6 cascade
  print('${save()}'); // A7 interpolation
  var list = [save()]; // A8 collection
  Future.delayed(Duration.zero, () => 1); // A9
  <String, Future<void>>{}.putIfAbsent('k', save); // A10
  void inner() {
    save(); // A11 sync closure inside async
  }
  [1].forEach((_) async {
    save(); // A12 async closure
  });
  save().then((_) {}); // A13 .then chain
  save().ignore(); // A14 ignore()
  await f;
  inner();
  list.length;
}

void syncCaller() {
  save(); // S1
  maybeAsync(); // S2 FutureOr in sync
  final f = save(); // S3 assigned
  unawaited(save()); // S4
  log('x'); // S5 awaitNotRequired
  Repo()..flush(); // S6 cascade
  takesFuture(save()); // S7 argument
  f.ignore();
}

Future<void> syncReturn() {
  return save(); // S8 returned
}

void takesFuture(Future<void> f) {}

void Function() handler = () => save(); // S9 arrow in sync closure
void Function() handler2 = () {
  save(); // S10 block sync closure
};
Future<void> Function() handler3 = () async {
  save(); // S11 async closure
};
```

Os resultados, lidos da saída do `dart analyze`:

| Caso | Código | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- | --- |
| A1 | `save();` em `async` | reportado | - |
| A2 | `maybeAsync();` (`FutureOr`) em `async` | - | - |
| A3, S3 | `final f = save();` | - | - |
| A4, S4 | `unawaited(save());` | - | - |
| A5, S5 | callee com `@awaitNotRequired` | - | - |
| A6 | `Repo()..flush();` em `async` | reportado | - |
| A7 | `'${save()}'` em `async` | reportado | - |
| A8 | literal de coleção `[save()]` | - | - |
| A9 | `Future.delayed(d, computation)` | - | - |
| A10 | `Map.putIfAbsent` | - | - |
| A11 | closure de bloco dentro de um método `async` | - | reportado |
| A12 | closure `async` | reportado | - |
| A13 | `save().then((_) {});` | reportado (em `then`) | - |
| A14 | `save().ignore();` | - | - |
| S1 | `save();` em sync | - | reportado |
| S2 | `maybeAsync();` em sync | - | reportado |
| S6 | `Repo()..flush();` em sync | - | reportado |
| S7 | `takesFuture(save());` | - | - |
| S8 | `return save();` | - | - |
| S9 | closure arrow `() => save()` | - | - |
| S10 | `() { save(); }` | - | reportado |
| S11 | `() async { save(); }` | reportado | - |

Algumas linhas merecem uma frase cada.

- **A9 e A10 são exceções fixas no código.** O visitor ignora `Future.delayed` quando chamado com um argumento de computação, e `Map.putIfAbsent`, porque ambos retornam valores que as pessoas ignoram de propósito com frequência.
- **A13 é reportado em `then`, não em `save`.** `save().then(...)` retorna um novo `Future`, e é esse que é descartado. Encadear um `.then` não substitui tratar o resultado.
- **A14 está limpo porque `Future.ignore()` retorna `void`.** É a alternativa em forma de chamada de método a `unawaited(...)`, disponível desde o Dart 2.14. Diferente de `unawaited`, ele também engole qualquer erro com que o future complete, então use apenas quando você realmente não se importa.
- **S7 está limpo de propósito.** Passar o future para um parâmetro tipado como `Future<void>` entrega a responsabilidade para quem recebe.

## Os pontos cegos que as duas regras compartilham

Duas linhas dessa tabela são falsos negativos reais, e ambos estão registrados no repositório upstream.

**Corpos arrow (S9).** `() => save()` é um corpo de expressão síncrono que retorna o `Future`. O visitor só olha para statements, então nada dispara, mesmo quando o closure é atribuído a um `void Function()` e o future é jogado fora por quem chama. Esse é o [dart-lang/sdk#61155](https://github.com/dart-lang/sdk/issues/61155).

**Tear-offs passados a callbacks `void`.** Também rodei isto:

```dart
// Dart 3.12.2
void execute(void Function() cb) => cb();

void tearoffs() {
  execute(save); // Future<void> Function() passed as void Function()
}
```

Nenhuma das regras reportou. O Dart permite um `Future<void> Function()` onde se espera um `void Function()`, então o future é descartado dentro de `execute` e nenhum lint o enxerga. O [dart-lang/sdk#56921](https://github.com/dart-lang/sdk/issues/56921) cobre isso. O lint relacionado é `avoid_void_async`, que só pega funções `async` declaradas como retornando `void`, não tear-offs.

Some os literais de coleção (A8) e o `FutureOr` dentro de corpos `async` (A2) e você tem a lista completa dos formatos em que um future descartado passa sem ser reportado. `unawaited` também não aceita um `FutureOr` hoje ([dart-lang/sdk#63818](https://github.com/dart-lang/sdk/issues/63818)), então para S2 a correção limpa é `final _ = maybeAsync();` ou aguardar o valor.

## Como isso aparece em um widget Flutter

A mesma divisão é o que define o nível de ruído em um app Flutter, porque a maioria dos callbacks de widgets é síncrona. No Flutter 3.44.8 com as duas regras sobre `package:flutter_lints/flutter.yaml`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class _HomeState extends State<Home> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this);

  Future<void> _load() async {}

  @override
  void initState() {
    super.initState();
    _load(); // F1: discarded_futures
    _c.forward(); // F2: discarded_futures (TickerFuture implements Future)
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      TextButton(
        onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const Home())), // F3: nothing
        child: const Text('a'),
      ),
      TextButton(
        onPressed: () {
          Navigator.of(context).pushNamed('/x'); // F4: discarded_futures
        },
        child: const Text('b'),
      ),
      TextButton(
        onPressed: () async {
          await _load();
          if (!context.mounted) return;
          Navigator.of(context).pushNamed('/x'); // F5: unawaited_futures
        },
        child: const Text('c'),
      ),
    ]);
  }
}
```

F2 é o que mais irrita as pessoas. `AnimationController.forward()`, `reverse()`, `repeat()` e `animateTo()` retornam todos um `TickerFuture`, e quase ninguém os aguarda. Com `discarded_futures` ligado, cada um deles precisa de `unawaited(...)`. F1, por outro lado, é exatamente o bug para o qual a regra existe: `_load()` em `initState` joga o erro na zone em vez de em um `try`/`catch` que você escreveu, e se ele chamar `setState` depois que o widget já saiu, você está no [território da verificação de mounted](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

F3 e F4 fazem a mesma coisa. Só a forma de bloco é reportada, o que significa que trocar um callback de `{ ... }` para `=>` silencia `discarded_futures` sem corrigir nada.

## Quando escolher unawaited_futures

- **Você quer uma regra com taxa de falsos positivos próxima de zero.** Dentro de uma função `async`, um `Future` descartado quase sempre é um `await` esquecido, e o erro que ele carrega vai pular o seu `try`/`catch` e cair no [`PlatformDispatcher.onError` ou na sua zone protegida](/pt-br/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).
- **Você escreve Dart de servidor ou de CLI.** `main` normalmente é `async`, então a maior parte do seu código está coberta, e o código síncrono restante raramente inicia trabalho assíncrono.
- **Seu time já usa callbacks `async`.** Se os seus handlers são `onPressed: () async { ... }`, essa regra os cobre (F5).

## Quando adicionar discarded_futures

- **Você publica um pacote.** Um método público síncrono que inicia trabalho assíncrono em silêncio é um cheiro de API, e essa regra encontra todos eles.
- **Você quer que o fire-and-forget seja visível no code review.** Com a regra ligada, todo descarte intencional aparece como `unawaited(...)` ou carrega `@awaitNotRequired` no callee, e esse é justamente o objetivo.
- **Você já teve um bug por causa de trabalho em `initState` que ninguém aguardou.** Esse é o caso F1, e só essa regra o enxerga.

Se você a adicionar a um app Flutter existente, espere que a maioria das ocorrências sejam chamadas de `AnimationController` e navegação em callbacks de bloco. Nenhuma das regras tem correção em massa via `dart fix` no Dart 3.12.2 (`dart fix --dry-run` não propôs nada para elas no meu repro), então, diferente das [migrações que você pode aplicar no repositório inteiro com `dart fix`](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/), essa limpeza é feita com um quick fix da IDE por vez.

## Marcando APIs como seguras para descartar com @awaitNotRequired

Para as suas próprias APIs projetadas para fire-and-forget (log, analytics, aquecimento de cache), anote a declaração em vez de envolver cada ponto de chamada:

```dart
// Dart 3.12.2, meta 1.19.0
import 'package:meta/meta.dart';

@awaitNotRequired
Future<void> track(String event) async {
  // send to analytics, errors handled inside
}

void onTap() {
  track('tap'); // neither rule reports this
}
```

`@awaitNotRequired` chegou no `package:meta` 1.17.0, e o 1.18.1 passou a permiti-lo em typedefs, então um parâmetro de callback tipado com um typedef anotado também fica isento. Os dois lints o respeitam (A5 e S5 acima), e a verificação também percorre os membros sobrescritos, então uma sobrescrita de um método anotado continua isenta. Use apenas quando a função trata os próprios erros: a anotação diz ao analisador que descartar o future é seguro, e cabe a você tornar isso verdade. O Flutter 3.47 reexporta a anotação de `package:flutter/foundation.dart`; se um pacote que a usa quebrar o seu build do 3.44, veja [a correção do nome indefinido `awaitNotRequired`](/pt-br/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).

## A pegadinha que escolhe por você

Se a sua base de código depende de callbacks arrow (`onPressed: () => doThing()`), `discarded_futures` entrega menos do que o seu ruído sugere, porque a forma arrow é invisível para ele (S9, F3). Nessa base de código, `unawaited_futures` sozinho mais uma regra do time de "trabalho assíncrono vai em callbacks `async`" já dá a maior parte do valor. Se a sua base usa callbacks de bloco e loaders em `initState`, `discarded_futures` é a única regra que enxerga essas chamadas, e vale o esforço dos `unawaited`.

Quem vem de C# vai reconhecer o formato do problema: é a versão Dart do [CS4014, "this call is not awaited"](/pt-br/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/), só que o C# o reporta apenas em métodos `async`, que é a metade do `unawaited_futures`. O Dart permite que você ative a outra metade.

## Minha recomendação

Ative `unawaited_futures` em todo projeto Dart e Flutter hoje. Adicione `discarded_futures` em pacotes e em apps em que você quer que o fire-and-forget seja explícito, e aceite escrever `unawaited(_controller.forward())`. Esta é a configuração que eu uso:

```yaml
# analysis_options.yaml, Flutter 3.44.8 / Dart 3.12.2
include: package:flutter_lints/flutter.yaml

linter:
  rules:
    - unawaited_futures
    - discarded_futures
    - avoid_void_async
```

`avoid_void_async` é o complemento: ele reporta `void bad() async {}` e obriga você a declarar `Future<void>`, de modo que o future exista no sistema de tipos onde as outras duas regras (e quem chama) conseguem enxergá-lo. Ele não corrige a lacuna dos tear-offs, mas impede que você crie novas funções `async` cujos futures ninguém consegue aguardar.

## Relacionados

- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/pt-br/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [How to use BuildContext safely after an await in Flutter](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [How to run dart fix across a whole repo to apply Flutter migrations](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/pt-br/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Fix CS4014: because this call is not awaited, execution continues](/pt-br/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)

## Fontes

- [unawaited_futures](https://dart.dev/tools/linter-rules/unawaited_futures) e [discarded_futures](https://dart.dev/tools/linter-rules/discarded_futures) no dart.dev.
- Código-fonte das regras na tag 3.12.2: [unawaited_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unawaited_futures.dart), [discarded_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/discarded_futures.dart), [unused_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/util/unused_futures.dart).
- [`awaitNotRequired` em package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html) e o [changelog do meta](https://pub.dev/packages/meta/changelog).
- Issues upstream: [#61155](https://github.com/dart-lang/sdk/issues/61155) (corpos arrow), [#56921](https://github.com/dart-lang/sdk/issues/56921) (tear-offs), [#63818](https://github.com/dart-lang/sdk/issues/63818) (`unawaited` e `FutureOr`).
