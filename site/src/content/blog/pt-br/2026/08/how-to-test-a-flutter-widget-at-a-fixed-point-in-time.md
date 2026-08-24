---
title: "Como testar um widget Flutter em um instante fixo sem um closure withClock"
description: "Dentro de testWidgets o clock ambiente do package:clock já é falso, mas começa na hora do sistema em que o teste iniciou. Fixe-o para a suíte inteira sobrescrevendo runTest em um AutomatedTestWidgetsFlutterBinding personalizado instalado a partir de flutter_test_config.dart. Verificado no Flutter 3.44.2, clock 1.1.2, fake_async 1.3.3."
pubDate: 2026-08-24
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "how-to"
  - "clock"
lang: "pt-br"
translationOf: "2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time"
translatedBy: "claude"
translationDate: 2026-08-24
---

Se um widget renderiza "há 3 horas" ou te cumprimenta com "Boa noite", você precisa que a noção de `now` dele seja uma constante antes de conseguir fazer asserções sobre a saída. O conselho de sempre é envolver cada corpo de teste em `withClock(Clock.fixed(...), () async { ... })`, o que fica barulhento rápido. Existe um caminho melhor, e ele começa com um fato que quase todo mundo entende errado: **dentro de `testWidgets` o `clock` ambiente do `package:clock` já é falso**. `FakeAsync.run` o instala para você, e ele só avança quando você chama `tester.pump`. O que ele não faz é começar em um instante previsível, porque `FakeAsync()` se inicializa a partir do relógio real do sistema. Corrija essa única semente e a suíte inteira fica determinística sem nenhum closure por teste. Tudo abaixo foi executado no Flutter 3.44.2 (Dart 3.12.2), `clock` 1.1.2 e `fake_async` 1.3.3.

## O que clock.now() realmente retorna dentro de testWidgets

Comece com a sonda mais simples possível. Sem arquivos de configuração, sem bindings personalizados:

```dart
// Flutter 3.44.2, Dart 3.12.2, clock 1.1.2
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('the ambient clock is already fake', (WidgetTester tester) async {
    final a = clock.now();
    await tester.pump(const Duration(hours: 1));
    final b = clock.now();
    print('a=$a');
    print('b=$b delta=${b.difference(a)}');
    print('DateTime.now delta=${DateTime.now().difference(a)}');
  });
}
```

Saída do `flutter test`:

```text
a=2026-08-24 09:19:57.248297
b=2026-08-24 10:19:57.248297 delta=1:00:00.000000
DateTime.now delta=0:00:00.094231
```

Duas coisas para ler aí. A diferença entre as duas chamadas de `clock.now()` é *exatamente* uma hora, até o microssegundo, o que nenhum relógio real jamais produz. E `DateTime.now()` avançou 94 milissegundos, que é quanto o teste realmente levou. Então `clock` é falso e `DateTime.now()` é real.

O encanamento está no `fake_async`. `FakeAsync.run` envolve o próprio callback em `withClock`:

```dart
// fake_async 1.3.3, lib/fake_async.dart
T run<T>(T Function(FakeAsync self) callback) => runZoned(
      () => withClock(_clock, () => callback(this)),
      // ...timer and microtask interception...
    );
```

E `AutomatedTestWidgetsFlutterBinding.runTest` (em `packages/flutter_test/lib/src/binding.dart`) executa o corpo inteiro do teste exatamente dentro disso:

```dart
final fakeAsync = FakeAsync();
_currentFakeAsync = fakeAsync; // reset in postTest
_clock = fakeAsync.getClock(DateTime.utc(2015));
fakeAsync.run((FakeAsync localFakeAsync) { /* test body */ });
```

Note os dois relógios distintos. `fakeAsync.getClock(DateTime.utc(2015))` é armazenado como o relógio próprio do binding, e é por isso que `tester.binding.clock.now()` informa `2015-01-01T00:00:00.000Z` em um teste novo e avança com `pump`:

```text
binding.clock            = 2015-01-01T00:00:00.000Z
binding.clock after pump(10m) = 2015-01-01T00:10:00.000Z
```

O relógio que seus widgets veem através do `package:clock` é um `Clock` *diferente* sobre o mesmo `FakeAsync`, e a origem dele vem do construtor de `FakeAsync`:

```dart
// fake_async 1.3.3
FakeAsync({DateTime? initialTime, this.includeTimerStackTrace = true}) {
  final nonNullInitialTime = initialTime ?? clock.now();
  _clock = Clock(() => nonNullInitialTime.add(elapsed));
}
```

`initialTime ?? clock.now()`. O binding chama `FakeAsync()` sem argumento, então a origem do relógio falso é o que o relógio *ambiente* disse no momento em que o teste começou. Fora de qualquer zone, isso é o relógio do sistema. Essa é a única peça de não determinismo, e é a peça que você pode controlar.

## Por que withClock em flutter_test_config.dart não faz nada

A sugestão mais comum para configuração de suíte inteira é `flutter_test_config.dart`. Parece que deveria funcionar:

```dart
// test/flutter_test_config.dart -- DOES NOT WORK
import 'dart:async';
import 'package:clock/clock.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await withClock(
    Clock.fixed(DateTime.utc(2026, 3, 14, 9, 26, 53)),
    () async => testMain(),
  );
}
```

Duas armadilhas aqui. A primeira é um erro de compilação se você escrever o óbvio `return withClock(fixed, testMain)`: `withClock<T>` infere `T` a partir do tipo de retorno, então exige um `Future<void> Function()` enquanto `testExecutable` te entrega um `FutureOr<void> Function()`. Você precisa inserir seu próprio closure.

A segunda armadilha é que, mesmo depois de compilar, isso não tem efeito nenhum. Adicionar prints nos dois lados deixa a ordem óbvia:

```text
CFG before testMain, zone clock=2026-08-24T09:16:56.269316
CFG inside zone, clock=2026-03-14T09:26:53.000Z
MAIN body, clock=2026-03-14T09:26:53.000Z
CFG testMain returned, still inside zone
CFG after zone
P12 body, clock=2026-08-24T09:16:56.295534
```

A zone cobre o `main()` de nível superior do arquivo de teste, que apenas *declara* testes com `test` e `testWidgets`. O `package:test` executa cada corpo declarado depois, a partir da própria linhagem de zones, muito após `testExecutable` ter retornado. `withClock` tem escopo de zone, então uma zone que já saiu não pode influenciar nada. Qualquer artigo que te diga para envolver `testMain` em `withClock` nunca verificou isso.

Para o que o `flutter_test_config.dart` *serve* é executar código uma vez antes da suíte. Construir um binding é exatamente esse tipo de código.

## Os três passos para fixar o relógio na suíte inteira

1. Declare os pacotes que você está a ponto de importar. `clock` vai em `dependencies` porque o código de produção vai chamar `clock.now()`; adicione `meta` em `dev_dependencies` só se você também quiser a anotação `@isTest` da última seção, caso contrário o analisador reporta `depend_on_referenced_packages`.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.2
   dependencies:
     flutter:
       sdk: flutter
     clock: ^1.1.2
   ```

2. Herde de `AutomatedTestWidgetsFlutterBinding` e sobrescreva `runTest` para que `super.runTest` execute dentro de uma zone com relógio fixo. Esse é todo o truque: `super.runTest` é o que constrói `FakeAsync()`, e `FakeAsync` lê o relógio ambiente para o seu `initialTime`.

   ```dart
   // test/flutter_test_config.dart -- Flutter 3.44.2
   import 'dart:async';
   import 'package:clock/clock.dart';
   import 'package:flutter/foundation.dart';
   import 'package:flutter_test/flutter_test.dart';

   final DateTime kTestEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

   class FixedStartBinding extends AutomatedTestWidgetsFlutterBinding {
     @override
     Future<void> runTest(
       Future<void> Function() testBody,
       VoidCallback invariantTester, {
       String description = '',
     }) {
       return withClock(
         Clock.fixed(kTestEpoch),
         () => super.runTest(testBody, invariantTester, description: description),
       );
     }
   }
   ```

3. Instancie o binding a partir de `testExecutable`, antes de qualquer teste rodar. `TestWidgetsFlutterBinding.ensureInitialized()` retorna `_instance ?? binding.ensureInitialized(...)`, e o construtor de `AutomatedTestWidgetsFlutterBinding` define `_instance` através de `initInstances`, então o binding construído primeiro ganha. `testWidgets` vai usar o seu.

   ```dart
   Future<void> testExecutable(FutureOr<void> Function() testMain) async {
     FixedStartBinding();
     await testMain();
   }
   ```

É isso. Sem mudanças em nenhum arquivo de teste. Um widget que lê o relógio ambiente:

```dart
// Flutter 3.44.2
class AmbientClockBanner extends StatelessWidget {
  const AmbientClockBanner({super.key});

  @override
  Widget build(BuildContext context) => Text(
        'ambient:${clock.now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}
```

agora renderiza igual em toda máquina e em toda execução:

```text
binding      = FixedStartBinding
ambient      = 2026-03-14T09:26:53.000Z
binding.clock= 2015-01-01T00:00:00.000Z
rendered     = ambient:2026-03-14T09:26:53.000Z
```

E como você semeou o `FakeAsync` em vez de substituir o relógio dele, o tempo falso continua se movendo sob seu controle:

```dart
testWidgets('advances with pump only', (WidgetTester tester) async {
  final a = clock.now();
  await tester.pump(const Duration(hours: 3, minutes: 30));
  final b = clock.now();
  print('a=$a b=$b delta=${b.difference(a)}');
});
// a=2026-03-14 09:26:53.000Z
// b=2026-03-14 12:56:53.000Z delta=3:30:00.000000
```

`clock.stopwatch()` está ligado ao mesmo relógio falso, então `pump(Duration(seconds: 42))` produz um elapsed de exatamente `0:00:42.000000`. Todo teste volta para a época escolhida, porque `runTest` constrói um `FakeAsync` novo a cada vez.

## Início fixo versus relógio congelado: onde você coloca withClock decide

Existe uma segunda variante, e a diferença é uma linha de aninhamento. Envolva `testBody` em vez de `super.runTest` e sua zone é estabelecida *dentro* de `FakeAsync.run`, então ela oculta o relógio falso por completo:

```dart
// test/frozen/flutter_test_config.dart -- Flutter 3.44.2
class FrozenClockBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  Future<void> runTest(
    Future<void> Function() testBody,
    VoidCallback invariantTester, {
    String description = '',
  }) {
    return super.runTest(
      () => withClock(Clock.fixed(kFrozen), testBody),
      invariantTester,
      description: description,
    );
  }
}
```

Agora `pump` move o tempo de animação do framework para frente mas `clock.now()` nunca sai do lugar:

```text
a=2026-03-14 09:26:53.000Z b=2026-03-14 09:26:53.000Z delta=0:00:00.000000
```

Nenhuma das duas variantes interfere nas animações, porque `Ticker` e `SchedulerBinding` se guiam pelos timestamps de frame do `FakeAsync`, não pelo `package:clock`. Um `showDialog` mais `pumpAndSettle` sob o binding congelado ainda resolve e encontra o diálogo. Escolha pelo que você está afirmando:

| | Envolver `super.runTest` | Envolver `testBody` |
| --- | --- | --- |
| Instante inicial | fixo | fixo |
| Avança com `pump` | sim | não |
| Mecanismo | semeia `FakeAsync.initialTime` | oculta o relógio do `FakeAsync` |
| Bom para | timestamps relativos, contagens regressivas, debounce | saudações tipo "Boa noite", formatação de datas |

Uma coisa a evitar: não construa um relógio lazy que delegue para o relógio próprio do binding, como em `withClock(Clock(() => this.clock.now()), ...)`. O construtor de `FakeAsync` chama `clock.now()` antes de o binding ter entrado no teste, e `AutomatedTestWidgetsFlutterBinding.clock` afirma `inTest`:

```text
'package:flutter_test/src/binding.dart': Failed assertion: line 2223 pos 12: 'inTest': is not true.
package:clock/src/clock.dart 44:26   Clock.now
package:fake_async/fake_async.dart 106:53   new FakeAsync
package:flutter_test/src/binding.dart 2482:23   AutomatedTestWidgetsFlutterBinding.runTest
```

Um `Clock.fixed` simples evita o problema inteiro.

## Um wrapper por teste quando você só precisa dele em alguns arquivos

Se um binding personalizado é mais maquinaria do que você quer, escreva o closure uma vez como wrapper. A anotação `@isTest` do `package:meta` mantém o analisador e a descoberta de testes da IDE satisfeitos:

```dart
// Flutter 3.44.2, clock 1.1.2, meta 1.18.0
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meta/meta.dart';

final DateTime kEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

@isTest
void testWidgetsAt(
  String description,
  WidgetTesterCallback callback, {
  DateTime? at,
  bool skip = false,
}) {
  testWidgets(
    description,
    (WidgetTester tester) =>
        withClock(Clock.fixed(at ?? kEpoch), () => callback(tester)),
    skip: skip,
  );
}
```

Porque a zone do wrapper abrange o corpo inteiro do teste, toda reconstrução durante o teste vê o relógio fixo, incluindo as disparadas por `tap` e `setState` depois de um `await`. Essa é a diferença crucial em relação a envolver só uma parte de um teste. Se você escrever `await withClock(fixed, () async { await tester.pumpWidget(w); })` e depois reconstruir o widget após o closure sair, a reconstrução escapa da zone e cai silenciosamente no relógio falso mas semeado com a hora do sistema. Eu medi isso: dentro do closure o widget renderizou `2026-03-14T09:26:53.000Z`, e um `pumpWidget` depois dele renderizou `2026-08-24T09:15:30.029972`.

Um `withClock` local ainda sobrepõe o que vale para todo o binding, então as duas técnicas se combinam. Sob `FixedStartBinding`, um teste que envolve o corpo em `withClock(Clock.fixed(DateTime.utc(2031, 5, 2, 7)))` renderiza `2031-05-02T07:00:00.000Z`.

## DateTime.now() não é falsificável, e nenhum binding vai te salvar

O `package:clock` é pura consulta de zone. A implementação inteira do getter de nível superior é:

```dart
// clock 1.1.2, lib/src/default.dart
Clock get clock => Zone.current[_clockKey] as Clock? ?? const Clock();
```

Não existe global atribuível. Também não existe nada análogo para `DateTime.now()`, que vai direto para a VM. Um widget que o chama ignora o tempo falso completamente, mesmo um ano inteiro dele:

```text
raw:2026-08-24T09:19:57.370144
after pump(365 days) -> raw:2026-08-24T09:19:57.376244
```

Seis microssegundos de diferença, os dois reais. Então se o seu widget ou o seu model chama `DateTime.now()` direto, nada do que está acima ajuda. Ou você migra esses pontos de chamada para `clock.now()`, ou toma o relógio como dependência e pula as zones inteiramente:

```dart
// Flutter 3.44.2
class InjectedClockBanner extends StatelessWidget {
  const InjectedClockBanner({required this.now, super.key});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => Text(
        'injected:${now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}

// test
await tester.pumpWidget(InjectedClockBanner(now: () => kEpoch));
```

Injeção é a abordagem que eu escolho em código novo, pela mesma razão que [TimeProvider e FakeTimeProvider vencem estáticos ambientes no .NET](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/): a dependência é visível no construtor em vez de escondida em uma zone. A sobrescrita do binding é a resposta pragmática para uma base de código existente que já se apoia em `clock.now()`, ou para pacotes de terceiros que você não pode editar.

Se você usa Riverpod, um `Provider<Clock>` sobrescrito no `ProviderScope` do teste é a mesma ideia com o encanamento que você já tem, e combina bem com os padrões de [Notifier vs AsyncNotifier vs StreamNotifier](/pt-br/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/).

## Quatro detalhes que vale conhecer antes de commitar isso

**Corpos de `test()` simples recebem o relógio real.** `FakeAsync` só existe dentro de `testWidgets`, então um `test('...')` no mesmo arquivo informa a hora do sistema tanto para `clock.now()` quanto para `DateTime.now()`. Se você precisa de um relógio fixo em testes unitários também, envolva aqueles corpos com `withClock` ou use `fakeAsync` do `package:fake_async` diretamente.

**`integration_test` e testes dirigidos por `flutter run` rodam em tempo real.** Quando `FLUTTER_TEST` está ausente, o `flutter_test` seleciona `LiveTestWidgetsFlutterBinding`, cujo relógio está fixado no código:

```dart
// packages/flutter_test/lib/src/binding.dart
@override
Clock get clock => const Clock();
```

Nada de `FakeAsync`, nada de relógio falso. Mantenha o arquivo de configuração em `test/` e não na raiz do projeto, porque a caminhada de descoberta procura `flutter_test_config.dart` em um diretório antes de checar naquele diretório o sentinela `pubspec.yaml`: uma configuração na raiz também se aplica a `integration_test/`, onde construir um `AutomatedTestWidgetsFlutterBinding` brigaria com `IntegrationTestWidgetsFlutterBinding`. Não conte com um relógio fixado em testes de integração.

**A descoberta do arquivo de configuração é do mais próximo primeiro.** O `flutter_tools` sobe a partir do arquivo de teste procurando `flutter_test_config.dart` e para no primeiro diretório que contenha um `pubspec.yaml`. Então `test/frozen/flutter_test_config.dart` oculta `test/flutter_test_config.dart` para tudo abaixo de `test/frozen/`, e apenas um arquivo de configuração se aplica a um dado teste. É assim que você roda uma suíte de relógio congelado e uma de início fixo lado a lado, mas também significa que você não pode empilhá-las.

**A web funciona do mesmo jeito.** `flutter test --platform chrome` passa por `_binding_web.dart`, cujo `ensureInitialized` também retorna `AutomatedTestWidgetsFlutterBinding.ensureInitialized()`, e o bootstrap web chama `testExecutable` igualmente. O binding personalizado se aplica sem mudanças.

O modelo mental que vale guardar: `testWidgets` já te dá um relógio falso, o `FakeAsync` decide onde ele começa, e a única alavanca sobre essa decisão é o relógio ambiente no momento em que `runTest` constrói o `FakeAsync`. Todo o resto é questão de escolher em qual lado de `super.runTest` o seu `withClock` fica.

## Relacionado

- [Como testar código dependente de tempo com TimeProvider e FakeTimeProvider no .NET 11](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) cobre o mesmo problema no ecossistema .NET, onde a abstração vem na BCL.
- [Como proteger setState com a checagem mounted depois de um gap assíncrono no Flutter](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) é a outra metade de escrever testes de widget que sobrevivem a fronteiras de `await`.
- [Como cancelar um StreamSubscription no dispose no Flutter](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) importa aqui porque um timer pendente no teardown dispara a mesma asserção de `_verifyInvariants` que timers falsos pendentes disparam.
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier no Flutter](/pt-br/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) para ligar um relógio injetado através de uma sobrescrita de provider em vez de uma zone.
- [Fix: A TextEditingController was used after being disposed no Flutter](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) para a classe de falhas de teste que aparece quando o tempo falso começa a se mover em saltos grandes.

## Fontes

- [Documentação da API do `package:clock`](https://pub.dev/documentation/clock/latest/) e a [implementação de `withClock`](https://pub.dev/packages/clock), versão 1.1.2.
- [`package:fake_async`](https://pub.dev/packages/fake_async) 1.3.3, em particular o construtor de `FakeAsync` e `FakeAsync.run`.
- [`AutomatedTestWidgetsFlutterBinding`](https://api.flutter.dev/flutter/flutter_test/AutomatedTestWidgetsFlutterBinding-class.html) e [`TestWidgetsFlutterBinding.clock`](https://api.flutter.dev/flutter/flutter_test/TestWidgetsFlutterBinding/clock.html) na referência da API do Flutter 3.44.
- [A documentação da biblioteca `flutter_test`](https://api.flutter.dev/flutter/flutter_test/flutter_test-library.html) para `flutter_test_config.dart` e `testExecutable`.
- Código-fonte do SDK do Flutter na tag 3.44.2: `packages/flutter_test/lib/src/binding.dart`, `packages/flutter_test/lib/src/_binding_web.dart` e `packages/flutter_tools/lib/src/test/test_config.dart`.
