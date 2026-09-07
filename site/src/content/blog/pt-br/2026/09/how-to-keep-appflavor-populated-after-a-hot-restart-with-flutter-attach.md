---
title: "Como manter appFlavor preenchido após um hot restart ao usar flutter attach"
description: "flutter attach não tem a opção --flavor, então o compilador residente que ele inicia nunca define FLUTTER_APP_FLAVOR e a constante appFlavor vira null no primeiro hot restart. Três soluções: default-flavor no pubspec.yaml, flutter run --use-application-binary e um canal de plataforma que lê o flavor nativamente. Verificado no Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-07
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "flavors"
  - "tooling"
lang: "pt-br"
translationOf: "2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach"
translatedBy: "claude"
translationDate: 2026-09-07
---

`appFlavor` é uma constante de tempo de compilação, não uma consulta em runtime, e `flutter attach` não tem a opção `--flavor`. Então, quando você anexa a um app compilado e iniciado fora do `flutter run`, o compilador frontend que a ferramenta inicia sobe sem `-DFLUTTER_APP_FLAVOR=...`, e o primeiro hot restart substitui seu `dev` correto por `null`. A solução mais rápida é `default-flavor` no `pubspec.yaml`, que o `FlutterCommand.getBuildInfo()` lê para todo comando, inclusive `attach`. Se o flavor precisa variar por invocação, use `flutter run --use-application-binary=<path> --flavor dev` em vez de anexar, ou pare de ler `appFlavor` e obtenha o flavor pela plataforma. Tudo abaixo foi verificado no Flutter 3.47.2 com Dart 3.13.2 no canal stable.

## appFlavor são onze linhas de const, e essa é a história inteira

As pessoas presumem que `appFlavor` pergunta algo ao engine. Não pergunta. Esta é a declaração inteira, em `packages/flutter/lib/src/services/flavor.dart` no branch stable:

```dart
// Flutter 3.47.2, packages/flutter/lib/src/services/flavor.dart
/// The flavor this app was built with.
///
/// This is equivalent to the value argued to the `--flavor` option at build time.
/// This will be `null` if the `--flavor` option was not provided.
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

`String.fromEnvironment` é resolvido pelo CFE quando ele compila o kernel, a partir das flags `-D` entregues ao processo do compilador. Não tem nada a ver com `Platform.environment`, nada a ver com a VM em execução e nada a ver com o APK que você instalou. O valor que o compilador tinha no momento em que produziu o kernel fica gravado.

Isso importa porque uma sessão de depuração no Flutter tem dois compiladores na vida. O primeiro roda quando você compila o app: `flutter build apk --flavor dev --debug` resolve `--flavor` em `FlutterCommand.getBuildInfo()` e acrescenta `FLUTTER_APP_FLAVOR=dev` aos dart defines, que terminam como `-DFLUTTER_APP_FLAVOR=dev` na linha de comando do frontend server. O segundo roda por todo o resto da sessão: o compilador residente que `flutter run` ou `flutter attach` mantém vivo para atender hot reload e hot restart. Em `packages/flutter_tools/lib/src/compile.dart` os defines são despejados nesse processo exatamente uma vez, quando ele inicia:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/compile.dart (abridged)
final List<String> command = <String>[
  engineDartPath,
  ...
  '--sdk-root', sdkRoot,
  '--target=$targetModel',
  '--no-print-incremental-dependencies',
  for (final Object dartDefine in dartDefines) '-D$dartDefine',
  ...buildModeOptions(buildMode, dartDefines),
  if (trackWidgetCreation) '--track-creation-locations',
  ...
];
```

Não existe canal para mudar `dartDefines` depois disso. Cada hot reload e cada hot restart pelo resto da sessão são atendidos por esse único processo com esse único conjunto de defines. Se `FLUTTER_APP_FLAVOR` não estava na linha de comando quando ele subiu, nenhum restart vai trazê-lo de volta.

## O que o attach registra, e o que não registra

O construtor de `AttachCommand` é uma lista de chamadas `uses*`. Esta é a parte relevante, literal do stable:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/commands/attach.dart
addBuildModeFlags(verboseHelp: verboseHelp, defaultToRelease: false, excludeRelease: true);
usesTargetOption();
usesPortOptions(verboseHelp: verboseHelp);
usesIpv6Flag(verboseHelp: verboseHelp);
usesFilesystemOptions(hide: !verboseHelp);
usesFuchsiaOptions(hide: !verboseHelp);
usesDartDefineOption();
usesDeviceUserOption();
```

`usesFlavorOption()` está ausente. `RunCommand` a chama na linha 40 de `run.dart`; `AttachCommand` nunca chama. E `getBuildInfo()`, que o `attach` chama, resolve o flavor assim:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
final String? defaultFlavor = project.manifest.defaultFlavor;
final String? cliFlavor = getValue(BuildInfoOptions.flavor);
final String? flavor = cliFlavor ?? defaultFlavor;

_ensureReservedDartDefineIsUnset(kAppFlavor, dartDefines);
if (flavor != null) {
  dartDefines.add('$kAppFlavor=$flavor');
}
```

Sem a opção `--flavor` registrada, `cliFlavor` é `null`. Se `defaultFlavor` também for null, `flavor` é null, o `if` nunca roda, e o compilador residente sobe sem o define. O app no dispositivo é um build `dev`; o compilador que o atende acha que flavors não existem.

## A reprodução, em quatro passos

Este é o [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), aberto em 2026-09-03 e confirmado pela triagem contra o 3.47.2 stable. Reproduz tanto em `platform-android` quanto em `platform-ios`.

1. Dê product flavors a um app e leia a constante em algum lugar visível:

   ```dart
   // Flutter 3.47.2 / Dart 3.13.2
   import 'package:flutter/material.dart';
   import 'package:flutter/services.dart';

   void main() => runApp(const FlavorApp());

   class FlavorApp extends StatelessWidget {
     const FlavorApp({super.key});

     @override
     Widget build(BuildContext context) {
       return MaterialApp(
         home: Scaffold(
           body: Center(
             child: Text('appFlavor = $appFlavor',
                 style: const TextStyle(fontSize: 28)),
           ),
         ),
       );
     }
   }
   ```

2. Compile e inicie com o flavor, mas fora do `flutter run`:

   ```bash
   flutter build apk --flavor dev --debug
   adb install -r build/app/outputs/flutter-apk/app-dev-debug.apk
   adb shell monkey -p com.example.flavors.dev 1
   ```

3. Anexe: `flutter attach --debug`. A tela ainda mostra `appFlavor = dev`, porque nada foi recompilado ainda.

4. Pressione `R` para um hot restart. A tela agora mostra `appFlavor = null`.

O passo 3 é o que torna o diagnóstico confuso. O valor fica correto até o primeiro restart, então o bug parece pertencer ao código que você acabou de editar, e não à ferramenta.

## Solução 1: default-flavor no pubspec.yaml

`default-flavor` foi adicionado ao esquema do pubspec no [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968), e o [#169298](https://github.com/flutter/flutter/pull/169298) moveu sua resolução para `FlutterCommand.getBuildInfo()`, de modo que vale para todo comando que constrói um `BuildInfo`, não só `run` e `build`. `attach` é um desses comandos. É por isso que isto funciona.

1. Adicione o campo sob a chave `flutter:` no `pubspec.yaml`:

   ```yaml
   # pubspec.yaml, Flutter 3.47.2
   name: flavors_example
   environment:
     sdk: ^3.13.0

   flutter:
     uses-material-design: true
     default-flavor: dev
   ```

2. Reinicie a sessão de attach. `flutter attach --debug` agora resolve `flavor` como `dev` pelo manifesto, acrescenta `FLUTTER_APP_FLAVOR=dev` aos defines, e o hot restart continua devolvendo `dev`.

3. Continue usando `--flavor` explicitamente onde a opção existe. O próprio texto de ajuda de `usesFlavorOption()` diz que "Overrides the value of the `default-flavor` entry in the flutter pubspec", então `flutter run --flavor staging` ainda vence `default-flavor: dev`.

A limitação é exatamente a que você esperaria de um valor guardado em um arquivo versionado: é um flavor, para todo mundo, em todo attach. Se o seu CI anexa a um build `staging` numa máquina e a um `dev` em outra, `default-flavor` não consegue acompanhar. Existe uma proposta aberta, [#191376](https://github.com/flutter/flutter/pull/191376), para permitir valores de `default-flavor` por plataforma, mas isso também não torna o valor específico por invocação.

## Por que --dart-define=FLUTTER_APP_FLAVOR é recusado

A solução óbvia é definir o define na mão, e o `attach` registra `usesDartDefineOption()`, então a flag é parseada. Ainda assim falha:

```bash
flutter attach --debug --dart-define=FLUTTER_APP_FLAVOR=dev
# FLUTTER_APP_FLAVOR is used by the framework and cannot be set using
# --dart-define or --dart-define-from-file
```

Essa proteção é deliberada, e cobre também o ambiente do processo:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
void _ensureReservedDartDefineIsUnset(String define, List<String> dartDefines) {
  if (_platform.environment[define] != null) {
    throwToolExit('$define is used by the framework and cannot be set in the environment.');
  }
  if (dartDefines.any((String d) => d == define || d.startsWith('$define='))) {
    throwToolExit(
      '$define is used by the framework and cannot be '
      'set using --${FlutterOptions.kDartDefinesOption} or --${FlutterOptions.kDartDefineFromFileOption}',
    );
  }
}
```

`FLUTTER_APP_FLAVOR` acompanha `FLUTTER_BUILD_NAME`, `FLUTTER_BUILD_NUMBER` e `FLUTTER_ENABLED_FEATURE_FLAGS` nessa lista reservada. Definir a variável no seu shell antes de rodar a ferramenta também não escapa: o primeiro ramo checa `_platform.environment` e sai com uma mensagem diferente. Se você fazia isso em builds web, é o [#172165](https://github.com/flutter/flutter/issues/172165), fechado como inválido: o comportamento anterior ao 3.32 é que era o acidente, não a recusa atual.

## Solução 2: rode o binário pronto em vez de anexar

A maioria recorre ao `flutter attach` porque o app foi compilado por outra coisa que não `flutter run`: uma tarefa do Gradle, um esquema do Xcode, um harness de instrumentação. Se tudo o que você precisa é "instale este artefato e me dê um ciclo de hot restart", o `flutter run` faz isso direto e, ao contrário do `attach`, aceita `--flavor`:

```bash
# Flutter 3.47.2. run registers both --use-application-binary and --flavor.
flutter run \
  --use-application-binary=build/app/outputs/flutter-apk/app-dev-debug.apk \
  --flavor dev
```

`RunCommand` chama `usesFlavorOption()` e lê `--use-application-binary` em `prebuiltApplicationBinaryPath`, então você ganha um `HotRunner` de verdade sobre um binário que você mesmo compilou, com `FLUTTER_APP_FLAVOR=dev` no compilador residente. No iOS, aponte para o bundle `.app` produzido por `flutter build ios --flavor dev --debug` ou pelo seu esquema do Xcode. Esta é a coisa mais próxima de uma correção correta sem mexer no seu código Dart, e é a primeira que eu escolho em CI.

Não ajuda se você realmente não controla a inicialização, por exemplo quando um app nativo hospedeiro embute o Flutter como módulo e inicia o engine por conta própria. É para isso que serve a solução 3.

## Solução 3: leia o flavor pela plataforma, não pelo kernel

Se o flavor precisa sobreviver a um attach arbitrário, pare de pedir a uma constante de tempo de compilação um valor que o compilador não conhece. O flavor já está presente nativamente, em `BuildConfig.FLAVOR` no Android e no build setting que dirige o seu esquema do Xcode, e um canal de plataforma o lê depois que o isolate reinicia, em vez de antes de compilar. A técnica é a mesma coberta em [adicionar código específico de plataforma sem escrever um plugin](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

Android primeiro. O AGP 8.0 parou de gerar `BuildConfig` a menos que você peça, e o template de app do Flutter não pede, então habilite:

```kotlin
// android/app/build.gradle.kts, AGP 8.13, Flutter 3.47.2
android {
    namespace = "com.example.flavors"

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
    }
}
```

Depois responda a uma chamada do canal na `MainActivity`:

```kotlin
// android/app/src/main/kotlin/com/example/flavors/MainActivity.kt
package com.example.flavors

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.example.flavors/flavor",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "getFlavor" -> result.success(BuildConfig.FLAVOR)
                else -> result.notImplemented()
            }
        }
    }
}
```

No iOS, adicione um build setting definido pelo usuário por xcconfig (`APP_FLAVOR = dev` em `Debug-dev.xcconfig`), exponha no `Info.plist` como uma string `FLUTTER_APP_FLAVOR` com valor `$(APP_FLAVOR)`, e leia do bundle:

```swift
// ios/Runner/AppDelegate.swift, Xcode 26.4, Flutter 3.47.2
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.example.flavors/flavor",
      binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "getFlavor" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(Bundle.main.object(forInfoDictionaryKey: "FLUTTER_APP_FLAVOR") as? String)
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

E do lado Dart, resolva uma vez e caia de volta para `appFlavor` nas plataformas sem handler nativo:

```dart
// Flutter 3.47.2 / Dart 3.13.2
import 'package:flutter/services.dart';

const _channel = MethodChannel('com.example.flavors/flavor');

/// Survives hot restart under `flutter attach`, because it is a call, not a const.
Future<String?> resolveFlavor() async {
  try {
    return await _channel.invokeMethod<String>('getFlavor') ?? appFlavor;
  } on MissingPluginException {
    return appFlavor; // desktop, web, unit tests
  }
}
```

O custo é que `resolveFlavor()` é assíncrono e `appFlavor` não é, então tudo que ramificava pelo flavor de forma síncrona no `main()` agora precisa aguardá-lo antes do `runApp`, ou lê-lo de um provider. Isso é uma refatoração de verdade, e por isso eu só a faria quando as soluções 1 e 2 estivessem indisponíveis.

## Coisas que parecem este bug mas não são

**O hotfix do 3.32.1.** Se você pesquisar esse sintoma vai cair no [#165803](https://github.com/flutter/flutter/issues/165803) e no [#169160](https://github.com/flutter/flutter/issues/169160), onde `appFlavor` virava null após um hot restart no `flutter run --flavor` puro e durante `flutter test --flavor`. Aquilo tinha outra causa: o `KernelSnapshot` em `build_system/targets/common.dart` pulava a adição do flavor quando já havia um define presente vindo da etapa de xcodebuild do build. O [PR #169602](https://github.com/flutter/flutter/pull/169602) mudou isso para remover qualquer entrada existente e readicionar a sua por último, e a entrada do changelog saiu no **Flutter 3.32.1**. Se você está no 3.32.1 ou mais novo e ainda vê null no `flutter run`, esse é um bug novo, não este.

**Hot reload, não só hot restart.** O conjunto de defines é fixado quando o compilador residente sobe, então governa toda compilação incremental, não apenas restarts completos. Um hot reload que recompila uma biblioteca que lê `appFlavor` pode reavaliar a constante como null naquela biblioteca enquanto outras mantêm o valor antigo. Não assuma que `r` é seguro só porque `R` não é.

**Flavors que só existem no Gradle.** `appFlavor` reporta o valor passado a `--flavor`, que precisa bater com um nome de product flavor. Se você renomeou um flavor no `build.gradle.kts` mas continuou compilando com o nome antigo, o build falha antes que isso importe. Configurar as próprias dimensões de flavor está fora do escopo aqui; se o que está falhando é `assembleDevDebug`, isso está mais perto do [checklist do assembleDebug com código de saída 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**Ações "Attach" da IDE.** O IntelliJ bateu no mesmo muro pelo outro lado no flutter-intellij#5237, onde a ação Attach passava `--flavor` e morria com `Could not find an option named 'flavor'`. A correção da IDE foi remover a flag, e é por isso que anexar pelo Android Studio ou pelo VS Code mostra esse comportamento também. `default-flavor` é hoje a única coisa que corrige o caminho da IDE, já que você não controla a linha de comando dela.

A proposta upstream no #192261 tem uma linha: chamar `usesFlavorOption()` no construtor do `AttachCommand`. `getBuildInfo()` já transforma a opção no define, então nada mais precisa de encanamento. Até isso chegar, trate `appFlavor` sob `attach` como "correto exatamente uma vez", e escolha qual das três soluções acima combina com o quanto você controla da inicialização.

## Relacionado

- [Como adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) percorre a configuração de `MethodChannel` da qual a solução 3 depende.
- [Fix: tarefa do Gradle assembleDebug falhou com código de saída 1 em um build Android do Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) cobre as configurações erradas de flavor e NDK que quebram o build antes mesmo de `appFlavor` entrar em cena.
- [Como mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) vale a leitura junto com a solução 2, porque `--use-application-binary` é sobretudo uma jogada de CI.
- [Depurando Flutter iOS a partir do Windows: um fluxo real com dispositivo](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) é o outro lugar onde `flutter attach` ganha o salário, e a mesma distinção entre constante e runtime se aplica lá.
- [Fix: login do Firebase Auth não persiste em um build release Android do Flutter](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) é um bom companheiro se seus flavors também significam projetos diferentes no Firebase.

## Fontes

- [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), o issue aberto que acompanha a falta de `--flavor` no `attach`, com confirmação da triagem no 3.47.2.
- [A constante `appFlavor`](https://api.flutter.dev/flutter/services/appFlavor-constant.html) na documentação da API do Flutter, e seu código-fonte em `packages/flutter/lib/src/services/flavor.dart`.
- [Opções do pubspec do Flutter](https://docs.flutter.dev/tools/pubspec) para o campo `default-flavor`, e [Configurar flavors do Flutter para Android](https://docs.flutter.dev/deployment/flavors) para a configuração de flavors em si.
- [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) adicionou `default-flavor`; [#169298](https://github.com/flutter/flutter/pull/169298) e seu roll-forward [#169602](https://github.com/flutter/flutter/pull/169602) moveram a resolução do flavor para `getBuildInfo()`.
- [O CHANGELOG do Flutter](https://github.com/flutter/flutter/blob/main/CHANGELOG.md) para a entrada do hotfix 3.32.1 que cobre `appFlavor` no `flutter test` e no hot restart.
- [As notas de versão 8.0 do Android Gradle Plugin](https://developer.android.com/build/releases/past-releases/agp-8-0-0-release-notes) para a mudança do padrão de `buildFeatures.buildConfig` que a solução 3 precisa contornar.
