---
title: "O que é um flavor do Flutter e como ele difere de um build mode?"
description: "Um build mode (debug, profile, release) decide como o Flutter compila seu código Dart. Um flavor (dev, staging, prod) é uma variante de build nativa que você define no Gradle e no Xcode e que decide qual app você entrega. São eixos independentes: 2 flavors vezes 3 modos dão 6 builds. Verificado no Flutter 3.44.8 com AGP 9.0.1, código-fonte conferido na 3.47.7."
pubDate: 2026-10-10
tags:
  - "flutter"
  - "dart"
  - "flavors"
  - "android"
  - "ios"
  - "tooling"
lang: "pt-br"
translationOf: "2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode"
translatedBy: "claude"
translationDate: 2026-10-10
---

Resposta curta: um **build mode** é a forma como o Flutter compila e executa seu código Dart. Existem exatamente três, `debug`, `profile` e `release`, todos embutidos no engine e na ferramenta, e seu código os enxerga por meio de `kDebugMode`, `kProfileMode` e `kReleaseMode`. Um **flavor** é algo que o Flutter não controla de forma alguma: é uma variante de build nativa que você mesmo define, como `productFlavors` do Android no Gradle e como schemes mais build configurations do Xcode no iOS e no macOS, e ele decide *qual app* você está compilando (application ID, nome de exibição, ícones, projeto do Firebase, URL base da API). O Flutter apenas repassa `--flavor dev` para o build nativo e expõe o nome ao Dart como a constante `appFlavor`. Os dois são ortogonais, então um projeto com os flavors `dev` e `prod` tem seis variantes, de `devDebug` a `prodRelease`. Tudo abaixo foi compilado e conferido no Flutter 3.44.8 (Dart 3.12.2, Android Gradle Plugin 9.0.1, Gradle 9.1.0), e o código-fonte relevante do `flutter_tools` foi comparado com o stable atual, o Flutter 3.47.7.

## Dois eixos, uma matriz de builds

A confusão geralmente começa porque as duas coisas são passadas na mesma linha de comando e as duas acabam no nome do arquivo de saída:

```bash
# Flutter 3.44.8 / 3.47.7
flutter build apk --release --flavor prod
# -> Running Gradle task 'assembleProdRelease'...
# -> build/app/outputs/flutter-apk/app-prod-release.apk
```

`--release` escolhe o modo. `--flavor prod` escolhe o flavor. O Gradle os combina em um único nome de variante, `prodRelease`, e executa `assembleProdRelease`. Esta é a matriz completa para um projeto com dois flavors:

| | `--debug` | `--profile` | `--release` |
|---|---|---|---|
| `--flavor dev` | `app-dev-debug.apk` | `app-dev-profile.apk` | `app-dev-release.apk` |
| `--flavor prod` | `app-prod-debug.apk` | `app-prod-profile.apk` | `app-prod-release.apk` |

As colunas são decididas pelo Flutter e respondem a "como o código Dart é compilado, e posso fazer hot reload nele?" As linhas são decididas pelo seu `build.gradle.kts` e pelo projeto Xcode e respondem a "este é o app que conversa com o backend de staging e se chama `Demo Dev` na tela inicial?" Nada em um eixo implica nada no outro. Um build debug de `prod` é perfeitamente normal: é o que você executa quando precisa reproduzir um bug que só acontece em produção, com breakpoints.

## O que um build mode realmente muda

Os build modes dizem respeito ao pipeline de compilação do Dart, e são fixados pelo Flutter:

- **Debug** compila para um arquivo kernel e o executa no JIT da Dart VM. Os asserts ficam ativos, as service extensions ficam ativas, hot reload e hot restart funcionam, e o desempenho não é representativo.
- **Profile** compila antecipadamente (AOT) para código de máquina nativo, como o release, mas mantém vivo o suficiente do service protocol para o rastreamento do DevTools. Não roda em emuladores nem em simuladores.
- **Release** compila antecipadamente, remove asserts e informações de depuração, e é o que você entrega.

Dá para ver a diferença listando os APKs. O APK debug carrega o programa Dart como `kernel_blob.bin` para o JIT, enquanto os APKs profile e release carregam um `libapp.so` pré-compilado:

```text
# Flutter 3.44.8, flutter build apk --target-platform android-arm64 --flavor dev|prod
app-dev-debug.apk     26146208  assets/flutter_assets/kernel_blob.bin
app-dev-profile.apk    2753424  lib/arm64-v8a/libapp.so
app-prod-release.apk   1508240  lib/arm64-v8a/libapp.so
```

Seu código Dart descobre o modo por meio de três constantes em `package:flutter/foundation.dart`. São constantes de tempo de compilação derivadas de flags que a ferramenta passa ao compilador Dart, e é por isso que o compilador consegue remover por tree-shaking um bloco `if (kDebugMode) { ... }` inteiro de um build release:

```dart
// Flutter 3.44.8, packages/flutter/lib/src/foundation/constants.dart (abridged)
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

Você não pode adicionar um quarto modo. Um modo "staging" não existe no Flutter; staging é um flavor.

## O que um flavor realmente é

Um flavor é uma variante do app nativo. O Flutter não tem um formato de configuração de flavor próprio. Quando você passa `--flavor dev`, a ferramenta faz três coisas:

1. No Android, executa a tarefa do Gradle `assemble<Flavor><Mode>`, por exemplo `assembleDevDebug`. Se o seu arquivo Gradle não declara nenhum product flavor chamado `dev`, o build falha.
2. No iOS e no macOS, compila o scheme do Xcode com o nome do flavor (com a primeira letra maiúscula, então `dev` procura `Dev` primeiro e depois uma correspondência sem diferenciar maiúsculas de minúsculas) usando a build configuration `<Mode>-<scheme>`, por exemplo `Debug-dev` ou `Release-prod`.
3. Em todas as plataformas, adiciona `FLUTTER_APP_FLAVOR=dev` aos Dart defines, o que aparece no Dart como `appFlavor`.

Tudo o que um flavor muda no binário final vem do lado nativo: o sufixo do application ID, a string do nome do app, `google-services.json` ou `GoogleService-Info.plist`, os ícones de launcher, a configuração de assinatura. O Flutter apenas encaminha o nome.

## Definindo flavors no Android com o AGP 9

Este é o lado Android do app de demonstração. É o template padrão do `flutter create` para o Flutter 3.44.8 com uma flavor dimension adicionada:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.44.8, Android Gradle Plugin 9.0.1, Gradle 9.1.0
android {
    namespace = "com.example.flavordemo"
    compileSdk = flutter.compileSdkVersion

    defaultConfig {
        applicationId = "com.example.flavordemo"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // AGP 9 turns resValue off by default. Without this block the
    // productFlavors below fail with:
    // "Product Flavor dev contains custom resource values, but the feature is disabled."
    buildFeatures {
        resValues = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "Demo Dev")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Demo")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
```

O bloco `buildFeatures` é a parte que a maioria dos tutoriais mais antigos deixa de fora. Os guias de flavors escritos antes do AGP 9 usam `resValue` para o nome do app, e em um projeto novo do Flutter 3.44 essa configuração agora falha na fase de configuração do Gradle com o erro do comentário acima. Depois, aponte o manifest para a string para que cada flavor tenha seu próprio rótulo de launcher:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application
    android:label="@string/app_name"
    android:name="${applicationName}"
    android:icon="@mipmap/ic_launcher">
```

`aapt2 dump badging` nos APKs resultantes confirma que os dois eixos realmente são independentes. O modo não mudou nada na identidade, e o flavor não mudou nada na compilação:

```text
app-dev-debug.apk     package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-profile.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-release.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-prod-release.apk  package: com.example.flavordemo      versionName 0.1.0      label 'Demo'
```

Como as variantes `dev` têm um application ID diferente, elas são instaladas lado a lado com a de produção no mesmo celular. Só isso já é o motivo pelo qual a maioria das equipes adota flavors.

## Os erros que dizem qual eixo está errado

Quando um arquivo Gradle declara product flavors, um simples `flutter build apk` deixa de funcionar:

```text
# Flutter 3.44.8, no --flavor, productFlavors declared
Running Gradle task 'assembleDebug'...                             14.5s
Gradle build failed to produce an .apk file. It's likely that this file was generated
under .../flavordemo/build, but the tool couldn't find it.
```

A mensagem engana. O `assembleDebug` teve sucesso e compilou *todos* os flavors (tanto `app-dev-debug.apk` quanto `app-prod-debug.apk` estavam em disco depois), mas a ferramenta procura `app-debug.apk`, que não existe mais. Passe `--flavor` ou defina um padrão (veja abaixo).

O erro oposto, passar `--flavor` para um projeto que não tem product flavors, recebe uma mensagem bem mais clara:

```text
# Flutter 3.44.8, --flavor dev, no productFlavors
[!]  Gradle project does not define a task suitable for the requested build.
The .../android/app/build.gradle.kts file does not define any custom product flavors.
You cannot use the --flavor option.
```

No iOS a ferramenta valida o flavor contra os schemes do Xcode. Executar `flutter build ios --config-only --no-codesign --flavor dev` no mesmo projeto, que ainda não tem um scheme `dev`, exibiu:

```text
The Xcode project defines schemes: FlutterFramework, FlutterGeneratedPluginSwiftPackage, Runner
You must specify a --flavor option to select one of the available schemes.
```

## Prova de que os dois acabam como constantes no binário

`appFlavor` é declarado em `package:flutter/services.dart` e, no Flutter 3.47.7, continua sendo uma simples consulta `String.fromEnvironment`:

```dart
// Flutter 3.47.7, packages/flutter/lib/src/services/flavor.dart
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

Então o flavor chega ao Dart da mesma forma que o modo: como uma constante de tempo de compilação. Para provar isso, o `main.dart` da demonstração registra ambos:

```dart
// Flutter 3.44.8, lib/main.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('FLAVORPROBE appFlavor=$appFlavor kDebugMode=$kDebugMode '
      'kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  runApp(const SizedBox());
}
```

Depois, `strings` no snapshot AOT dentro de cada APK mostra que o compilador dobrou toda a interpolação em um único literal. Não sobrou nenhuma consulta em tempo de execução para inspecionar:

```text
# strings lib/arm64-v8a/libapp.so | grep FLAVORPROBE
app-dev-release.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=false kReleaseMode=true
app-prod-release.apk:  FLAVORPROBE appFlavor=prod kDebugMode=false kProfileMode=false kReleaseMode=true
app-dev-profile.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=true kReleaseMode=false
```

Isso tem duas consequências práticas. Você não pode trocar de flavor em tempo de execução, porque o binário contém apenas uma resposta. E qualquer coisa que recompile o Dart sem os defines corretos, como um hot restart a partir de `flutter attach`, obtém `appFlavor == null`, que é o problema tratado em [como manter o appFlavor preenchido após um hot restart](/pt-br/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).

A ferramenta também protege o nome. Tentar simular um flavor com um define falha antes de o build começar:

```text
# flutter build apk --dart-define=FLUTTER_APP_FLAVOR=qa
FLUTTER_APP_FLAVOR is used by the framework and cannot be set using --dart-define or --dart-define-from-file
```

## iOS e macOS: schemes mais build configurations

Nas plataformas Apple, um flavor é composto por duas coisas que precisam concordar: um scheme com o nome do flavor e um conjunto de build configurations chamadas `Debug-<flavor>`, `Profile-<flavor>` e `Release-<flavor>`. A matriz modo vezes flavor está literalmente escrita nos nomes das configurations. No Xcode, duplique `Debug`, `Profile` e `Release` para cada flavor, crie um scheme `dev` e defina a ação Run como `Debug-dev`, Profile como `Profile-dev` e Archive como `Release-dev`. Cada configuration pode então definir seu próprio `PRODUCT_BUNDLE_IDENTIFIER` e nome de exibição.

Um comportamento que vale conhecer no Flutter 3.47.7: `XcodeProjectInfo.buildConfigurationFor` procura primeiro uma correspondência exata `Debug-dev`, depois uma única configuration cujo nome contenha tanto o modo quanto o scheme (sem diferenciar maiúsculas de minúsculas) e, se nenhuma existir, **recorre à configuration `Debug` simples**. Assim, um erro de digitação como `Debug-dve` não faz o build falhar; ele compila silenciosamente com a sua configuration base e com o bundle identifier que ela carregar, em geral o de produção. Se um build iOS com flavor parece ser o de prod, confira os nomes das configurations antes de qualquer outra coisa.

`flutter run`, `flutter build ios`, `flutter build ipa` e `flutter build macos` aceitam `--flavor`. `flutter build web`, `flutter build windows` e `flutter build linux` não têm a opção na 3.44.8, porque não existe um sistema de variantes nativo para o Flutter encaminhar o valor.

## Assets específicos de flavor e um flavor padrão

Dois recursos do pubspec deixam os flavors menos dolorosos. Os assets podem ser limitados a flavors específicos, o que mantém fixtures de dev e configs de debug fora do bundle de produção:

```yaml
# pubspec.yaml, Flutter 3.44.8
flutter:
  default-flavor: dev
  assets:
    - path: assets/dev/
      flavors:
        - dev
```

Na demonstração, `assets/flutter_assets/assets/dev/config.json` estava presente em `app-dev-debug.apk` e `app-dev-profile.apk` e ausente de `app-prod-debug.apk` e `app-prod-release.apk`. Lembre-se de que qualquer `rootBundle.loadString('assets/dev/config.json')` em código compartilhado agora vai lançar uma exceção em `prod`, a mesma falha "Unable to load asset" descrita em [o post de solução de problemas de assets do pubspec](/pt-br/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

`default-flavor` é o que a ferramenta usa quando `--flavor` é omitido. Em `FlutterCommand.getBuildInfo()` a lógica é uma linha só, `cliFlavor ?? defaultFlavor`, inalterada na 3.47.7. Com ele definido, um simples `flutter build apk --release` na demonstração produziu `app-dev-release.apk` em vez de falhar. É prático para `flutter run` durante o desenvolvimento, mas pense duas vezes antes de commitar `default-flavor: prod`: um job de CI que esquece o `--flavor` passa a entregar silenciosamente o flavor que o arquivo nomear.

## A qual eixo pertence uma configuração?

Uma forma rápida de decidir onde cada configuração fica:

- **Depende de como o código é compilado ou depurado** (logging detalhado, `debugPaintSizeEnabled`, relatório de falhas desligado durante o desenvolvimento, overlays de desempenho): use o modo, por meio de `kDebugMode` / `kReleaseMode`. Essas verificações são removidas por tree-shaking dos builds release.
- **Depende de qual ambiente ou produto você está entregando** (URL base da API, projeto do Firebase, bundle ID, nome do app, ícone, IDs de produto do paywall): use um flavor, no lado nativo para tudo o que o sistema operacional lê e por meio de `appFlavor` para tudo o que o Dart lê.
- **É um valor, não uma identidade** (uma feature flag, um número de build, uma chave não secreta): `--dart-define` ou `--dart-define-from-file` costuma ser mais simples que um flavor. Os defines também são constantes de tempo de compilação, então se combinam com os dois eixos.
- **É um segredo**: nenhuma das opções acima. Flavors, modos e defines acabam todos como strings legíveis no binário, como mostra a saída de `strings` acima.

O erro a evitar é mapear ambientes para modos, por exemplo "debug fala com staging, release fala com prod". Funciona até você precisar fazer profile contra produção, depurar um crash exclusivo de release contra staging, ou entregar um build de staging aos testadores pelo TestFlight, que exige um build release. Mantenha os eixos separados e toda combinação continua acessível.

O Firebase é onde isso mais dá errado na prática. Os arquivos `google-services.json` por flavor ficam em source sets do Android como `android/app/src/dev/`, e uma divergência ali produz o tipo de falha exclusiva de release tratada em [login do Firebase Auth que não persiste em um build release](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/). Os source sets de flavor também afetam quais classes Kotlin são compiladas, que é uma das causas em [ClassNotFoundException para MainActivity](/pt-br/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/), e os nomes de saída com flavor (`app-prod-release.apk`, `app-prodRelease.aab`) importam quando você verifica as bibliotecas nativas para [o crash de release "Could not create Dart VM instance"](/pt-br/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Relacionados

- [Como manter o appFlavor preenchido após um hot restart ao usar flutter attach](/pt-br/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)
- [Correção: ClassNotFoundException para MainActivity quando um app Android Flutter é iniciado](/pt-br/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/)
- [Correção: o login do Firebase Auth não persiste em um build release Android do Flutter](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [Correção: Could not create Dart VM instance em um build release do Flutter após flutter upgrade](/pt-br/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)
- [Correção: Unable to load asset no Flutter após adicionar uma imagem ao pubspec.yaml](/pt-br/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)

## Fontes

- [Documentação do Flutter: build modes do Flutter](https://docs.flutter.dev/testing/build-modes)
- [Documentação do Flutter: configurar flavors do Flutter para Android](https://docs.flutter.dev/deployment/flavors)
- [Documentação do Flutter: configurar flavors do Flutter para iOS e macOS](https://docs.flutter.dev/deployment/flavors-ios)
- [Android Developers: configurar build variants](https://developer.android.com/build/build-variants)
- [`flavor.dart` at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/services/flavor.dart)
- [`flutter_command.dart` (`getBuildInfo`, `default-flavor`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/runner/flutter_command.dart)
- [`xcodeproj.dart` (scheme and build configuration matching) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/ios/xcodeproj.dart)
- [`constants.dart` (`kReleaseMode`, `kProfileMode`, `kDebugMode`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/foundation/constants.dart)
