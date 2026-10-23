---
title: "Migre um app Flutter de WidgetsBindingObserver.didChangeAppLifecycleState para AppLifecycleListener (Flutter 3.13+)"
description: "Substitua o código de ciclo de vida feito à mão com WidgetsBindingObserver por AppLifecycleListener: o mapeamento dos callbacks, a máquina de estados que ele impõe, o novo estado hidden que quebra switches exaustivos, as solicitações de saída no desktop e o teste que de repente falha numa assertion. Testado no Flutter 3.44.8 com Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "app-lifecycle"
lang: "pt-br"
translationOf: "2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener"
translatedBy: "claude"
translationDate: 2026-10-23
---

Se o seu app Flutter ainda adiciona `WidgetsBindingObserver` como mixin a um `State` só para sobrescrever `didChangeAppLifecycleState`, o substituto é `AppLifecycleListener`, adicionado no Flutter 3.13.0. Você cria um objeto listener no `initState`, passa apenas os callbacks que lhe interessam (`onResume`, `onPause`, `onHide`, `onShow`, `onInactive`, `onRestart`, `onDetach`, `onStateChange`, `onExitRequested`) e chama `dispose()` nele. Sem mixin, sem o par `addObserver`/`removeObserver`, sem `switch` sobre `AppLifecycleState`. A migração de um observer leva cerca de 10 minutos e preserva o comportamento, desde que você saiba duas coisas: desde a 3.13 o framework insere os estados intermediários (`resumed` para `paused` agora chega como `inactive`, `hidden`, `paused`), e o novo valor `AppLifecycleState.hidden` transforma todo `switch` exaustivo sem `default` em erro de compilação. Tudo abaixo foi executado no Flutter 3.44.8 (Dart 3.12.2).

## Por que abandonar o observer puro

- **Menos código, menos vazamentos.** O padrão observer exige três peças coordenadas: o mixin, `WidgetsBinding.instance.addObserver(this)` no `initState` e `removeObserver(this)` no `dispose`. Esquecer a última mantém um `State` descartado vivo na lista de observers do binding e faz com que ele receba callbacks depois de desmontado. O `AppLifecycleListener` se registra no construtor e se remove no `dispose()`, então há uma única chamada para lembrar, a mesma que você já faz para os controllers.
- **Transições, não estados.** `didChangeAppLifecycleState` diz onde o app está. A maior parte da lógica do app se importa com como ele chegou lá: "o app voltou do segundo plano" é `paused` para `hidden` (`onRestart`), o que é diferente de "uma caixa de diálogo do sistema foi fechada" (`inactive` para `resumed`, `onResume`). O listener rastreia o estado anterior e chama o callback que nomeia a transição.
- **Solicitações de saída no desktop no mesmo objeto.** `onExitRequested` permite que um app Windows, macOS ou Linux cancele o fechamento para exibir um aviso de "alterações não salvas". Com o observer puro isso é uma sobrescrita separada, `didRequestAppExit`.
- **Pode viver fora da árvore de widgets.** O listener é um objeto Dart simples que só precisa de um `WidgetsBinding`. Um repositório, um serviço de analytics ou um provider do Riverpod pode ser dono de um e descartá-lo junto com o serviço.

## O que muda no app

| Área | Mudança | Gravidade |
| --- | --- | --- |
| Instruções `switch (state)` | `AppLifecycleState.hidden` (adicionado na 3.13) faz switches sem `default` falharem com `non_exhaustive_switch_statement` | alta |
| Testes de widget que chamam `handleAppLifecycleStateChanged` diretamente | Pular de `resumed` para `paused` agora falha uma assertion dentro do listener | alta |
| Classes `State` com observer | Mixin e `addObserver`/`removeObserver` removidos, substituídos por um campo e `dispose()` | média |
| Ordem dos callbacks | `onStateChange` dispara depois do callback da transição, uma vez por estado intermediário | baixa |
| Tratamento de saída | A sobrescrita de `didRequestAppExit` passa para `onExitRequested`; `AppExitResponse` vem de `dart:ui` | baixa |

## Checklist prévio

- Flutter 3.13.0 ou posterior (`flutter --version`). `AppLifecycleListener` não existe na 3.10 e anteriores, e o arquivo `packages/flutter/lib/src/widgets/app_lifecycle_listener.dart` aparece pela primeira vez na tag 3.13.0.
- Procure no código por `with WidgetsBindingObserver` e `didChangeAppLifecycleState`. Anote quais observers também sobrescrevem outros callbacks, como `didChangeMetrics`, `didChangePlatformBrightness`, `didChangeLocales` ou `didHaveMemoryPressure`. Esses mantêm o mixin para os callbacks que não são de ciclo de vida; só a parte do ciclo de vida se move.
- Procure por instruções `switch` e cadeias de `if` sobre `AppLifecycleState`. Cada uma exige uma decisão sobre `hidden`.
- Procure nos testes por `handleAppLifecycleStateChanged`. Esses são os testes que vão começar a falhar.
- Faça commit ou stash antes. Esta é uma migração apenas de código, sem dados envolvidos, então o `git revert` é o rollback.

## Passos da migração

1. **Mapeie cada `case` para um callback.** Os callbacks do listener têm nomes de transições, não de estados. Este é o mapeamento, extraído do código-fonte de `AppLifecycleListener.didChangeAppLifecycleState` no Flutter 3.44.8:

   | Novo estado | Estado anterior | Callback |
   | --- | --- | --- |
   | `resumed` | `inactive` (ou nenhum) | `onResume` |
   | `inactive` | `resumed` (ou nenhum) | `onInactive` |
   | `inactive` | `hidden` | `onShow` |
   | `hidden` | `inactive` (ou nenhum) | `onHide` |
   | `hidden` | `paused` | `onRestart` |
   | `paused` | `hidden` (ou nenhum) | `onPause` |
   | `detached` | `paused` (ou nenhum) | `onDetach` |
   | qualquer | qualquer | `onStateChange(state)`, depois do callback específico |

   Um `case AppLifecycleState.paused:` vira `onPause`, e `case AppLifecycleState.resumed:` vira `onResume`. Se o código antigo fazia algo em `inactive` independentemente da direção, use `onStateChange` e mantenha o `if`, porque `inactive` é alcançado por duas direções e corresponde a dois callbacks diferentes. Verifique: cada ramo do `switch` antigo tem exatamente um destino nas suas anotações.

2. **Substitua o mixin por um campo listener.** Este é o "antes" típico:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - BEFORE
   class PlayerScreen extends StatefulWidget {
     const PlayerScreen({super.key});
     @override
     State<PlayerScreen> createState() => _PlayerScreenState();
   }

   class _PlayerScreenState extends State<PlayerScreen>
       with WidgetsBindingObserver {
     @override
     void initState() {
       super.initState();
       WidgetsBinding.instance.addObserver(this);
     }

     @override
     void didChangeAppLifecycleState(AppLifecycleState state) {
       switch (state) {
         case AppLifecycleState.resumed:
           _player.resume();
         case AppLifecycleState.paused:
           _player.pause();
           _saveProgress();
         default:
           break;
       }
     }

     @override
     void dispose() {
       WidgetsBinding.instance.removeObserver(this);
       super.dispose();
     }

     // _player, _saveProgress and build() omitted
   }
   ```

   E o "depois":

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - AFTER
   class _PlayerScreenState extends State<PlayerScreen> {
     late final AppLifecycleListener _lifecycle;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onResume: () => _player.resume(),
         onPause: () {
           _player.pause();
           _saveProgress();
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     // _player, _saveProgress and build() unchanged
   }
   ```

   O construtor chama `binding.addObserver(this)` por conta própria, então criar o objeto já é a inscrição. Verifique: `flutter analyze` não reporta problemas de import não usado de `WidgetsBindingObserver` e a classe não tem mais uma cláusula `with` (a menos que ainda precise de outros callbacks de observer, veja o passo 4).

3. **Decida o que `hidden` significa para a sua lógica.** `AppLifecycleState.hidden` foi adicionado no Flutter 3.13 para desktop e web, onde um app pode ser minimizado ou ficar em uma aba em segundo plano sem estar "paused" no sentido mobile. No iOS e no Android o framework o sintetiza entre `inactive` e `paused`. Se você usava `onPause` para parar um vídeo, isso continua funcionando em todo lugar em que funcionava antes. Se você quer que o vídeo também pare quando uma janela de desktop é minimizada, `onHide` é o callback que dispara em todas as plataformas, com `onShow` como contraparte. Para qualquer coisa que só deva acontecer quando o usuário sai do app no celular (salvar um rascunho, descarregar dados de analytics), `onPause` mais `onRestart` é o par certo. Verifique: anote, por callback, para quais plataformas você publica e se ele dispara lá (`onRestart` e `onDetach` estão documentados como exclusivos de mobile).

4. **Mantenha o mixin apenas para callbacks que não são de ciclo de vida.** `AppLifecycleListener` cobre `didChangeAppLifecycleState` e `didRequestAppExit` e nada mais. Se um observer também sobrescreve `didChangeMetrics` para reagir aos insets do teclado, deixe o mixin no lugar para essa sobrescrita e mova apenas o método de ciclo de vida. Verifique: procure na classe, depois da edição, por métodos `@override` de `WidgetsBindingObserver`; se nenhum restar, remova o mixin e as chamadas `addObserver`/`removeObserver`.

5. **Mova `didRequestAppExit` para `onExitRequested`** (somente desktop). O callback retorna um `Future<AppExitResponse>`, e esse enum fica em `dart:ui`, não em `package:flutter/widgets.dart` nem em `services.dart`. Sem o import você recebe `Undefined name 'AppExitResponse'`.

   ```dart
   // Flutter 3.44.8, Dart 3.12.2
   import 'dart:ui' show AppExitResponse;
   import 'package:flutter/material.dart';

   class _EditorState extends State<Editor> {
     late final AppLifecycleListener _lifecycle;
     bool _dirty = false;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onExitRequested: () async {
           if (!_dirty) return AppExitResponse.exit;
           final discard = await showDialog<bool>(
             context: context,
             builder: (context) => AlertDialog(
               title: const Text('Discard unsaved changes?'),
               actions: [
                 TextButton(
                   onPressed: () => Navigator.pop(context, false),
                   child: const Text('Cancel'),
                 ),
                 TextButton(
                   onPressed: () => Navigator.pop(context, true),
                   child: const Text('Discard'),
                 ),
               ],
             ),
           );
           return discard == true ? AppExitResponse.exit : AppExitResponse.cancel;
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) => const Placeholder();
   }
   ```

   Apenas saídas canceláveis chegam a esse callback. `ServicesBinding.instance.exitApplication(AppExitType.required)` sai sem perguntar. Observe que `WidgetsBinding.handleRequestAppExit` consulta todos os observers, mesmo depois de um deles ter respondido `cancel`, e cancela a saída se qualquer um deles o fizer. Um único listener em qualquer parte do app pode vetar a saída, e o `onExitRequested` de todos os outros listeners ainda é executado, então não coloque ali limpezas irreversíveis. Verifique: execute no desktop, deixe o editor com alterações não salvas, feche a janela e confirme que a caixa de diálogo aparece e que "Cancel" mantém a janela aberta.

6. **Corrija os `switch` que o valor `hidden` quebrou.** Se você mantiver um `switch` (por exemplo dentro de `onStateChange`), ele precisa cobrir `hidden`. Este código compila no Flutter 3.10 e falha na 3.13+:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - fails flutter analyze
   String describe(AppLifecycleState state) {
     switch (state) {
       case AppLifecycleState.resumed:
         return 'resumed';
       case AppLifecycleState.inactive:
         return 'inactive';
       case AppLifecycleState.paused:
         return 'paused';
       case AppLifecycleState.detached:
         return 'detached';
     }
   }
   ```

   O analisador reporta: "The type 'AppLifecycleState' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'AppLifecycleState.hidden'" (`non_exhaustive_switch_statement`). Adicione um `case AppLifecycleState.hidden:` explícito em vez de um `default`, para que o próximo valor de enum adicionado pelo Flutter volte a ser um erro de compilação, em vez de uma passagem silenciosa. Verifique: `flutter analyze` está limpo.

7. **Atualize os testes que disparam mudanças de ciclo de vida.** Veja a próxima seção; é aqui que a maioria das migrações realmente trava. Verifique: `flutter test` passa.

## Verificação

A prova mais rápida de que o comportamento não mudou é um teste de widget que envia as mudanças de ciclo de vida do mesmo jeito que a engine faz: uma string no canal `flutter/lifecycle`. Esse caminho passa pelo gerador de transições do binding, exatamente como em um dispositivo real.

```dart
// Flutter 3.44.8, Dart 3.12.2 - test/lifecycle_test.dart
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> sendLifecycle(WidgetTester tester, AppLifecycleState state) async {
  final message = const StringCodec().encodeMessage(state.toString());
  await tester.binding.defaultBinaryMessenger
      .handlePlatformMessage('flutter/lifecycle', message, (_) {});
}

void main() {
  testWidgets('background and foreground', (tester) async {
    final log = <String>[];
    final listener = AppLifecycleListener(
      onResume: () => log.add('onResume'),
      onInactive: () => log.add('onInactive'),
      onHide: () => log.add('onHide'),
      onShow: () => log.add('onShow'),
      onPause: () => log.add('onPause'),
      onRestart: () => log.add('onRestart'),
      onStateChange: (s) => log.add('state:${s.name}'),
    );
    addTearDown(listener.dispose);

    await sendLifecycle(tester, AppLifecycleState.resumed);
    await sendLifecycle(tester, AppLifecycleState.paused);
    await sendLifecycle(tester, AppLifecycleState.resumed);

    expect(log, [
      'onResume', 'state:resumed',
      'onInactive', 'state:inactive',
      'onHide', 'state:hidden',
      'onPause', 'state:paused',
      'onRestart', 'state:hidden',
      'onShow', 'state:inactive',
      'onResume', 'state:resumed',
    ]);
  });
}
```

Este teste passa na 3.44.8 e documenta três fatos em um só lugar. Um salto de plataforma de `resumed` direto para `paused` chega em três passos. O caminho de volta executa `onRestart`, `onShow`, `onResume`, nessa ordem. E `onStateChange` vem sempre depois do callback nomeado para o mesmo passo. Enviar `resumed` duas vezes seguidas não produz nada na segunda vez, porque tanto o binding quanto o listener descartam estados repetidos.

Depois, as verificações manuais: no Android e no iOS, coloque o app em segundo plano e traga-o de volta, e confirme que o trabalho que você moveu para `onPause` e `onResume` continua acontecendo uma vez cada. No desktop, minimize e restaure se você moveu algo para `onHide`/`onShow`, e feche a janela se você implementou `onExitRequested`.

## Rollback

A migração é uma mudança puramente de código; nenhum estado persistido está envolvido. Faça `git revert` do commit e você volta para o observer. A única coisa que não será revertida de forma limpa é um `switch` que você corrigiu para `hidden`: mantenha essa correção, porque o código antigo já estava quebrado na 3.13+.

## Armadilhas de uma migração real

### Testes que chamam `handleAppLifecycleStateChanged` agora falham numa assertion

Muitas suítes de teste simulam o envio para segundo plano com `tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused)`. Esse método despacha o estado dado diretamente, sem os estados intermediários sintetizados. Um observer simples não se importa. O listener valida cada transição, então, com o app em `resumed`, este teste falha:

```dart
// Flutter 3.44.8, Dart 3.12.2 - fails
testWidgets('direct jump', (tester) async {
  final listener = AppLifecycleListener(onPause: () {});
  addTearDown(listener.dispose);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
});
```

A falha é uma assertion lançada durante o despacho para os observers: "Invalid state transition from AppLifecycleState.resumed to AppLifecycleState.paused", e `onPause` nunca é chamado. Ou você envia cada estado intermediário por conta própria (`inactive`, `hidden`, `paused`), ou usa o helper do canal `flutter/lifecycle` da seção Verificação, que deixa o framework gerá-los. A assertion só existe em builds de debug, então o comportamento em release não é afetado; o risco é puramente uma suíte de testes vermelha.

### O listener só vê mudanças depois de criado

O construtor tira um snapshot de `binding.lifecycleState` e o trata como o estado anterior. Se você criar o listener em uma tela empurrada muito depois da inicialização, nenhum `onResume` dispara para o estado atual, porque não houve transição. O observer antigo tinha o mesmo comportamento, mas às vezes o código dependia de uma chamada no `initState` para "executar a lógica de retomada uma vez". Mantenha isso explícito: leia `WidgetsBinding.instance.lifecycleState` no `initState` se precisar do estado atual, como antes.

### Observers antigos também veem os estados sintetizados

A geração de estados intermediários fica em `ServicesBinding`, não no listener. No teste acima, um `WidgetsBindingObserver` simples registrado junto com o listener também recebeu `inactive`, `hidden`, `paused` para uma única mensagem `paused` da plataforma. Então, se um observer que você ainda não migrou faz "em qualquer coisa diferente de `resumed`, pause a reprodução", ele agora executa esse código três vezes a cada ida para segundo plano. Torne esses handlers idempotentes ou migre-os para um único callback nomeado.

### Criar um listener antes de `runApp`

`AppLifecycleListener()` usa `WidgetsBinding.instance` como `binding` padrão, o que lança uma exceção se o binding ainda não foi inicializado. Um listener pertencente a um serviço construído no `main()` antes de `runApp` precisa de `WidgetsFlutterBinding.ensureInitialized()` primeiro. Para serviços que vivem mais que qualquer widget, garanta também que algo chame `dispose()`; com Riverpod, isso é `ref.onDispose(listener.dispose)` no provider que o cria.

### `onExitRequested` não é um hook do botão voltar no mobile

É tentador tratar `onExitRequested` como "o app está prestes a fechar" no Android. Não é: no código-fonte da engine, apenas os embedders de Windows, macOS e Linux enviam solicitações de saída, então ele nunca dispara no Android nem no iOS. Para interceptar o gesto de voltar do Android, use `PopScope`. Para executar uma limpeza quando um app mobile desaparece, use `onPause`; `onDetach` não tem garantia de rodar antes de o SO matar um processo em segundo plano.

## Relacionados

- O `dispose()` do listener fica junto do restante da sua rotina de encerramento; veja [como descartar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- Pausar um stream quando o app vai para segundo plano é um trabalho comum do `onPause`, e [cancelar uma StreamSubscription no dispose](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) cobre a outra metade.
- `onPause` não é sua última chance no Android: o SO pode matar o processo depois. [Restaurar o estado da UI após a morte do processo no Android com RestorationMixin](/pt-br/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) cuida do que volta.
- Se você está limpando várias APIs obsoletas de uma vez, [executar dart fix em um repositório inteiro](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) automatiza as mecânicas (esta migração não é uma delas).
- `onExitRequested` importa mais em apps desktop com várias janelas; veja [como habilitar suporte a várias janelas em um app Flutter desktop](/pt-br/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

## Fontes

- [Classe `AppLifecycleListener`](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html) (api.flutter.dev)
- [Enum `AppLifecycleState` e diagrama de estados](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html) (api.flutter.dev)
- [Classe `WidgetsBindingObserver`](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html) (api.flutter.dev)
- [`ServicesBinding.exitApplication`](https://api.flutter.dev/flutter/services/ServicesBinding/exitApplication.html) (api.flutter.dev)
- [Código-fonte de `app_lifecycle_listener.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/app_lifecycle_listener.dart) e [geração de transições em `ServicesBinding`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/services/binding.dart) (flutter/flutter)
- [Breaking change: novo valor de enum `AppLifecycleState.hidden`](https://docs.flutter.dev/release/breaking-changes/add-applifecyclestate-hidden) (docs.flutter.dev)
