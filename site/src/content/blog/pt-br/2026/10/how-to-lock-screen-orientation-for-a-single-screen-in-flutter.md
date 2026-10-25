---
title: "Como bloquear a orientação da tela em uma única tela no Flutter (e por que o multitasking do iPad a ignora)"
description: "Bloqueie uma rota do Flutter em paisagem ou retrato com SystemChrome.setPreferredOrientations sem quebrar o resto do app: um bloqueio baseado em pilha que sobrevive a pushReplacement e é restaurado no pop, por que a lista vazia é o reset errado, por que o multitasking do iPad e as telas grandes do Android 16 ignoram o bloqueio e o que UIRequiresFullScreen significa depois do iPadOS 26 e do SDK do iOS 27. Testado no Flutter 3.47.8 com Dart 3.13.7 e Xcode 27.1."
pubDate: 2026-10-25
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ios"
  - "android"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-lock-screen-orientation-for-a-single-screen-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-25
---

Para bloquear uma tela no Flutter, chame `SystemChrome.setPreferredOrientations` quando a rota aparecer e depois devolva as orientações normais do app quando a rota sair. Não escreva a versão ingênua, em que `initState` define paisagem e `dispose` volta para retrato. Em um teste de widget no Flutter 3.47.8 (Dart 3.13.7), essa versão só restaura o retrato depois que a animação de pop termina. Pior, `pushReplacement` entre duas telas bloqueadas deixa a nova tela em retrato. Use o pequeno bloqueio baseado em pilha abaixo e restaure em `PopScope.onPopInvokedWithResult`. Mesmo assim, o bloqueio é um pedido, não uma garantia. O iPadOS o ignora enquanto o app pode fazer multitasking (Split View, Slide Over e o sistema de janelas do iPadOS 26). O Android 16 o ignora em telas com pelo menos 600 dp de largura quando você usa API 36 como alvo, e o Flutter 3.47.8 usa API 36 como alvo por padrão. A antiga saída de emergência do iPad, `UIRequiresFullScreen`, está obsoleta desde o iPadOS 26 e não desativa mais o redimensionamento quando você compila com o SDK do iOS 27.

## O que setPreferredOrientations realmente faz em cada plataforma

`SystemChrome.setPreferredOrientations(List<DeviceOrientation>)` é uma única chamada de platform channel, `SystemChrome.setPreferredOrientations`, que carrega uma lista de nomes de enum. Ela guarda estado global do app. Nada nela é restrito a um widget ou a uma rota. O que você definir por último continua valendo até que algo defina de novo. Isso inclui um hot restart, porque a preferência vive no view controller ou na activity nativa, não no Dart.

As plataformas tratam isso de formas diferentes, e as diferenças importam assim que você tenta "desfazer" um bloqueio:

- **Android**: o `PlatformChannel.decodeOrientations` do engine transforma a lista em uma máscara de bits, mapeia para uma constante `ActivityInfo.SCREEN_ORIENTATION_*` e chama `activity.setRequestedOrientation(...)`. `[portraitUp]` vira `SCREEN_ORIENTATION_PORTRAIT`, `[landscapeLeft, landscapeRight]` vira `SCREEN_ORIENTATION_USER_LANDSCAPE` e a lista vazia vira `SCREEN_ORIENTATION_UNSPECIFIED`. Um pedido em runtime sobrescreve o atributo `android:screenOrientation` do seu manifest. Então, se o manifest diz `portrait` e você "reseta" com `[]`, a activity pode girar livremente depois.
- **iOS**: o `FlutterPlatformPlugin` monta uma `UIInterfaceOrientationMask` e envia uma notificação. Cada `FlutterViewController` guarda a máscara e a devolve em `supportedInterfaceOrientations`. No iOS 16 e posterior, ele chama `requestGeometryUpdateWithPreferences:` em cada `UIWindowScene` conectada e depois `setNeedsUpdateOfSupportedInterfaceOrientations`. A lista vazia vira `UIInterfaceOrientationMaskAll`, que o UIKit então intersecta com as orientações do `Info.plist`. Uma requisição de geometria que falha apenas gera um log ("Failed to change device orientation"). O future do Dart ainda completa normalmente.

Duas consequências decorrem disso. Primeiro, `[]` significa "o que o sistema operacional permitir", não "o padrão do app". Sempre restaure para uma lista explícita. Segundo, a chamada é do tipo dispare e esqueça. Aguardar o future diz que a mensagem foi entregue, não que a tela girou.

## O bloqueio ingênuo por tela e como ele quebra

Esta é a versão que a maioria das respostas sugere:

```dart
// Flutter 3.47.8, Dart 3.13.7 -- naive, do not ship
class _VideoPageState extends State<VideoPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }
}
```

Executei isso em um teste de widget que intercepta `SystemChannels.platform` e registra cada chamada de orientação entre eventos de navegação. Este é o log no Flutter 3.47.8:

```text
naive push/pop: [landscapeLeft,landscapeRight] -- pop -- first frame of pop animation [portraitUp] -- pop animation done
naive replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [portraitUp]  => final [portraitUp]
```

A primeira linha mostra o bug de timing. `dispose` só roda depois que a transição de saída da rota termina, então a tela anterior desliza de volta enquanto o dispositivo ainda está bloqueado em paisagem, e só depois encaixa em retrato. Em um celular de verdade, o usuário vê a tela anterior animar de volta em um layout paisagem durante toda a transição de pop, e só então ela gira.

A segunda linha é o bug de correção. Com `pushReplacement` (ou o `replace` / `go` do `go_router` para uma rota irmã), o `initState` da nova rota roda antes do `dispose` da rota antiga. A página de vídeo que chega pede paisagem. Depois a página de vídeo que sai "limpa" e força retrato. O estado final é retrato em uma tela que queria paisagem. O mesmo acontece sempre que duas telas bloqueadas se sobrepõem no tempo de vida, por exemplo em um `TabBarView` ou em um `PageView` que mantém as vizinhas vivas.

## Um bloqueio com dono, empilhado e liberado no pop

A correção é parar de tratar a orientação como algo que cada tela define e reseta. Em vez disso, mantenha uma única pilha de pedidos para o app inteiro. Cada tela empilha a própria entrada e remove somente essa entrada, e o topo da pilha (ou o padrão do app) é o que vai para a plataforma:

```dart
// Flutter 3.47.8, Dart 3.13.7
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// App-wide orientation stack. The top entry wins; when it is empty the
/// app default applies.
class OrientationLocks {
  OrientationLocks._();

  static List<DeviceOrientation> appDefault = const [DeviceOrientation.portraitUp];
  static final List<(Object, List<DeviceOrientation>)> _stack = [];

  static void push(Object owner, List<DeviceOrientation> orientations) {
    _stack.removeWhere((e) => identical(e.$1, owner));
    _stack.add((owner, orientations));
    _apply();
  }

  static void remove(Object owner) {
    final before = _stack.length;
    _stack.removeWhere((e) => identical(e.$1, owner));
    if (_stack.length != before) _apply();
  }

  static void _apply() {
    final target = _stack.isEmpty ? appDefault : _stack.last.$2;
    SystemChrome.setPreferredOrientations(target);
  }
}
```

O widget que a usa empilha o bloqueio quando sua rota se torna a atual. Ele libera o bloqueio em dois lugares: quando um pop começa (por meio do `PopScope`) e em `dispose` como reserva para rotas removidas sem um pop, como a rota antiga em um `pushReplacement`:

```dart
// Flutter 3.47.8, Dart 3.13.7
/// Locks orientation while this widget's route is the current route.
class OrientationLock extends StatefulWidget {
  const OrientationLock({
    super.key,
    required this.orientations,
    required this.child,
  });

  final List<DeviceOrientation> orientations;
  final Widget child;

  @override
  State<OrientationLock> createState() => _OrientationLockState();
}

class _OrientationLockState extends State<OrientationLock> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != _route) {
      _route = route;
      // isCurrent is false while another route covers this one.
      if (route == null || route.isCurrent) {
        OrientationLocks.push(this, widget.orientations);
      }
    }
  }

  @override
  void didUpdateWidget(OrientationLock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.orientations, widget.orientations)) {
      OrientationLocks.push(this, widget.orientations);
    }
  }

  @override
  void dispose() {
    OrientationLocks.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      onPopInvokedWithResult: (didPop, result) {
        // Release the lock when the pop starts, not when the exit
        // animation ends, so the previous screen does not animate in
        // under the wrong orientation.
        if (didPop) OrientationLocks.remove(this);
      },
      child: widget.child,
    );
  }
}
```

Usá-lo em uma rota é um único wrapper:

```dart
// Flutter 3.47.8, Dart 3.13.7
Navigator.of(context).push(MaterialPageRoute<void>(
  builder: (_) => const OrientationLock(
    orientations: [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    child: VideoPage(),
  ),
));
```

O mesmo harness de teste, executado contra esta versão:

```text
stack push/pop: [landscapeLeft,landscapeRight] -- pop [portraitUp] -- first frame of pop animation -- pop animation done
stack replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [landscapeLeft,landscapeRight]  => final [landscapeLeft,landscapeRight]
```

O retrato é pedido no mesmo frame em que o pop começa, então a rotação e a transição reversa acontecem juntas. Depois da substituição, o vídeo continua em paisagem, porque remover a entrada da página que sai reaplica a entrada da página que chega, e não o padrão.

Há uma decisão de design embutida aqui. Uma rota sem seu próprio `OrientationLock` herda o bloqueio mais próximo abaixo dela na pilha. Se um player em paisagem empilha uma folha de configurações simples, a folha também fica em paisagem. Se você quer "tudo o que não tem bloqueio fica em retrato", envolva essas rotas com um `OrientationLock(orientations: [DeviceOrientation.portraitUp])` explícito. Com o `go_router`, coloque o wrapper no `builder` ou no `pageBuilder` da rota. `ModalRoute.of` e `PopScope` funcionam do mesmo jeito dentro do navigator aninhado de um `ShellRoute`, o que o post sobre [rotas aninhadas e deep links com go_router](/pt-br/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) detalha.

## Defina o padrão do app no projeto nativo, não apenas no Dart

Se o app inteiro é retrato, exceto uma tela, declare o retrato também de forma nativa, para que a tela de abertura e o primeiro frame já estejam corretos:

1. Em `android/app/src/main/AndroidManifest.xml`, adicione `android:screenOrientation="portrait"` ao elemento `MainActivity`.
2. Em `ios/Runner/Info.plist`, mantenha `UISupportedInterfaceOrientations` (iPhone) e `UISupportedInterfaceOrientations~ipad` listando toda orientação de que qualquer tela vá precisar. O Flutter só pode restringir o que o `Info.plist` permite. Ele não pode adicionar nada a isso. O template do 3.47.8 lista retrato e as duas paisagens para iPhone, e as quatro orientações para iPad.
3. Em `main`, defina `OrientationLocks.appDefault` e aplique-o antes de `runApp`:

```dart
// Flutter 3.47.8, Dart 3.13.7
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  OrientationLocks.appDefault = const [DeviceOrientation.portraitUp];
  await SystemChrome.setPreferredOrientations(OrientationLocks.appDefault);
  runApp(const MyApp());
}
```

Não restrinja o `Info.plist` do iPhone apenas a retrato para depois pedir paisagem pelo Dart. No iOS 16+, a requisição de geometria falha porque a scene não suporta nenhuma das orientações pedidas. Ela falha em silêncio, a não ser por uma linha de log no Xcode.

## Por que o multitasking do iPad ignora o bloqueio

O comentário de documentação de `setPreferredOrientations` no Flutter 3.47.8 diz isso claramente: "This setting will only be respected on iPad if multitasking is disabled." O motivo é o UIKit, não o Flutter. Quando um app pode dividir a tela (Split View, Slide Over, Stage Manager e as janelas livremente redimensionáveis que chegaram com o iPadOS 26), o tamanho e a orientação da scene pertencem ao sistema. O usuário pode girar o iPad com o seu app em um layout lado a lado. O sistema não gira a tela inteira por causa de um único app, então `supportedInterfaceOrientations` deixa de ser respeitado. O Flutter ainda envia o pedido, e o UIKit simplesmente não age sobre ele.

Por anos, a solução documentada, e a que a documentação do Flutter ainda menciona, era desativar o multitasking. Isso era feito marcando "Requires full screen" no Xcode, o que grava `UIRequiresFullScreen = YES` no `Info.plist`. Isso não é mais uma resposta de longo prazo. O [TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key) da Apple diz:

- A partir do iPadOS 26, `UIRequiresFullScreen` e seu modo de compatibilidade estão obsoletos e serão ignorados em uma versão futura.
- A partir do iOS 27 e do iPadOS 27, apps compilados com o SDK do iOS 27 que definem a chave são redimensionados de forma discreta em vez de serem mantidos em tela cheia. A única exceção é quando `UIRequiresFullScreenIgnoredStartingWithVersion` nomeia a versão 27 ou anterior.
- Para suportar scenes redimensionáveis, um app deve suportar todas as orientações de interface.

O Xcode 27.1 traz o SDK do iOS 27. Então, para um app Flutter que você compila hoje, marcar "Requires full screen" não tira mais o app do redimensionamento no iOS 27, e a Apple disse aos desenvolvedores para pararem de depender disso. Threads dos fóruns de desenvolvedores do ciclo do iPadOS 26.x também relatam apps somente paisagem aparecendo em retrato quando o bloqueio de rotação do dispositivo está desligado. Trate qualquer bloqueio de orientação no iPad como melhor esforço.

O que a Apple oferece no lugar é um bloqueio *temporário*. Um view controller pode sobrescrever `prefersInterfaceOrientationLocked` e chamar `setNeedsUpdateOfPrefersInterfaceOrientationLocked()`. Isso pede ao sistema que mantenha a orientação atual da scene enquanto esse controller estiver visível, por exemplo durante uma captura de câmera ou um gesto de direção em um jogo. O TN3192 é explícito ao dizer que o sistema "does not guarantee" que vai honrar a preferência. O `FlutterViewController` do Flutter 3.47.8 não sobrescreve essa propriedade. Você pode fazer isso em uma subclasse e controlá-la por um method channel:

```swift
// Flutter 3.47.8, Xcode 27.1, iOS 26+ for prefersInterfaceOrientationLocked
import Flutter
import UIKit

class LockableFlutterViewController: FlutterViewController {
  private var locked = false
  private var channel: FlutterMethodChannel?

  override func viewDidLoad() {
    super.viewDidLoad()
    channel = FlutterMethodChannel(
      name: "app/orientation_lock", binaryMessenger: engine.binaryMessenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "setLocked", let value = call.arguments as? Bool else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.locked = value
      if #available(iOS 26.0, *) {
        self.setNeedsUpdateOfPrefersInterfaceOrientationLocked()
      }
      result(nil)
    }
  }

  override var prefersInterfaceOrientationLocked: Bool {
    locked
  }
}
```

Em `ios/Runner/Base.lproj/Main.storyboard`, troque o `customClass` do view controller raiz de `FlutterViewController` para `LockableFlutterViewController` (com `customModuleProvider="target"`). Depois chame-o a partir do Dart:

```dart
// Flutter 3.47.8, Dart 3.13.7
const _lockChannel = MethodChannel('app/orientation_lock');

Future<void> setIpadOrientationLocked(bool locked) =>
    _lockChannel.invokeMethod<void>('setLocked', locked);
```

Isso mantém a orientação que a scene já tem. Não gira para paisagem, então complementa `setPreferredOrientations` e não o substitui. Compilei essa subclasse em um app Flutter 3.47.8 com `flutter build ios --simulator` no Xcode 27.1 (deployment target iOS 15, daí a checagem `#available`). Não testei o comportamento de multitasking em um iPad físico, então verifique em hardware antes de depender disso.

## O Android 16 faz o mesmo em telas grandes

O Android seguiu pelo mesmo caminho. Segundo as [mudanças de comportamento do Android 16](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation), apps que usam API 36 como alvo ignoram `screenOrientation`, `resizableActivity`, `minAspectRatio`, `maxAspectRatio`, `setRequestedOrientation()` e `getRequestedOrientation()` em telas cuja menor largura é de pelo menos 600 dp. Isso cobre tablets, dobráveis quando abertos e janelas de desktop. O `setPreferredOrientations` do Flutter é uma chamada a `setRequestedOrientation()`, e o plugin Gradle do Flutter 3.47.8 define `flutter.targetSdkVersion` como 36. Então um app Flutter recém-criado não vai bloquear a orientação em um tablet. A própria documentação do Flutter agora traz essa limitação.

As exceções são jogos (declarados com `android:appCategory="game"`), usuários que escolhem o comportamento padrão do app nas configurações de proporção de tela do dispositivo e telas com menos de 600 dp. Celulares não são afetados. Existe uma desativação temporária:

```xml
<!-- android/app/src/main/AndroidManifest.xml, targetSdk 36 only -->
<activity android:name=".MainActivity" ...>
    <property
        android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
        android:value="true" />
</activity>
```

O Google afirma que a desativação deixa de valer quando você usa o API level 37 como alvo. Trate isso como tempo para corrigir o layout para tablets, não como uma correção. A mesma regra atingiu apps MAUI, e o post sobre a [migração do MAUI para o API level 36](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) cobre o lado do manifest com mais detalhes.

## Armadilhas quando a tela realmente gira

- **Monte o layout a partir das constraints, não do bloqueio.** A rotação chega um frame ou mais depois da sua chamada e, em iPads ou tablets Android 16, pode nunca chegar. Construa a tela bloqueada com `OrientationBuilder` ou `LayoutBuilder` para que ela renderize corretamente no tamanho que de fato receber.
- **Use o display, não `MediaQuery.size`, para decidir se deve bloquear.** No Android, o letterboxing faz `MediaQueryData.size` informar a área com letterbox. A documentação do Flutter recomenda `View.of(context).display.size / display.devicePixelRatio` contra um breakpoint de 600 pixels lógicos. Bloqueie apenas celulares e envie `[]` em tablets.
- **`landscapeLeft` significa que o dispositivo foi girado no sentido anti-horário.** `DeviceOrientation.landscapeLeft` é "90 degrees counterclockwise from portraitUp". Peça as duas paisagens, a menos que tenha um motivo para fixar uma. Caso contrário, um usuário que girou o celular para o outro lado vê a tela virar de cabeça para baixo.
- **iPhones sem botão Home nunca recebem `portraitDown`.** O TN3192 observa que o sistema remove `portraitUpsideDown` do conjunto suportado nesses modelos, não importa o que você declare.
- **Retomada do segundo plano.** A preferência nativa sobrevive ao envio para segundo plano, então você não precisa reaplicá-la ao retomar. Se você tem outro código de ciclo de vida, a [migração para AppLifecycleListener](/pt-br/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/) é um lugar mais limpo para ele do que um `WidgetsBindingObserver`.
- **Não chame depois de um `await` sem verificar `mounted`.** Bloquear depois de um carregamento assíncrono de vídeo é comum. Se o usuário já saiu da rota, um `OrientationLocks.push` tardio vindo de um `State` morto deixa um bloqueio que nada remove. As regras de [usar BuildContext com segurança depois de um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) valem aqui também.

## Leituras relacionadas

- [Rotas aninhadas e deep links com go_router](/pt-br/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/), para saber onde colocar o wrapper `OrientationLock` em uma árvore de rotas.
- [go_router vs auto_route vs Navigator 2.0](/pt-br/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/), se você está escolhendo um roteador e se importa com como as rotas de substituição são descartadas.
- [Migre de WidgetsBindingObserver para AppLifecycleListener](/pt-br/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/).
- [Migre um app .NET MAUI Android para o API level 36](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/), para a mesma regra de telas grandes do Android 16 do lado do MAUI.

## Fontes

- [Documentação da API `SystemChrome.setPreferredOrientations`](https://api.flutter.dev/flutter/services/SystemChrome/setPreferredOrientations.html) e o [código-fonte do 3.47.8](https://github.com/flutter/flutter/blob/3.47.8/packages/flutter/lib/src/services/system_chrome.dart).
- Engine do Flutter no 3.47.8: [`FlutterViewController.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterViewController.mm), [`FlutterPlatformPlugin.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterPlatformPlugin.mm), [`PlatformChannel.java`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/systemchannels/PlatformChannel.java).
- [TN3192: Migrating your app from the deprecated UIRequiresFullScreen key](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key).
- [Android 16 behavior changes: ignore orientation, resizability, and aspect ratio restrictions](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation).
- Apple Developer Forums: [iPadOS 26.x ignores supportedInterfaceOrientations when orientation lock is off](https://developer.apple.com/forums/thread/811216).
