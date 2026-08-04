---
title: "Como habilitar suporte a múltiplas janelas em um app desktop Flutter"
description: "O Flutter 3.44.8 estável ainda não expõe nenhuma API pública de múltiplas janelas. Veja como ligar a feature flag experimental de windowing no canal main, usar RegularWindowController e WindowManager para abrir janelas de nível superior reais, e o que usar se você precisa publicar hoje a partir do estável."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "desktop"
  - "multi-window"
  - "windowing"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app"
translatedBy: "claude"
translationDate: 2026-08-04
---

O suporte a múltiplas janelas do Flutter existe, funciona, e você não pode usá-lo a partir de uma build estável. Na versão Flutter 3.44.8 (lançada em 2026-07-23), o framework traz uma API de windowing completa em `packages/flutter/lib/src/widgets/_window.dart`, mas toda classe nela está marcada como `@internal`, o arquivo não é exportado por `package:flutter/widgets.dart`, e todo construtor lança `UnsupportedError` a menos que a feature flag `windowing` esteja ligada. Essa flag só está disponível no canal `main`. Então existem exatamente duas respostas honestas: mudar para o `main`, rodar `flutter config --enable-windowing` e usar a API real do framework para prototipar, ou ficar no estável e usar o plugin `desktop_multi_window`, que entrega janelas separadas ao custo de engines separados e isolates separados. Este post cobre as duas, com a superfície exata da API como ela está no 3.44.

## Por que `runApp` só consegue dar uma janela

O motivo de uma única janela ter sido o padrão por tanto tempo não é preguiça, é que `runApp` conecta sua árvore de widgets à *view implícita*: a única `FlutterView` que o embedder da plataforma criou para você antes de o Dart sequer iniciar. Não há nenhuma junção nessa chamada para uma segunda view, e nunca houve.

A saída tem sido `runWidget` há algum tempo, que recebe uma árvore de widgets com raiz em `View` ou `ViewCollection` em vez de assumir a view implícita. O que faltava era a outra metade: uma forma de pedir à plataforma que *crie* uma janela nativa e devolva uma `FlutterView` ligada a ela. É isso que a API de windowing adiciona. A Canonical vem liderando a implementação, e o Flutter 3.44 trouxe janelas de tooltip nas três plataformas desktop, janelas popup no macOS, controllers de janelas satélite e um `showDialog` baseado em windowing.

A decisão de design que mais importa para a sua arquitetura: **todas as janelas compartilham um engine e um isolate**. Duas janelas são duas subárvores da mesma árvore de widgets. Um `ValueNotifier` mantido em um ancestral comum é visível para as duas, sem serialização, sem method channel, sem `SendPort`. Essa é a maior diferença em relação a qualquer abordagem baseada em plugin, e é por isso que esperar por essa API costuma ser a decisão certa.

## Ligando a feature flag de windowing

A flag é definida no `flutter_tools` assim:

```dart
// packages/flutter_tools/lib/src/features.dart, Flutter 3.44.8
const windowingFeature = Feature(
  name: 'support for windowing on macOS, Linux, and Windows',
  configSetting: 'enable-windowing',
  environmentOverride: 'FLUTTER_WINDOWING',
  runtimeId: 'windowing',
  master: FeatureChannelSetting(available: true),
);
```

Repare no que está ausente: não há entrada `beta:` nem `stable:`, então ambas caem no padrão `FeatureChannelSetting()` com `available: false`. Beta também não vai funcionar. É `main` ou nada.

Ligue em três passos:

1. **Mude para o canal main.** Rode `flutter channel main` seguido de `flutter upgrade`. Se você precisa manter sua toolchain estável intacta, fixe um segundo SDK com o FVM em vez de mover seu único checkout; a mesma técnica descrita em [rodar um projeto contra vários SDKs do Flutter no CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) funciona bem localmente.
2. **Ative a flag.** Rode `flutter config --enable-windowing`. Isso grava uma configuração persistente, então você faz isso uma vez por SDK. Para CI, defina a variável de ambiente `FLUTTER_WINDOWING=true`, que a ferramenta lê como override.
3. **Recompile, não faça hot restart.** A ferramenta repassa as flags ativas para o framework como uma constante de compilação chamada `FLUTTER_ENABLED_FEATURE_FLAGS`. O framework a lê em `packages/flutter/lib/src/foundation/_features.dart`:

```dart
// packages/flutter/lib/src/foundation/_features.dart, Flutter 3.44.8
final Set<String> debugEnabledFeatureFlags = <String>{
  ...const String.fromEnvironment('FLUTTER_ENABLED_FEATURE_FLAGS').split(','),
};

bool isWindowingEnabled = debugEnabledFeatureFlags.contains('windowing');
```

`String.fromEnvironment` é avaliado como constante em tempo de compilação, então um hot restart depois de mudar a configuração não vai capturar isso. Encerre o app e rode `flutter run -d windows` (ou `macos`, ou `linux`) de novo.

Se você pular o passo 2, recebe um erro bem específico que vale reconhecer, porque ele é lançado do construtor e não na hora de renderizar:

```
Windowing APIs are not enabled.

Windowing APIs are currently experimental. Do not use windowing APIs in
production applications or plugins published to pub.dev.

To try experimental windowing APIs:
1. Switch to Flutter's main release channel.
2. Turn on the windowing feature flag.
```

## Importando uma API que não é exportada

Como `_window.dart` é uma biblioteca privada dentro de `package:flutter`, você não consegue alcançá-la por `package:flutter/widgets.dart`. Você importa o arquivo de implementação diretamente e silencia duas regras do analisador. É exatamente o que o app `examples/multiple_windows` do próprio Flutter faz:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member
// ignore_for_file: implementation_imports

import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';
```

Sim, é feio, e sim, é a forma oficialmente aceita de experimentar o recurso agora. A regra `implementation_imports` existe para impedir que você faça isso em um pacote publicado, que é exatamente a orientação no cabeçalho do arquivo: não importe em apps de produção nem em nada que você suba para o pub.dev, porque mudanças que quebram compatibilidade vão chegar em versões de patch.

## Um app mínimo de duas janelas

O menor programa completo: crie um `RegularWindowController`, embrulhe em um `RegularWindow` e passe tudo isso para `runWidget` em vez de `runApp`.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member, implementation_imports
import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final RegularWindowController controller = RegularWindowController(
    preferredSize: const Size(900, 640),
    preferredConstraints: const BoxConstraints(minWidth: 640, minHeight: 480),
    title: 'Main window',
  );

  runWidget(
    WindowManager(
      child: RegularWindow(
        controller: controller,
        child: const MaterialApp(home: HomePage()),
      ),
    ),
  );
}
```

Três coisas aqui sustentam tudo.

`WidgetsFlutterBinding.ensureInitialized()` precisa vir primeiro. A factory de `RegularWindowController` resolve `WidgetsBinding.instance.windowingOwner` imediatamente, e o `WindowingOwner` da plataforma verifica que o engine já foi inicializado. Construir um controller antes de o binding existir é a causa do assert `WindowingOwner[Platform] must be created after the engine has been initialized` registrado em flutter/flutter#178706.

O controller cria a janela nativa no construtor, não quando o widget é montado. `RegularWindow` apenas renderiza dentro de uma janela que já existe, e é por isso que a documentação é explícita: você é o dono do ciclo de vida e precisa chamar `destroy()` você mesmo.

`WindowManager` é opcional para uma única janela, mas você vai querer ele desde o começo. Ele instala um `WindowRegistry` na árvore, que é como os descendentes abrem outras janelas sem passar um controller à mão árvore abaixo.

## Abrindo uma segunda janela em tempo de execução

O padrão é: construa um controller, embrulhe em um `WindowEntry` com um builder para o conteúdo dele, e registre. `WindowManager` escuta o registry e renderiza cada entrada com o widget correto para o tipo do controller.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final WindowRegistry registry = WindowRegistry.of(context);

    return Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            late final WindowEntry entry;
            final RegularWindowController controller = RegularWindowController(
              title: 'Inspector',
              preferredSize: const Size(480, 720),
              delegate: _UnregisterOnDestroy(
                onDestroyed: () => registry.unregister(entry),
              ),
            );
            entry = WindowEntry(
              controller: controller,
              builder: (BuildContext context) => const InspectorPane(),
            );
            registry.register(entry);
          },
          child: const Text('Open inspector'),
        ),
      ),
    );
  }
}

class _UnregisterOnDestroy with RegularWindowControllerDelegate {
  _UnregisterOnDestroy({required this.onDestroyed});

  final VoidCallback onDestroyed;

  @override
  void onWindowDestroyed() {
    super.onWindowDestroyed();
    onDestroyed();
  }
}
```

A dança do `late final WindowEntry entry` não é acidente: o delegate precisa desregistrar a entrada, e a entrada precisa do controller ao qual o delegate está ligado. O app de referência do próprio Flutter usa a mesma referência antecipada.

Desregistrar importa. `WindowRegistry.unregister` só remove a entrada da lista para que o `WindowManager` pare de renderizá-la; não destrói a janela. Por outro lado, `destroy()` derruba a janela nativa mas deixa uma entrada obsoleta no registry. O delegate é o ponto de junção: deixe o `onWindowCloseRequested` padrão destruir a janela e depois limpe o registry em `onWindowDestroyed`.

## Interceptando o fechamento e o resto da superfície do controller

`RegularWindowControllerDelegate` tem exatamente dois hooks, e a implementação padrão do primeiro é o que de fato fecha suas janelas:

```dart
// packages/flutter/lib/src/widgets/_window.dart, Flutter 3.44.8
void onWindowCloseRequested(RegularWindowController controller) {
  controller.destroy();
}

void onWindowDestroyed() { }
```

Sobrescreva `onWindowCloseRequested` e *não* chame `super` quando quiser um aviso de "alterações não salvas"; depois chame `controller.destroy()` você mesmo quando o usuário confirmar. Esquecer que o `super` é o que fecha a janela é a forma mais provável de publicar uma janela que ninguém consegue fechar.

O controller expõe o estado que você esperaria, e tudo notifica mudanças porque `BaseWindowController` estende `ChangeNotifier`: `contentSize`, `title`, `isActivated`, `isMaximized`, `isMinimized`, `isFullscreen` e `rootView`. Os mutadores são `setSize`, `setConstraints`, `setTitle`, `setMaximized`, `setMinimized`, `setFullscreen(bool fullscreen, {Display? display})`, `activate` e `destroy`. Cada um é documentado como uma *solicitação*: a plataforma pode ignorar, então guie sua interface pelo estado notificado, nunca pelo que você pediu.

Dentro da subárvore de uma janela, alcance o controller pelo inherited model `WindowScope`:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
final BaseWindowController window = WindowScope.of(context);

// Rebuilds only on size changes, not on title or activation changes.
final Size size = WindowScope.contentSizeOf(context);
```

`WindowScope` é um `InheritedModel` com aspectos como chave (tamanho do conteúdo, título, ativada, maximizada, minimizada, tela cheia), então `contentSizeOf` não vai reconstruir seu widget quando a janela apenas receber foco. Use `maybeOf` se a subárvore também puder rodar na janela implícita: janelas criadas pelo entrypoint nativo ao qual `runApp` se conecta não têm `WindowScope`, e `of` lança exceção nesse caso.

## Os outros quatro tipos de janela

Janelas regulares são um dos cinco tipos de controller, todos selados sob `BaseWindowController` e todos renderizados pelo `WindowManager` via um switch:

- `DialogWindowController({BaseWindowController? parent, ...})`. Com um `parent` não nulo, o diálogo é modal em relação a ele, não tem menu de sistema, fica escondido do alternador de janelas e fecha quando o pai fecha. Com `parent: null` ele é não modal, pode ser minimizado mas não maximizado, e ganha um **botão de fechar desabilitado**. Esse último detalhe surpreende; se você quer uma janela independente que possa ser fechada, o que você quer é uma janela regular, não um diálogo sem pai.
- `PopupWindowController`, posicionado em relação a um retângulo âncora. Implementado para macOS no 3.44; Windows e Linux ainda estão chegando.
- `TooltipWindowController`, implementado nas três plataformas desktop no 3.44.
- `SatelliteWindowController`, o mais novo do conjunto, para paletas e barras de ferramentas que acompanham uma janela pai.

O Flutter 3.44 também adicionou um `showDialog` baseado em windowing que abre uma janela nativa real em vez de um overlay, atrás de uma flag `useWindowing` no `MaterialApp`.

## O que fazer se você precisa disso no estável

Se você vai publicar agora, a API do framework está fora de questão: implementation imports mais `@internal` mais mudanças que quebram compatibilidade documentadas em versões de patch não é base para um app de produção. A resposta prática continua sendo `desktop_multi_window` 0.3.0 (publicado em 2025-10-28), que suporta Windows, Linux e macOS.

```dart
// desktop_multi_window 0.3.0, Flutter 3.44.8 stable
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  final windowController = await WindowController.fromCurrentEngine();
  final arguments = parseArguments(windowController.arguments);

  switch (arguments.type) {
    case WindowType.main:
      runApp(const MainWindow());
    case WindowType.inspector:
      runApp(const InspectorWindow());
  }
}
```

Novas janelas vêm de `WindowController.create(WindowConfiguration(...))`, e a comunicação entre janelas passa por `WindowMethodChannel`, que é um method channel e portanto assíncrono e preso a um codec:

```dart
// desktop_multi_window 0.3.0
const channel = WindowMethodChannel('inspector');
channel.setMethodCallHandler((call) async {
  return switch (call.method) {
    'refresh' => 'ok',
    _ => throw MissingPluginException('Not implemented: ${call.method}'),
  };
});
```

O custo arquitetural é o que você precisa planejar. Cada janela é um engine Flutter próprio, o que significa isolate próprio, heap próprio e cópia própria de cada singleton que você inicializou no `main`. Estado compartilhado precisa ser serializado por um canal, exatamente como ao conversar com [código específico de plataforma por um MethodChannel](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Se você já estruturou um app em torno de [um isolate Dart de vida longa com SendPort e ReceivePort](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), as restrições vão parecer familiares: nada de objetos mutáveis compartilhados, tudo por mensagens.

Projete pensando nisso agora e a migração futura sai barata. Mantenha um único dono do estado da aplicação, exponha por uma interface, e deixe o transporte (referência direta hoje sob a API do framework, method channel hoje sob o plugin) atrás dessa interface. É o mesmo argumento de "arquitetura primeiro, polimento depois" que [os apps desktop em Flutter continuam provando](/pt-br/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/).

## Armadilhas que custam tempo de verdade

**Controllers são `ChangeNotifier` e você é responsável por descartá-los.** Um `RegularWindowController` guardado em um `State` precisa de `controller.dispose()` no `dispose()`, além de `destroy()` para a janela nativa. A mesma disciplina que você já aplica a [`AnimationController` e companhia](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) vale aqui, com um recurso nativo extra anexado.

**Widget tests não têm windowing.** Não existe `WindowingOwner` no binding de testes, então qualquer teste que chegue a um construtor de windowing lança `UnsupportedError`. O próprio exemplo de API do Flutter embrulha `main` em um bloco `try`/`on UnsupportedError` justamente para os smoke tests passarem. Mantenha a criação de janelas fora do código em nível de widget e atrás de uma junção que você possa substituir.

**`preferredSize` e `preferredConstraints` precisam concordar.** A factory verifica `preferredConstraints.isSatisfiedBy(preferredSize)` quando ambos são não nulos. Em builds de release o assert some e a plataforma escolhe outra coisa em silêncio.

**`decorated: false` significa que você desenha a moldura.** Janelas sem decoração chegaram no 3.44 (`Allow windows to be created undecorated`). Você não ganha barra de título, nem borda, nem região de arraste até construir tudo isso.

A issue de acompanhamento de todo o esforço é a flutter/flutter#30701, e o trabalho restante antes de a API se tornar pública é pequeno o suficiente para ser animador: flutter/flutter#177586, o checklist de pré-lançamento, se resume a remover TODOs de trechos de documentação e tirar os ignores de `invalid_use_of_internal_member` dos exemplos. Nada nela é arquitetural. Programe contra o formato dessa API, mantenha-a atrás de uma interface, e no dia em que ela chegar ao estável sua migração será uma troca de import.

## Relacionados

- [Como adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Como escrever um isolate Dart para trabalho intensivo de CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Como descartar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Como mirar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [TypeMonkey é um bom lembrete: apps desktop em Flutter precisam de arquitetura primeiro e polimento depois](/pt-br/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)

## Fontes

- [flutter/flutter#30701, a issue de acompanhamento de múltiplas janelas](https://github.com/flutter/flutter/issues/30701)
- [flutter/flutter#177586, o checklist de pré-lançamento de múltiplas janelas](https://github.com/flutter/flutter/issues/177586)
- [`packages/flutter/lib/src/widgets/_window.dart` na tag 3.44.0](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter/lib/src/widgets/_window.dart)
- [`packages/flutter_tools/lib/src/features.dart`, onde `windowingFeature` é declarada](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter_tools/lib/src/features.dart)
- [O app de referência `examples/multiple_windows` do Flutter](https://github.com/flutter/flutter/tree/3.44.0/examples/multiple_windows)
- [Notas de versão do Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)
- [Canonical sobre trazer múltiplas janelas para o Flutter desktop](https://canonical.com/blog/multiple-window-flutter-desktop)
- [`desktop_multi_window` no pub.dev](https://pub.dev/packages/desktop_multi_window)
