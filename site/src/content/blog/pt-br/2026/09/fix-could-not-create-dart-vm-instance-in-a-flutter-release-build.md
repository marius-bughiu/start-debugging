---
title: "Correção: Could not create Dart VM instance em um build release do Flutter depois do flutter upgrade"
description: "O APK de release saiu sem libapp.so. O Flutter 3.44.0 a 3.44.4 podia descartá-lo: atualize para 3.44.5 ou posterior e separe o bloco subprojects combinado."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "pt-br"
translationOf: "2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Seu build release não contém o código Dart compilado. O engine procura o snapshot AOT em `libapp.so`, não encontra nada e não consegue inicializar a VM. Depois de atualizar para o Flutter 3.44.0 até 3.44.4, a causa comum é uma regressão no plugin do Gradle que descartava `libapp.so` do APK ou do app bundle sem nenhum aviso. Rode `unzip -l` no APK para confirmar, atualize para o Flutter 3.44.5 ou posterior (3.47.3 é a versão estável atual) e separe o bloco `subprojects` combinado em `android/build.gradle` em dois blocos.

Tudo abaixo foi conferido contra o código-fonte do Flutter 3.44.x e 3.47.3 no GitHub, o changelog dos hotfixes da 3.44 e o código do engine que imprime essas linhas.

## O erro como o logcat imprime

```text
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_data.cc(20)] VM snapshot invalid and could not be inferred from settings.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm.cc(253)] Could not set up VM data to bootstrap the VM from.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_lifecycle.cc(85)] Could not create Dart VM instance.
```

O app fecha antes de `main()` rodar. Na 3.44, o crash nativo normalmente vem logo depois em `FlutterJNI.performNativeAttach`. Engines mais antigos adicionavam uma quarta linha, `[FATAL:flutter/shell/common/shell.cc] Check failed: vm. Must be able to initialize the VM.` A variante do macOS dessa falha imprime `Isolate snapshot invalid and could not be inferred from settings.` em `dart_vm_data.cc(31)` no lugar da linha do VM snapshot. Essa tem outra causa, explicada mais abaixo.

O padrão que traz as pessoas a esta página: builds debug e `flutter run` funcionam, um projeto novo de `flutter create` funciona, e o build release do app de verdade quebra ao abrir. Começou só com `flutter upgrade`, e voltar para a versão anterior faz o problema sumir.

## Por que o engine não encontra um VM snapshot

Um build release não leva código-fonte Dart nem bytecode de kernel. O `gen_snapshot` compila seu app antecipadamente em uma biblioteca compartilhada nativa: `libapp.so` no Android e `App.framework` no iOS e no macOS. Essa biblioteca exporta os símbolos do snapshot da VM e do snapshot do isolate, e o engine inicializa a partir deles.

A primeira linha do log vem de `DartVMData::Create` no engine. Primeiro ele usa o snapshot que o embedder passou. Se estiver ausente ou inválido, recorre a `DartSnapshot::VMSnapshotFromSettings`, que procura os símbolos do snapshot nas bibliotecas listadas em `settings.application_library_paths`. Se isso não retorna nada, ele registra o erro e retorna vazio. As outras duas linhas são os chamadores desistindo. Então "VM snapshot invalid" quase nunca significa um snapshot corrompido. Significa que não havia biblioteca AOT onde procurar.

A pergunta passa a ser: por que o pacote não contém `libapp.so`? Em ordem de probabilidade:

1. **A regressão do Gradle no Flutter 3.44.0 a 3.44.4.** `libapp.so` era descartado de APKs e app bundles em algumas estruturas de projeto. É a que aparece depois do `flutter upgrade`.
2. **`debuggable true` no build type release.** O plugin do Gradle do Flutter então compila o Dart em modo debug, e nenhuma biblioteca AOT é gerada.
3. **macOS Big Sur rodando um app compilado com Flutter 3.44 ou posterior.** A biblioteca está lá, mas o carregador dinâmico antigo não consegue resolver os símbolos na nova saída Mach-O.

## Confirme: olhe dentro do APK

Não chute, verifique. Leva dez segundos:

```bash
# Flutter 3.44.x, Android release build
flutter build apk --release
unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -E 'lib/[^/]+/lib(app|flutter)\.so' | sort
```

Um APK saudável lista as duas bibliotecas para cada ABI que você distribui:

```text
lib/arm64-v8a/libapp.so
lib/arm64-v8a/libflutter.so
lib/armeabi-v7a/libapp.so
lib/armeabi-v7a/libflutter.so
lib/x86_64/libapp.so
lib/x86_64/libflutter.so
```

O APK em [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), o principal relato dessa regressão, listava `libflutter.so` e `libdartjni.so` para as três ABIs e nenhum `libapp.so`. Essa assimetria é a assinatura do problema. `libflutter.so` vem de uma dependência AAR, então sobreviveu. `libapp.so` vinha por outro caminho, então não.

Em um app bundle, os caminhos ficam sob `base/lib/`:

```bash
# Flutter 3.44.x
unzip -Z1 build/app/outputs/bundle/release/app-release.aab | grep 'libapp.so'
```

Com flavors, o nome do arquivo inclui o flavor (`app-prod-release.apk`, `app-prodRelease.aab`). Confira todas as ABIs, não só arm64. Na variante do bug com flavors, uma ABI pode estar presente e as outras faltando.

## O que mudou no Flutter 3.44

Antes da 3.44, o plugin do Gradle do Flutter entregava `libapp.so` dentro de uma dependência jar. Isso escondia a biblioteca do stripping de bibliotecas nativas do AGP, então [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275) (merge em 2026-01-26, lançado na 3.44.0 em 2026-05-15) moveu-a para um diretório de source set `jniLibs` que o plugin preenche. Essa mudança tornou `libapp.so` passível de stripping, e também deixou a entrega frágil de duas formas, conforme a descrição da correção, [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119):

1. O diretório `jniLibs` era resolvido de forma antecipada quando `:app` era configurado, mas escrito de forma tardia pela task de cópia. Se `:app` fosse avaliado antes de o diretório de build dele ser redirecionado, os dois discordavam sobre onde ficava o diretório de build, e o `libapp.so` preparado nunca era mesclado. Isso acontece com o antigo bloco `subprojects` combinado mais qualquer plugin cujo nome de projeto Gradle venha alfabeticamente antes de `app`.
2. A task de cópia escrevia dentro do próprio diretório de saída da task do Flutter. As saídas sobrepostas quebravam as verificações up-to-date do Gradle. Em um projeto com flavors, um `flutter run` em um dispositivo (uma ABI) seguido de um `flutter build appbundle` completo deixava as outras ABIs sem `libapp.so` ([#187388](https://github.com/flutter/flutter/issues/187388)). Um relato relacionado mostrava builds incrementais com flavors distribuindo o `libapp.so` do build anterior ([#187553](https://github.com/flutter/flutter/issues/187553)).

Os app bundles falhavam de forma mais visível. A mesma biblioteca ausente aparece em tempo de build como `Release app bundle failed to strip debug symbols from native libraries` ([#186810](https://github.com/flutter/flutter/issues/186810)). APKs não têm essa verificação, então compilam sem erro e quebram no aparelho.

## Repro mínimo do gatilho de subprojects

Esta é a estrutura que o time do Flutter codificou no teste de integração `gradle_libapp_so_packaging_test.dart` que acompanha a correção. Um `android/build.gradle` raiz de um template antigo, com as duas instruções em um único bloco:

```groovy
// android/build.gradle, pre-2021 template shape, broken on Flutter 3.44.0 to 3.44.4
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
    project.evaluationDependsOn(':app')
}
```

Adicione qualquer plugin com código nativo Android cujo nome venha antes de `app`, por exemplo `android_intent_plus`, compile com `flutter build apk --release` na 3.44.4, e o APK fica sem `libapp.so`. `subprojects {}` percorre os projetos em ordem alfabética. `evaluationDependsOn(':app')` dispara ao processar o primeiro plugin, o que força `:app` a ser configurado antes de o loop chegar nele e redirecionar o seu `buildDir`.

## Correção 1: atualize para o Flutter 3.44.5 ou posterior

A correção entrou no master em 2026-06-23 e recebeu cherry-pick para o [Flutter 3.44.5](https://github.com/flutter/flutter/releases/tag/3.44.5) (2026-07-06). A entrada do changelog da 3.44.5 diz: "When building Android app bundles using flavors, or with an old app template combined with a plugin coming alphabetically before app, fixes problems with failing to include libapp.so." Agora `libapp.so` é preparado por uma task dedicada, `CopyFlutterJniLibsTask`, cuja saída é registrada pela API de variantes do AGP, `variant.sources.jniLibs.addGeneratedSourceDirectory(...)`. O AGP passa a controlar a dependência da task e resolve o caminho de forma tardia, qualquer que seja a ordem de avaliação.

```bash
# upgrade to current stable (3.47.3 as of 2026-09-10)
flutter upgrade
flutter --version

# clear the stale intermediates that the broken versions left behind
flutter clean
flutter pub get
flutter build apk --release
```

Depois rode a verificação com `unzip` de novo antes de publicar. Se você precisa ficar na linha 3.44, as versões 3.44.5 a 3.44.9 têm a correção. Na 3.44.0 a 3.44.4, `flutter clean` sozinho só ajuda com o gatilho de flavors, e só até o próximo `flutter run` em um único dispositivo. Não faz nada contra o gatilho de subprojects.

Se você fixa a versão do Flutter no CI com FVM ou um arquivo `.flutter-version`, atualize esse pin também. Um `flutter upgrade` local não muda a versão com que seu pipeline compila, e é assim que um crash que "já está corrigido na minha máquina" ainda chega à Play Store. Fixar a versão continua sendo a ideia certa, como defendido no [post sobre builds reproduzíveis do Flutter](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/). Só mova o pin de propósito.

## Correção 2: separe o bloco subprojects combinado

Faça isso mesmo depois de atualizar. O bloco combinado saiu do template há anos ([flutter/flutter#91030](https://github.com/flutter/flutter/pull/91030)) porque causava bugs de ordem, e um mantenedor do Flutter observou em [#186810](https://github.com/flutter/flutter/issues/186810) que a sintaxe combinada provavelmente ainda não é suportada de modo geral, mesmo com a interação da 3.44 já corrigida. O `build.gradle.kts` raiz do template `android-kotlin` do Flutter 3.47.3 é assim:

```kotlin
// android/build.gradle.kts, Flutter 3.47.3 app template
val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
```

Se você ainda usa Groovy, o equivalente é:

```groovy
// android/build.gradle, Groovy equivalent of the Flutter 3.47.3 template
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}
```

Dois blocos significam que o diretório de build de cada projeto é redirecionado antes que qualquer coisa force a avaliação de `:app`. Procure também sobras como um terceiro bloco `subprojects { afterEvaluate { ... compileSdkVersion ... } }` que força valores nos plugins. Eles vêm de antigos workarounds do Stack Overflow e costumam causar a próxima falha de atualização do Gradle. Quando o Gradle falha de verdade em vez de falhar em silêncio, [o erro real geralmente fica enterrado acima da linha do código de saída](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Correção 3: remova debuggable true do build type release

Essa causa é anterior à 3.44 e continua presente na 3.47.3. O plugin do Gradle do Flutter escolhe o modo de build do Dart a partir do build type do Android em `FlutterPluginUtils.buildModeFor`:

```kotlin
// Flutter 3.47.3, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun buildModeFor(buildType: BuildType): String {
    if (buildType.name == "profile") {
        return "profile"
    } else if (buildType.isDebuggable) {
        return "debug"
    }
    return "release"
}
```

Então esta configuração compila seu código Dart em modo debug, sem `libapp.so`, enquanto o resto do pipeline ainda espera um engine release:

```kotlin
// android/app/build.gradle.kts, Flutter 3.47.3: this crashes on launch
android {
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isDebuggable = true // makes buildModeFor() return "debug"
        }
    }
}
```

O resultado são as mesmas três linhas de log. O relato é [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), ainda aberto. Remova `isDebuggable = true` (`debuggable true` em Groovy) de `release`. Se você queria isso para anexar um depurador nativo a um build assinado, use `flutter build apk --profile`, ou adicione um build type separado para isso e aceite que ele roda Dart em modo JIT. Um build type personalizado como `staging` sem `isDebuggable` recebe Dart em modo release, que é o que você quer ali.

## A variante do macOS Big Sur: Isolate snapshot invalid

Se o log diz `Isolate snapshot invalid and could not be inferred from settings.` e a máquina está no macOS 11 Big Sur, a biblioteca existe e nada está faltando no pacote. A partir do Flutter 3.44, o `App.framework` no iOS e no macOS é escrito diretamente pelo `gen_snapshot` (`--snapshot_kind=app-aot-macho-dylib`) em vez de ser linkado pelo `ld64`. A nova dylib não tem exports trie nem tabela de conteúdo. O dyld do Big Sur (dyld-832) recorre então a uma busca binária na tabela de símbolos, que a nova saída não satisfaz. Alguns símbolos do snapshot são resolvidos e outros não, então o VM snapshot carrega e o isolate snapshot falha. O dyld do Monterey usa uma busca linear nesse caso e carrega o mesmo binário sem problemas.

Isso foi investigado em [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) e [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), e não será corrigido. O Flutter 3.47 lista o Big Sur (11) e anteriores como não suportados na [página de plataformas suportadas](https://docs.flutter.dev/reference/supported-platforms), e o time do Flutter não faz cherry-pick para linhas estáveis antigas. Suas opções são ficar no Flutter 3.41.x para builds que precisam rodar no Big Sur, ou subir `MACOSX_DEPLOYMENT_TARGET` para 12.0 e deixar esses usuários de fora. Um workaround da comunidade reordena as entradas da tabela de símbolos depois do build e assina o framework de novo. Um mantenedor do Dart disse depois que a análise por trás dele estava parcialmente errada (a peça que falta é a tabela de conteúdo, não a ordem dos símbolos), então eu não publicaria isso.

Você pode inspecionar o que o seu build produziu com `nm`:

```bash
# Flutter 3.47.3, macOS release build
flutter build macos --release
nm -p build/macos/Build/Products/Release/*.app/Contents/Frameworks/App.framework/App | grep kDart
```

## Erros parecidos que não são este bug

- Um build debug de iOS que morre na inicialização com `mprotect failed: 13 (Permission denied)` também é a VM do Dart falhando, mas em modo JIT no iOS 26. Essa é [outra correção: atualizar para o Flutter 3.35 ou posterior](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).
- Um build release que abre normalmente e depois se comporta mal já passou deste ponto: a VM inicializou. Perder o login do Firebase só no release, por exemplo, se resume a um `google-services.json` diferente, uma renovação de token rejeitada ou App Check. Veja [a correção do Firebase Auth só no release](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).
- Em um app com flavors, `appFlavor` virar `null` depois de um hot restart é uma lacuna do `flutter attach`, não um problema de empacotamento. Veja [como manter o appFlavor preenchido depois de um hot restart](/pt-br/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- Módulos add-to-app compilados como AAR podem mostrar as mesmas três linhas quando o AAR foi compilado em outro modo ou a partir de um checkout do Flutter modificado ([#114881](https://github.com/flutter/flutter/issues/114881)). Recompile o AAR com `flutter build aar` a partir de um SDK sem modificações e confira a pasta `jni/` do AAR em busca de `libapp.so`.

## Relacionados

- O que mais mudou na versão que introduziu a regressão: [Flutter 3.44 e o SwiftPM como padrão](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Falhas do Gradle que de fato quebram o build: [Gradle task assembleDebug failed with exit code 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Por que fixar a versão do Flutter importa, e por que é preciso mover o pin deliberadamente: [builds reproduzíveis do Flutter](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).
- O outro crash de inicialização da VM do Dart: [mprotect permission denied no iOS](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).

## Fontes

- [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), o relato da 3.44.1 com a listagem do APK que mostrou `libapp.so` ausente em todas as ABIs.
- [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119), a correção, com a análise da causa raiz dos dois gatilhos.
- [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275), a mudança que tirou `libapp.so` de dentro de um jar.
- [flutter/flutter#186810](https://github.com/flutter/flutter/issues/186810) e [#187553](https://github.com/flutter/flutter/issues/187553), as variantes do app bundle e do flavor desatualizado.
- [CHANGELOG do Flutter, hotfix 3.44.5](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md), que lista as três issues.
- [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), `debuggable true` em um build type release.
- [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) e [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), a falha de carregamento do `App.framework` no Big Sur.
- Código-fonte do engine do Flutter, `engine/src/flutter/runtime/dart_vm_data.cc` e `dart_snapshot.cc` no branch `stable`, para a origem das linhas de log.
