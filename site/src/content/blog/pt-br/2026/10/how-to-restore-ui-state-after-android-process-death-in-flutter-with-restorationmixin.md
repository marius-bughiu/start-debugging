---
title: "Como restaurar o estado da UI após a morte do processo no Android em Flutter com RestorationMixin"
description: "O Android encerra apps Flutter em segundo plano para recuperar memória, e quando o usuário volta todo StatefulWidget começa do zero. Veja como ativar a restauração com restorationScopeId, RestorationMixin e propriedades Restorable, restaurar campos de texto, posições de rolagem e rotas empilhadas, escrever um RestorableValue personalizado e testar tudo com restartAndRestore e adb, verificado no Flutter 3.44.8 e em um emulador Android 16."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "state-restoration"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Resposta curta:** defina `restorationScopeId: 'app'` no seu `MaterialApp`, aplique `RestorationMixin` em todo `State` que guarda algo que o usuário odiaria perder, armazene esses dados em `RestorableInt`, `RestorableTextEditingController`, `RestorableEnum` e similares em vez de campos comuns, registre cada um em `restoreState` e empilhe telas com `Navigator.restorablePush` em vez de `Navigator.push`. O Flutter então serializa esses valores no `Bundle` de saved-instance-state do Android, e quando o Android recria a activity em um novo processo o framework os devolve antes do primeiro frame. Tudo abaixo foi verificado no Flutter 3.44.8 (Dart 3.12.2) com testes de widget e com encerramentos reais de processo em um emulador Android 16 (API 36); o `restoration.dart` não mudou na branch `stable` desde julho de 2025.

O restante do post explica o que realmente é a morte do processo e por que seu estado desaparece, monta um pequeno formulário de pedido que sobrevive a ela, cobre rotas e posições de rolagem, mostra como escrever um `RestorableValue` para sua própria classe e lista as armadilhas que encontrei nos testes, incluindo uma em que `restorablePush` falha até você mover o construtor da rota para uma função de nível superior.

## O que é a morte do processo e por que o estado do Flutter não sobrevive a ela

Quando o usuário sai do seu app, o Android para a activity, mas mantém o processo. Se a memória ficar apertada, o sistema encerra esse processo em segundo plano. Ele não avisa o usuário: o app continua aparecendo em Recentes com a última captura de tela. Quando o usuário toca nele, o Android inicia um novo processo, cria uma nova `FlutterActivity` e entrega a ela o `Bundle` que a activity antiga escreveu em `onSaveInstanceState`.

Um app Flutter mantém todo o estado da UI em objetos Dart no heap do processo morto. Um novo processo significa um novo isolate Dart, um novo `main()` e novos objetos `State`. A menos que algo tenha gravado seus contadores, campos de formulário e pilha de navegação nesse `Bundle`, eles se foram, e o usuário volta à tela inicial com um formulário vazio. Esse é o clássico bug do "tirei uma foto, voltei e o app esqueceu tudo".

O framework de restauração de estado do Flutter é a peça que escreve nesse `Bundle`. No Android, `FlutterActivityAndFragmentDelegate` armazena os dados serializados do framework como um array de bytes sob a chave `"framework"` (e o estado dos plugins sob `"plugins"`). Nada é salvo a menos que a árvore de widgets ative a restauração, e é por isso que a maioria dos apps nunca percebe que o recurso existe.

Duas situações que *não* são morte do processo e, portanto, não restauram nada por design:

- O usuário desliza o app para fora de Recentes. A tarefa é removida e o estado salvo vai junto.
- O app é encerrado à força (Configurações, ou `adb shell am force-stop`). Mesmo resultado.

Verifiquei os dois casos no emulador abaixo. A restauração serve apenas para o caso "o sistema me encerrou enquanto eu estava em segundo plano".

## As três peças necessárias para ativar a restauração

A restauração de estado é uma árvore de `RestorationBucket`s. Cada parte da árvore reivindica um bucket por ID junto ao seu pai, e os valores das folhas ficam armazenados dentro desses buckets. Você precisa de:

1. **Um escopo raiz.** `MaterialApp(restorationScopeId: 'app')` (ou `CupertinoApp`, `WidgetsApp`) cria um `RootRestorationScope` e também ativa a restauração para o `Navigator` do app. Sem ele, não há bucket para escrever e todo filho recebe `null`.
2. **`RestorationMixin` no seu `State`.** Ele reivindica um bucket filho usando o getter `restorationId` que você sobrescreve.
3. **Propriedades restauráveis.** As subclasses de `RestorableProperty<T>` encapsulam um valor e sabem convertê-lo em primitivos que o `StandardMessageCodec` consegue codificar. Você registra cada uma com uma chave única dentro do bucket.

## Um formulário de pedido mínimo que sobrevive à morte do processo

Esta é a tela que usei em todos os testes deste post. Ela tem uma quantidade, uma caixa de seleção, um enum, dois campos de texto e uma lista longa, além de um campo `int` comum para contraste.

```dart
// Flutter 3.44.8, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      restorationScopeId: 'app',
      home: OrderPage(),
    );
  }
}

enum Shipping { standard, express }

class OrderPage extends StatefulWidget {
  const OrderPage({super.key});

  @override
  State<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends State<OrderPage> with RestorationMixin {
  final RestorableInt _quantity = RestorableInt(1);
  final RestorableBool _giftWrap = RestorableBool(false);
  final RestorableEnum<Shipping> _shipping =
      RestorableEnum(Shipping.standard, values: Shipping.values);
  final RestorableTextEditingController _note = RestorableTextEditingController();
  int _plainCounter = 0; // not restorable, for contrast

  @override
  String? get restorationId => 'order_page';

  @override
  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
    registerForRestoration(_quantity, 'quantity');
    registerForRestoration(_giftWrap, 'gift_wrap');
    registerForRestoration(_shipping, 'shipping');
    registerForRestoration(_note, 'note');
  }

  @override
  void dispose() {
    _quantity.dispose();
    _giftWrap.dispose();
    _shipping.dispose();
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order')),
      body: ListView(
        restorationId: 'order_list',
        children: [
          ListTile(
            title: Text('Quantity: ${_quantity.value}'),
            trailing: IconButton(
              icon: const Icon(Icons.add),
              onPressed: () => setState(() => _quantity.value++),
            ),
          ),
          CheckboxListTile(
            title: const Text('Gift wrap'),
            value: _giftWrap.value,
            onChanged: (v) => setState(() => _giftWrap.value = v ?? false),
          ),
          SwitchListTile(
            title: Text('Shipping: ${_shipping.value.name}'),
            value: _shipping.value == Shipping.express,
            onChanged: (v) => setState(() =>
                _shipping.value = v ? Shipping.express : Shipping.standard),
          ),
          TextField(
            controller: _note.value,
            decoration: const InputDecoration(labelText: 'Note'),
          ),
          TextField(
            restorationId: 'coupon',
            decoration: const InputDecoration(labelText: 'Coupon'),
          ),
          // ... more rows
        ],
      ),
    );
  }
}
```

Alguns pontos que vale notar:

- Você lê e escreve `.value` e continua chamando `setState`. Um `RestorableValue` notifica o mixin para que o bucket seja atualizado, mas não reconstrói o seu widget por conta própria.
- `restoreState` é o único lugar onde você chama `registerForRestoration`. O framework o chama uma vez no primeiro build (com `initialRestore: true`) e de novo sempre que o bucket é trocado por baixo de você. Registrar uma propriedade carrega o valor salvo, se existir, ou o valor padrão, se não.
- Propriedades restauráveis são `ChangeNotifier`s. Descarte-as em `dispose()`; depois disso, o `RestorationMixin` limpa o próprio controle interno em `super.dispose()`.
- `RestorableTextEditingController` entrega um `TextEditingController` de verdade por `.value`. Se você só precisa do texto e não do controller, `TextField(restorationId: 'coupon')` faz a mesma coisa internamente. Os widgets nativos que aceitam um `restorationId` incluem `TextField`, `TextFormField`, widgets baseados em `Scrollable` (`ListView`, `GridView`, `CustomScrollView`, `SingleChildScrollView`, `PageView`), `Scaffold` (estado de abertura do drawer), `FormField`, `DropdownMenu` e os seletores de data e hora.

## Verificando com um encerramento real do processo

Testes de widget são rápidos, mas o que vale provar é que isso sobrevive a um encerramento de verdade. Compilei um APK de release do app acima, instalei em um emulador arm64 com API 36, preenchi o formulário e depois simulei a morte por falta de memória:

```bash
# Flutter 3.44.8 release APK on an Android 16 (API 36) emulator
flutter build apk --release
adb install -r build/app/outputs/flutter-apk/app-release.apk
# ...interact with the app, then send it to the background:
adb shell input keyevent KEYCODE_HOME
adb shell am kill net.startdebugging.restore_demo     # only kills background processes
adb shell pidof net.startdebugging.restore_demo        # prints nothing: the process is gone
adb shell am start -n net.startdebugging.restore_demo/.MainActivity
```

`am start` exibiu "Activity not started, its current task has been brought to the front", que é exatamente o que um toque em Recentes faz. O novo processo teve um PID diferente (5813 antes, 6210 depois). Na tela:

| Campo | Antes do encerramento | Depois do encerramento |
| --- | --- | --- |
| `RestorableInt` quantidade | 3 | 3 |
| contador `int` comum | 1 | 0 |
| `RestorableBool` embalagem para presente | marcada | marcada |
| `RestorableEnum` envio | express | express |
| `RestorableTextEditingController` observação | "leave at door" | "leave at door" |
| `TextField(restorationId:)` cupom | "SAVE10" | "SAVE10" |
| `TextField` sem restorationId | "gone" | vazio |
| rolagem de `ListView(restorationId:)` | rolada | mesmo deslocamento |

Depois vieram os casos negativos no mesmo build: deslizar a tarefa para fora de Recentes e reabrir resultou em quantidade 1, e `am force-stop` seguido de uma abertura deu o mesmo resultado. Como esperado, só a morte iniciada pelo sistema restaura.

Você também pode ativar **Opções do desenvolvedor > Não manter atividades** (`adb shell settings put global always_finish_activities 1`). Isso destrói a activity assim que você sai dela, mas mantém o processo vivo (o PID não mudou na minha execução), e o estado foi restaurado da mesma forma. É uma verificação manual conveniente, mas `am kill` se aproxima mais da morte real do processo porque também descarta o heap do Dart.

## Restaurando a pilha de navegação

O `Navigator` do app restaura o histórico de rotas automaticamente assim que `restorationScopeId` é definido, mas apenas para rotas que ele consegue recriar. Uma rota empilhada com `Navigator.push(context, MaterialPageRoute(...))` guarda uma closure, e closures não podem ser serializadas. Use `restorablePush`, que recebe uma função estática ou de nível superior mais argumentos que o `StandardMessageCodec` consegue codificar:

```dart
// Flutter 3.44.8
@pragma('vm:entry-point')
Route<void> _summaryRoute(BuildContext context, Object? arguments) {
  return MaterialPageRoute<void>(
    builder: (_) => SummaryPage(quantity: arguments! as int),
  );
}

// in the button's onPressed:
Navigator.restorablePush(context, _summaryRoute, arguments: _quantity.value);
```

Mesmo emulador, mesma sequência de encerramento: com `restorablePush`, o app voltou na página Summary com "Ordering 3". Com um `push` comum, voltou na página Order, com a página Summary descartada silenciosamente.

Rotas nomeadas funcionam da mesma forma com `Navigator.restorablePushNamed`. Se você empilha uma rota e precisa do resultado dela, envolva-a em um `RestorableRouteFuture<T>` e registre-o como qualquer outra propriedade, para que o callback `onComplete` seja reconectado após a restauração. Os diálogos `showDatePicker` e `showTimePicker` são restaurados pelo mesmo mecanismo quando você os abre com um `RestorableRouteFuture` e o `restorationId` do `DatePickerDialog`.

Com o go_router, passe `restorationScopeId` ao construtor `GoRouter` e a `MaterialApp.router`, e dê ao `ShellRoute` o seu próprio `restorationScopeId` para navigators aninhados. O go_router constrói os objetos `Page` para você, então `restorablePush` não é algo que você chama ali, mas rode um teste com `restartAndRestore` (abaixo) contra a sua tabela de rotas real antes de confiar nele.

## Escrevendo um RestorableValue para o seu próprio tipo

Os tipos nativos cobrem primitivos (`RestorableInt`, `RestorableDouble`, `RestorableString`, `RestorableBool` e suas variantes anuláveis `N`), `RestorableDateTime`, `RestorableEnum`, `RestorableTimeOfDay` e `RestorableTextEditingController`. Para qualquer outra coisa, crie uma subclasse de `RestorableValue<T>` e converta de e para tipos que o `StandardMessageCodec` suporta (null, bool, num, String, `Uint8List` e similares, `List`, `Map`):

```dart
// Flutter 3.44.8
class PriceFilter {
  const PriceFilter({required this.min, required this.max, required this.inStockOnly});
  final double min;
  final double max;
  final bool inStockOnly;
}

class RestorablePriceFilter extends RestorableValue<PriceFilter> {
  RestorablePriceFilter(this._defaultValue);
  final PriceFilter _defaultValue;

  @override
  PriceFilter createDefaultValue() => _defaultValue;

  @override
  void didUpdateValue(PriceFilter? oldValue) => notifyListeners();

  @override
  PriceFilter fromPrimitives(Object? data) {
    final map = (data! as Map<Object?, Object?>).cast<String, Object?>();
    return PriceFilter(
      min: map['min']! as double,
      max: map['max']! as double,
      inStockOnly: map['inStock']! as bool,
    );
  }

  @override
  Object toPrimitives() => <String, Object>{
        'min': value.min,
        'max': value.max,
        'inStock': value.inStockOnly,
      };
}
```

Dois detalhes que pegam muita gente. `didUpdateValue` precisa chamar `notifyListeners()`, caso contrário o mixin nunca fica sabendo que o valor mudou e o bucket mantém os dados antigos. E o mapa volta como `Map<Object?, Object?>`, não `Map<String, Object>`, então faça o cast em vez de usar `as Map<String, Object>`, que lança exceção. Em um teste de widget, definir o filtro como `min: 10, max: 50, inStockOnly: true` e reiniciar exibiu `50.0 true` após a restauração.

## Testando a restauração sem um dispositivo

O `flutter_test` consegue simular o ciclo completo. `restartAndRestore` captura os dados de restauração atuais, derruba a árvore de widgets e a reconstrói a partir desses dados, o que equivale ao lado Dart de uma reinicialização de processo:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('order state survives restart', (tester) async {
  await tester.pumpWidget(const App());
  await tester.tap(find.byIcon(Icons.add));
  await tester.tap(find.byIcon(Icons.add));
  await tester.pump();

  await tester.restartAndRestore();

  expect(find.text('Quantity: 3'), findsOneWidget);
});
```

Os resultados bateram exatamente com os do emulador: os campos restauráveis e o deslocamento do `ListView` (580.0 antes, 580.0 depois) voltaram, o contador comum e o `TextField` não registrado não voltaram, e uma rota de `restorablePush` sobreviveu enquanto uma rota de `push` não. Se o teste falhar com "The current widget tree did not inject the root bucket of the RestorationManager", você esqueceu o `restorationScopeId` no app.

## Armadilhas que encontrei nos testes

**`restorablePush` com um método estático pode travar o teste.** A documentação do Flutter mostra o construtor da rota como um método `static` na classe `State` com `@pragma('vm:entry-point')`. No Flutter 3.44.8, isso falhou para mim em `flutter test` com "To access 'package:restore_demo/main.dart::_OrderPageState' from native code, it must be annotated", e o teste nunca terminou. A VM resolve o handle do callback por meio da classe que o contém, então a classe também precisa do pragma. Anote a classe `State` com `@pragma('vm:entry-point')` também ou, mais simples, faça do construtor uma função de nível superior, como mostrado acima. As duas abordagens passaram.

**IDs duplicados falham em tempo de execução.** Dois widgets que reivindicam o mesmo `restorationId` sob o mesmo bucket pai lançam "Multiple owners claimed child RestorationBuckets with the same IDs" no fim do frame. Em listas, monte o ID a partir da chave estável do item (`'item_${item.id}'`), nunca do índice, ou envolva cada subárvore em seu próprio `RestorationScope`.

**Sem escopo raiz não há erro, apenas nenhuma restauração.** Sem `restorationScopeId`, seu `restoreState` ainda roda, com `bucket == null`, e as propriedades funcionam como valores comuns em memória. Nada avisa que elas não estão sendo salvas. Um único teste com `restartAndRestore` detecta isso.

**Mantenha os dados pequenos.** Os bytes trafegam pelo `Bundle` de saved-instance-state do Android, que atravessa uma transação Binder. Um payload grande lança `TransactionTooLargeException`. Armazene IDs e entradas de formulário, não listas de registros buscados; busque os dados novamente no seu repositório após a restauração.

**Engines em cache não restauram por padrão.** Em configurações add-to-app que usam `FlutterActivity.withCachedEngine`, `shouldRestoreAndSaveState()` retorna `false` para que os dados de restauração não sobrescrevam o estado de uma engine ativa. Sobrescreva-o na sua subclasse de `FlutterActivity` se quiser restauração ali.

**Restauração não é persistência.** Ela sobrevive à morte do processo, não ao fechamento do app, à reinicialização do aparelho nem a um deslize para fora de Recentes. Rascunhos que o usuário espera encontrar amanhã pertencem ao `shared_preferences` ou a um banco de dados.

**O iOS exige configuração extra.** O mesmo código Dart funciona no iOS, mas você também precisa dar ao `FlutterViewController` um identificador de restauração no projeto iOS. A página oficial "Restore state on iOS" cobre os passos.

**Riverpod, Bloc e outros gerenciadores de estado não são restaurados para você.** O estado de um provider vive no mesmo heap Dart que morreu. Ou você restaura as entradas (IDs, filtros, campos de formulário) com propriedades restauráveis e deixa o provider recalcular, ou salva o estado serializado do provider em um `RestorableValue` e o usa como semente na restauração.

## Leia a seguir

- [Fix: A TextEditingController was used after being disposed in Flutter](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [How to set up nested routes and deep links with go_router in Flutter](/pt-br/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [go_router vs auto_route vs Navigator 2.0 in Flutter](/pt-br/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/pt-br/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/pt-br/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)

## Fontes

- [Restore state on Android, Flutter docs](https://docs.flutter.dev/platform-integration/android/restore-state-android)
- [Restore state on iOS, Flutter docs](https://docs.flutter.dev/platform-integration/ios/restore-state-ios)
- [RestorationMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorationMixin-mixin.html)
- [RestorableValue, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorableValue-class.html)
- [Navigator.restorablePush, Flutter API docs](https://api.flutter.dev/flutter/widgets/Navigator/restorablePush.html)
- [WidgetTester.restartAndRestore, Flutter API docs](https://api.flutter.dev/flutter/flutter_test/WidgetTester/restartAndRestore.html)
- [GoRouter constructor, go_router API docs](https://pub.dev/documentation/go_router/latest/go_router/GoRouter/GoRouter.html)
- [Save UI states, Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states)
