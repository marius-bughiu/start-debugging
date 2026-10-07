---
title: "Correção: Bad state: No suitable NDK found for target architecture arm64 em um build do Flutter"
description: "O build hook android_libcpp_shared (0.2.0 e anteriores) não encontra o seu NDK, ou o seu minSdk está acima da API mais nova do NDK. Atualize para 0.2.1+ ou instale um NDK que cubra o seu minSdk."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "ndk"
  - "native-assets"
lang: "pt-br"
translationOf: "2026/10/fix-no-suitable-ndk-found-for-target-architecture-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-07
---

Este erro não vem do Gradle nem do Flutter. Ele é lançado pelo build hook em Dart do pacote `android_libcpp_shared` (versões 0.1.0 a 0.2.0), que alguns pacotes FFI, como o `croppy`, trazem de forma transitiva. Existem duas causas. Ou a busca de NDK do próprio hook não encontra o NDK que o Gradle está usando sem problemas, ou todo NDK que ele encontra para em um nível de API abaixo do `minSdk` do seu app. No primeiro caso, atualize o pacote para 0.2.1 ou posterior (com `dependency_overrides` se ele for transitivo). No segundo, instale um NDK cujo sysroot cubra o seu `minSdk`: os NDKs r28c e r29 param na API 35, então `minSdk = 36` exige o r30.

Tudo abaixo foi reproduzido no macOS com Flutter 3.44.8 (Dart 3.12.2), o Gradle 9.1.0 do template do Flutter, OpenJDK 17 e NDK r28c (`28.2.13676358`) em um Android SDK em `/opt/homebrew/share/android-commandlinetools`. Li o código-fonte do hook do `android_libcpp_shared` de 0.1.0 a 0.3.1 diretamente dos arquivos do pub.dev.

## O erro em contexto

Esta é a saída de `flutter build apk --debug --target-platform android-arm64` em um app recém-criado com `android_libcpp_shared: 0.2.0` adicionado e nada mais alterado (os caminhos longos de `--packages` foram encurtados):

```text
Unhandled exception:
Bad state: No suitable NDK found for target architecture arm64.
#0      main.<anonymous closure> (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:31:7)
<asynchronous suspension>
#1      build (package:hooks/src/api/build_and_link.dart:250:5)
<asynchronous suspension>
#2      main (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:12:3)
<asynchronous suspension>

  Building assets for package:android_libcpp_shared failed.
  build.dart returned with exit code: 255.
  To reproduce run:
  (cd .../android_libcpp_shared-0.2.0/; .../dart-sdk/bin/dart --packages=.../package_config.json .../hooks_runner/android_libcpp_shared/cbb4418675/hook.dill --config=.../input.json )
  stdout:
  INFO: Searching for android NDK...

Target dart_build failed: Error: Building native assets failed. See the logs for more details.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileFlutterBuildDebug'.
```

A arquitetura no final muda conforme o seu alvo: `arm64`, `arm` ou `x64`. Um build de release sem `--target-platform` compila as três, então você vê a ABI que o runner de hooks tentar primeiro.

O detalhe que confunde todo mundo: o Gradle já tinha resolvido o NDK `28.2.13676358` nesta máquina. O plugin Gradle do próprio Flutter força o download desse NDK em todo build Android, então o NDK estava instalado, válido e em uso. O hook simplesmente não olhou onde ele estava.

## Por que um build hook procura um NDK

Nas versões estáveis atuais do Flutter, pacotes podem incluir um `hook/build.dart` que roda durante o `flutter build` para compilar ou empacotar código nativo (o recurso "native assets" ou "build hooks", construído sobre `package:hooks` e `package:code_assets`). O Flutter executa esses hooks no target `dart_build`, antes de o Gradle compilar qualquer coisa, e entrega a cada hook uma configuração JSON com o SO de destino, a arquitetura, o compilador C que o Flutter encontrou e `targetNdkApi`.

O `android_libcpp_shared` existe para empacotar `libc++_shared.so`, o runtime C++ compartilhado de que bibliotecas FFI compiladas com `-stl=c++_shared` precisam em tempo de carregamento. Para isso ele precisa encontrar um NDK no disco, e na 0.2.0 e anteriores ele executava a própria busca em vez de confiar no NDK que o Flutter passou. Duas coisas dentro dessa busca podem retornar nada, e ambas terminam no mesmo `StateError`.

### Causa 1: o hook procura em menos lugares do que o Gradle

Na 0.2.0, `NDKLocator.locate()` reúne candidatos de exatamente quatro fontes:

1. `ndk-build` no `PATH`, mas ele resolve o diretório pai do diretório do NDK em vez do próprio diretório, então essa fonte nunca correspondia (o changelog da 0.2.1 aponta isso como uma correção).
2. As variáveis de ambiente `ANDROID_NDK`, `ANDROID_NDK_HOME`, `ANDROID_NDK_LATEST_HOME` e `ANDROID_NDK_ROOT`.
3. Um glob fixo por SO: `$HOME/Library/Android/sdk/ndk/*/` no macOS, `$HOME/Android/Sdk/ndk/*/` no Linux, `$HOME/AppData/Local/Android/Sdk/ndk/*/` no Windows.
4. `ndk/*/` dentro de `ANDROID_HOME`, `ANDROID_SDK_ROOT` ou `ANDROID_SDK_HOME`.

O que ele não lê é `sdk.dir` em `android/local.properties`, que é de onde o Gradle realmente obtém o SDK, nem o valor `android-sdk` definido com `flutter config --android-sdk`. O próprio Flutter respeita ambos. Assim, qualquer SDK fora do local padrão do Android Studio, sem um `ANDROID_HOME` exportado, fica invisível para o hook: o `android-commandlinetools` do Homebrew, uma unidade personalizada no Windows e uma imagem de CI que só grava o `local.properties`. No Windows existe uma segunda armadilha: o glob expande `$HOME` com `Platform.environment['HOME']!`, e `HOME` não está definida em uma sessão normal do `cmd.exe`.

### Causa 2: o seu minSdk é maior que a API mais nova de qualquer NDK encontrado

Mesmo quando um NDK é encontrado, o hook só o aceita se o sysroot dele tiver um diretório de nível de API igual ou superior ao SDK mínimo do seu app:

```dart
// android_libcpp_shared 0.2.0, lib/src/locate_ndk.dart
NDKApiLevel? highestMatching(int minApiLevel) {
  final suitableApiLevels =
      _apiLevels.where((api) => api.level >= minApiLevel).toList()
        ..sort((a, b) => b.level.compareTo(a.level));
  return suitableApiLevels.isNotEmpty ? suitableApiLevels.first : null;
}
```

`minApiLevel` é o `targetNdkApi` da configuração do hook, e o Flutter o preenche a partir do `minSdk` mesclado do seu app: o `FlutterPlugin.kt` lê `variant.mergedFlavor.minSdkVersion` e o passa para `flutter assemble` como `-dMinSdkVersion`. Os diretórios de API vêm de `toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/`. Listei esses diretórios para os três NDKs atuais:

| NDK | Revisão | Níveis de API do sysroot |
|-----|---------|--------------------------|
| r28c | `28.2.13676358` (`ndkVersion` padrão do Flutter 3.44) | 21 a 35 |
| r29 | `29.0.14206865` | 21 a 35 |
| r30 | `30.0.16248370` | 21 a 37 |

Portanto `minSdk = 36` com o NDK padrão do Flutter falha, não importa como o NDK seja descoberto. Essa verificação continua na 0.2.1 e na 0.3.x também, apenas com uma mensagem melhor. Ela também é um pouco estranha, porque `libc++_shared.so` fica um nível acima, em `sysroot/usr/lib/<triple>/`, e não é por API de forma alguma. Mas essa é a regra que o pacote impõe, então você precisa satisfazê-la.

## Repro mínimo

As duas causas se reproduzem com um app de template. Para a causa 1 você precisa de um SDK fora do local padrão e sem `ANDROID_HOME`; para a causa 2 qualquer máquina serve.

```bash
# Flutter 3.44.8, android_libcpp_shared 0.2.0, NDK r28c
flutter create --platforms=android -e ndkapp
cd ndkapp
flutter pub add android_libcpp_shared:0.2.0
flutter build apk --debug --target-platform android-arm64
```

Para verificar como o hook enxerga a sua máquina sem um build completo do Gradle, chame o localizador dele a partir de um pacote de console descartável. Foi isso que usei para separar as duas causas:

```dart
// Dart 3.12.2, android_libcpp_shared 0.2.0
// bin/repro.dart  -  dart run bin/repro.dart 36
import 'package:android_libcpp_shared/src/locate_ndk.dart';

Future<void> main(List<String> args) async {
  final minSdk = int.parse(args.first);
  final ndks = await NDKLocator.locate();
  print('NDKs found: ${ndks.length}');
  for (final ndk in ndks) {
    final target = ndk.hostArchitectures.first.findTarget(LibArch.arm64);
    print('${ndk.path.toFilePath()} '
        'match(minSdk=$minSdk): ${target?.highestMatching(minSdk)}');
  }
}
```

Na minha máquina, sem `ANDROID_HOME` ele imprime `NDKs found: 0` (causa 1). Com `ANDROID_HOME` definido e o argumento `24`, imprime `android-35`; com `36`, imprime `null` (causa 2).

## A correção, passo a passo

### 1. Descubra quem depende do android_libcpp_shared

Provavelmente você nunca o adicionou por conta própria:

```bash
# Flutter 3.44.8
flutter pub deps --style=compact | grep android_libcpp_shared
flutter pub deps --style=tree | grep -B5 android_libcpp_shared
```

No momento em que escrevo, os pacotes do pub.dev que dependem dele são `croppy` (1.5.3 fixa exatamente `0.1.0`), `flutter_piper_tts` (`^0.1.1`), `mecab_for_dart` e `than_audiotag` (`^0.2.1`), e `liblsl` (`^0.3.0`). Se o seu resolve 0.2.0 ou anterior, o passo 2 corrige a causa 1.

### 2. Atualize para 0.2.1 ou posterior

A 0.2.1 (publicada em 2026-08-12) reescreveu a descoberta. Ela adiciona aos candidatos o NDK com o qual a ferramenta do Flutter está compilando, derivado do caminho do compilador C na configuração do hook, além de `sdk.dir` e `ndk.dir` de `local.properties`, `flutter config --android-sdk`, uma lista maior de diretórios conhecidos e a busca corrigida no `PATH`. Ela também lê `USERPROFILE` no Windows.

Se a dependência é direta, atualize a versão. Se é transitiva e fixada, faça um override:

```yaml
# pubspec.yaml, Flutter 3.44.8
dependency_overrides:
  android_libcpp_shared: ^0.2.1
```

Qual linha escolher depende da sua versão do Flutter. A 0.2.x depende de `code_assets ^1.0.0` e `hooks ^2.0.2`. A 0.3.0 e a 0.3.1 migram para `code_assets ^2.0.0`. O próprio `flutter_tools` do Flutter 3.44.8 fixa `code_assets 1.0.0`, então no 3.44 recomendo `^0.2.1`, que é o que verifiquei. Com a 0.2.1 e sem `ANDROID_HOME`, o mesmo app de template compila e o APK contém `lib/arm64-v8a/libc++_shared.so`.

Overrides se aplicam a todo o grafo, então verifique se o pacote que fixava a versão antiga continua funcionando com a nova. No caso do `croppy`, que usa o `android_libcpp_shared` apenas pelo efeito colateral do hook, não há API para quebrar.

### 3. Se não for possível atualizar: dê ao hook antigo um caminho que ele procura

Na 0.2.0 ou anterior, exporte uma das variáveis que ele lê antes de compilar:

```bash
# macOS / Linux, android_libcpp_shared 0.2.0
export ANDROID_HOME="$HOME/path/to/your/android/sdk"
flutter clean
flutter build apk
```

```powershell
# Windows PowerShell, android_libcpp_shared 0.2.0
$env:ANDROID_HOME = "D:\Android\Sdk"
$env:HOME = $env:USERPROFILE
flutter clean
flutter build apk
```

Essa variável precisa estar no ambiente de quem quer que inicie o build. Nos meus testes com `flutter build` e Gradle 9.1.0, um daemon do Gradle já aquecido pegou o novo valor no build seguinte, nas duas direções. O lugar onde isso dá errado é o Android Studio iniciado pelo Dock, pelo menu Iniciar ou por um launcher: aplicativos de interface gráfica não leem o `~/.zshrc`, então `flutter run` pela IDE falha enquanto o mesmo comando no terminal funciona. Inicie a IDE a partir de um shell que tenha a variável, ou use o passo 2.

Não pule o `flutter clean` ao testar isso. O Flutter guarda em cache os resultados dos hooks em `.dart_tool/`, e no meu repro um build sem `ANDROID_HOME` continuou passando porque reaproveitou a saída bem-sucedida do hook do build anterior. Você acharia que a correção funciona até que um runner de CI limpo provasse o contrário.

### 4. Se o seu minSdk é maior que 35: instale um NDK que o cubra

Para a causa 2, a única correção certa é um NDK cujo sysroot alcance o seu `minSdk`. Defina-o explicitamente para que o Gradle o baixe em todas as máquinas e runners de CI:

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
android {
    ndkVersion = "30.0.16248370" // NDK r30: sysroot API levels 21 to 37
    defaultConfig {
        minSdk = 36
    }
}
```

A 0.2.1 e posteriores ordenam todos os NDKs encontrados por versão e escolhem o mais novo que passa na verificação de API, então ter o r30 instalado ao lado do r28c já basta. Antes de mudar qualquer coisa, verifique você mesmo os NDKs instalados:

```bash
# any NDK r23 or later; the host folder is darwin-x86_64 even on Apple silicon
ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/
```

O maior número nessa listagem é o maior `minSdk` que aquele NDK consegue satisfazer para este hook.

## O override libcpp_shared_path e a armadilha de múltiplas ABIs

A 0.2.1 também adicionou uma saída de emergência: um user define que aponta diretamente para a biblioteca. A mensagem de erro resultante na 0.2.1 e posteriores até a sugere:

```yaml
# pubspec.yaml, android_libcpp_shared 0.2.1
hooks:
  user_defines:
    android_libcpp_shared:
      libcpp_shared_path: /path/to/ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so
```

Quando o valor é um arquivo, ele pula completamente a descoberta de NDK e a verificação de API, então de fato deixa verde um build com `minSdk = 36`. Mas é um único caminho para todas as arquiteturas. Compilei um APK de release com esse override e o inspecionei:

```text
lib/arm64-v8a/libc++_shared.so:   ELF 64-bit LSB shared object, ARM aarch64
lib/armeabi-v7a/libc++_shared.so: ELF 64-bit LSB shared object, ARM aarch64
lib/x86_64/libc++_shared.so:      ELF 64-bit LSB shared object, ARM aarch64
```

Os slots de ARM de 32 bits e x86_64 agora contêm uma biblioteca arm64. O build é concluído, o app é publicado e ele falha ao carregar a biblioteca em qualquer celular ou emulador que não seja arm64. Use um caminho de arquivo apenas quando compilar uma única ABI (`--target-platform android-arm64`). Se você apontar o user define, ou a variável de ambiente `ANDROID_LIBCPP_SHARED_PATH`, para um diretório raiz de NDK, o hook resolve cada arquitetura corretamente, mas esse caminho volta a passar pela verificação de API, então não contorna a causa 2.

## O que as versões mais novas imprimem no lugar

Se você está na 0.2.1 ou posterior e ainda falha, não verá o texto "No suitable NDK". O hook agora lança um `StateError` mais longo que lista todos os NDKs considerados. O meu repro com `minSdk = 36` na 0.2.1 produziu:

```text
Could not find libc++_shared.so for target architecture arm64 (minimum NDK API level 36).
NDK installations considered:
  - 1 NDK installation(s) found, but none support arm64 at API level 36
```

"Found, but none support ... at API level" é a causa 2, e o passo 4 se aplica. "No Android NDK installation was found" é a causa 1 em uma máquina onde até a busca ampliada falha, o que geralmente significa que o NDK nunca foi baixado: rode um build do Gradle de qualquer projeto Android primeiro, ou instale-o com `sdkmanager "ndk;28.2.13676358"`.

## Erros parecidos

- `NDK at .../ndk/<version> did not have a source.properties file` é um NDK extraído pela metade, e a correção é apagar esse diretório. Esse e outros descompassos de versão do NDK são tratados em [o passo a passo do exit code 1 do assembleDebug](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- `An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format` significa que o próprio download do NDK está corrompido. Veja [como limpar o cache de downloads do SDK Manager](/pt-br/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- `No toolchains found in the NDK toolchains folder for ABI with prefix: mips64el-linux-android` é um Android Gradle Plugin antigo conversando com um NDK novo. Não tem nada a ver com build hooks.
- `Building native assets failed` com uma exceção diferente acima é o hook de outro pacote. Leia a linha `Building assets for package:<name> failed` para ver qual deles.

## Relacionados

- [O Google Play rejeitando um app Flutter por causa do tamanho de página de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) é o outro lugar onde a versão do NDK que você fixa decide se um release vai ao ar.
- [O timeout de lock do journal cache do Gradle](/pt-br/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/) explica como os daemons do Gradle sobrevivem ao build que os iniciou.
- [Resolvendo conflitos do AndroidX em um build Android do Flutter](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) percorre as configurações de `android/app/build.gradle`, incluindo `ndkVersion`.

## Fontes

- [android_libcpp_shared no pub.dev](https://pub.dev/packages/android_libcpp_shared), incluindo o [changelog](https://pub.dev/packages/android_libcpp_shared/changelog) da 0.2.1 e da 0.3.x.
- [NexusDynamic/android_libcpp_shared no GitHub](https://github.com/NexusDynamic/android_libcpp_shared), o código-fonte do hook e do `locate_ndk.dart`.
- [Documentação do Flutter: hooks e native assets](https://docs.flutter.dev/platform-integration/bind-native-code).
- [package:hooks](https://pub.dev/packages/hooks) e [package:code_assets](https://pub.dev/packages/code_assets), o protocolo de build hooks.
- [Histórico de revisões do Android NDK](https://developer.android.com/ndk/downloads/revision_history) para r28c, r29 e r30.
- Código-fonte do `flutter_tools` do Flutter 3.44.8: `lib/src/android/gradle_utils.dart` (`ndkVersion` padrão), `lib/src/android/android_sdk.dart` (`getNdkBinaryPath`) e `gradle/src/main/kotlin/FlutterPlugin.kt` (`-dMinSdkVersion`).
