---
title: "Correção: Gradle task assembleDebug failed with exit code 1 em um build Android com Flutter"
description: "Essa linha é um invólucro, não o erro. Rode de novo com flutter run --verbose ou ./gradlew assembleDebug --stacktrace, leia a falha real do Gradle e corrija aquilo."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "pt-br"
translationOf: "2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-31
---

A correção em uma frase: `Gradle task assembleDebug failed with exit code 1` não é um erro, é o Flutter informando que o Gradle terminou com código diferente de zero. A falha real é impressa acima dela e quase sempre fica cortada do console. Rode de novo com `flutter run --verbose`, ou entre em `android/` e rode `./gradlew assembleDebug --stacktrace`, e corrija o que o Gradle realmente diz sob `* What went wrong:`. Em julho de 2026 a resposta mais comum é o Kotlin embutido do Android Gradle Plugin 9 colidindo com o antigo plugin `kotlin-android`, o que aparece como `Cannot add extension with name 'kotlin'`.

```text
FAILURE: Build failed with an exception.

BUILD FAILED in 47s
Running Gradle task 'assembleDebug'...                             48.2s
Error: Gradle task assembleDebug failed with exit code 1
```

Este guia foi escrito contra Flutter 3.44.7 e Dart 3.12.2, o canal estável em 2026-07-20, com notas sobre Android Gradle Plugin (AGP) 8.x e 9.x, Gradle 8.13, e JDK 17 e 21. O procedimento de diagnóstico não mudou em anos; as causas ordenadas abaixo mudaram, e a primeira é nova desde a chegada do AGP 9.

## Por que a mensagem não diz nada

`assembleDebug` é uma tarefa Gradle do Android. A ferramenta do Flutter chama o wrapper do Gradle no diretório `android/` do seu projeto, repassa a saída e depois verifica o código de saída. Se o código for diferente de zero, a ferramenta levanta exatamente uma linha: o nome da tarefa e o código de saída. Ela não faz ideia do que deu errado, porque falhas do Gradle não são tipadas, são texto.

Aí duas coisas conspiram contra você:

1. A ferramenta do Flutter filtra a saída do Gradle. Ela esconde o ruído da fase de configuração para que um build normal pareça limpo, e ao fazer isso às vezes descarta o bloco de que você precisa.
2. O próprio Gradle trunca. Sem `--stacktrace`, uma cadeia de `Caused by:` com três níveis de profundidade é resumida em uma única linha que pode não nomear o plugin culpado.

Então o primeiro movimento nunca é adivinhar. É fazer o build imprimir a verdade.

## Consiga o erro real antes de mudar qualquer coisa

Rode estes comandos na ordem e pare no primeiro que der um bloco `* What went wrong:` nomeando uma tarefa e uma causa:

```bash
# Flutter 3.44.7, Dart 3.12.2
flutter run --verbose
```

Se ainda estiver opaco, ignore a ferramenta do Flutter por completo e fale direto com o Gradle. Esse é o passo que a maioria pula, e é o que funciona:

```bash
# From the Flutter project root. Use gradlew.bat on Windows.
cd android
./gradlew assembleDebug --stacktrace --info
```

O Gradle agora imprime a falha completa com o módulo que a produziu:

```text
* What went wrong:
A problem occurred configuring project ':file_picker'.
> Failed to apply plugin 'kotlin-android'.
   > Cannot add extension with name 'kotlin', as there is an extension
     already registered with that name.
```

Isso é um erro real e corrigível. `Gradle task assembleDebug failed with exit code 1` nunca foi.

Vale rodar mais um diagnóstico antes de tocar em um único arquivo do Gradle, porque ele sozinho pega uma classe inteira de causas:

```bash
# Validates the Java, Gradle, and AGP versions against each other
flutter analyze --suggestions
```

O [guia de migração Android Java Gradle](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide) documenta esse validador: ele avalia seu JDK, o wrapper do Gradle e as versões do AGP como um trio e informa qual está fora da faixa.

## Causa 1: o Kotlin embutido do AGP 9 versus o plugin `kotlin-android`

Esta é a causa dominante em 2026 e a que mais gente diagnostica errado, porque dispara durante a fase de configuração do Gradle, antes de uma única linha de Dart ou Kotlin ser compilada.

O AGP 9.0 traz suporte embutido a Kotlin e registra automaticamente uma extensão Gradle chamada `kotlin`. Qualquer módulo que ainda aplique o antigo Kotlin Gradle Plugin (`kotlin-android`, também conhecido como KGP) tenta registrar uma segunda extensão com o mesmo nome, e o Gradle recusa:

```text
Cannot add extension with name 'kotlin', as there is an extension
already registered with that name.
```

O módulo nomeado em `A problem occurred configuring project ':x'` diz se o culpado é o seu próprio app ou um pacote do qual você depende. Se for um pacote de plugin como `file_picker` ou `wakelock_plus`, você não consegue corrigir nos seus próprios arquivos de build; ou atualiza o pacote, ou desliga o Kotlin embutido.

A saída de emergência, conforme o [guia de migração para Kotlin embutido para desenvolvedores de apps](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), vai em `android/gradle.properties`:

```properties
# android/gradle.properties -- Flutter 3.44, AGP 9.x
android.newDsl=false
android.builtInKotlin=false
```

Isso restaura o comportamento anterior ao AGP 9 para o build inteiro, e o shim temporário de KGP do Flutter mantém o plugin antigo funcionando. Compra tempo; não é o destino. O Flutter já [registrou a remoção do suporte a KGP](https://github.com/flutter/flutter/issues/184837) e [a remoção do DSL antigo do AGP](https://github.com/flutter/flutter/issues/184839) para uma versão futura.

A migração de verdade, quando todos os plugins dos quais você depende suportarem AGP 9, é apagar o plugin e o bloco `kotlinOptions` de `android/app/build.gradle.kts`:

```kotlin
// android/app/build.gradle.kts -- AGP 9.0+, Flutter 3.47+
plugins {
    id("com.android.application")
    // id("kotlin-android")  <-- delete this line
}

android {
    // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <-- delete this block
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
```

Depois vire a flag:

```properties
# android/gradle.properties
android.builtInKotlin=true
```

Repare nos pisos de versão. O Flutter 3.44 elevou o KGP mínimo suportado para 2.0.0, e a documentação afirma que habilitar o Kotlin embutido exige Flutter 3.47 ou posterior. No 3.44 estável, o movimento correto é `android.builtInKotlin=false` mais uma atualização de pacotes, não uma migração pela metade. Se em vez disso o seu build reclamar que o próprio plugin do Kotlin é antigo demais, essa é uma falha diferente com uma correção diferente, coberta em [o erro de versão do Kotlin Gradle plugin](/pt-br/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).

## Causa 2: seu JDK e seu wrapper do Gradle discordam

A assinatura é um número de versão maior de arquivo de classe:

```text
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
...
Unsupported class file major version 65
```

A versão maior 61 é Java 17, a 65 é Java 21. O número diz qual JDK está rodando o build; a falha diz que o seu wrapper do Gradle é antigo demais para entender bytecode dele. Versões do Gradle anteriores a 7.3 não rodam sob Java 17 de jeito nenhum, e cada versão do Gradle tem seu próprio teto para o JDK mais novo que aceita.

Isso morde mais forte quando você não mudou nada: o Android Studio atualizou, o JDK embarcado dele passou de 17 para 21, e o seu wrapper do Gradle de cinco anos atrás quebrou da noite para o dia.

Verifique qual JDK o Flutter está usando:

```bash
flutter doctor -v
```

Depois, ou suba o wrapper:

```bash
# From android/. Pick the version flutter analyze --suggestions recommends.
./gradlew wrapper --gradle-version=8.13
```

Ou fixe o Flutter em um JDK que o wrapper consiga lidar:

```bash
# macOS example. /usr/libexec/java_home -V lists installed JDKs.
flutter config --jdk-dir=/opt/homebrew/Cellar/openjdk@17/17.0.13/libexec/openjdk.jdk/Contents/Home
```

Prefira mover o Gradle para frente. Fixar um JDK antigo é uma decisão que você vai pagar de novo na próxima subida do AGP.

## Causa 3: incompatibilidade de versão do NDK entre plugins

Qualquer pacote com código nativo declara uma versão de NDK. Se dois deles discordarem do que o seu app configurou, o build para:

```text
* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1101] NDK at .../ndk/26.3.11579264 did not have a source.properties file
```

Ou, de forma mais explícita:

```text
Your project is configured with Android NDK 26.3.11579264, but the following
plugin(s) depend on a different Android NDK version:
- path_provider_android requires Android NDK 27.0.12077973
```

Versões do NDK são retrocompatíveis, então a correção é adotar a versão mais alta que qualquer dependência pedir:

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44
android {
    ndkVersion = "27.0.12077973"
}
```

Se o erro mencionar um `source.properties` ausente, o diretório do NDK citado existe mas é um download parcial. Apague esse diretório dentro da pasta `ndk/` do seu Android SDK e reinstale a versão pelo SDK Manager, depois `flutter clean`.

## Causa 4: um plugin eleva o minSdkVersion acima do seu

A fusão do manifesto acontece dentro do `assembleDebug`, então um conflito de nível de SDK aparece como o mesmo invólucro genérico:

```text
* What went wrong:
Execution failed for task ':app:processDebugMainManifest'.
> Manifest merger failed : uses-sdk:minSdkVersion 21 cannot be smaller than
  version 23 declared in library [:some_plugin]
```

Eleve o piso em vez de suprimir a fusão com `tools:overrideLibrary`, que só move a quebra para o runtime nos aparelhos que você excluiu:

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 23
    }
}
```

O mesmo formato de falha com um pacote concreto é percorrido no texto sobre [background_fetch exigindo minSdkVersion 21](/pt-br/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/). Se em vez disso o merger reclamar de classes duplicadas da support library, você está diante de um problema totalmente diferente: veja [o conflito de AndroidX durante um build Android com Flutter](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/).

## Causa 5: um plugin sem manutenção não tem namespace

O AGP 8.0 tornou a propriedade `namespace` obrigatória e parou de ler `package` do `AndroidManifest.xml`. Um pacote que não publica nada desde o AGP 7 falha na configuração:

```text
* What went wrong:
A problem occurred configuring project ':some_old_plugin'.
> Namespace not specified. Specify a namespace in the module's build file.
```

Não existe forma suportada de injetar um namespace no pacote de outra pessoa a partir do seu app. Em ordem de preferência: atualize o pacote, substitua-o, ou faça um fork e adicione `namespace 'com.example.some_old_plugin'` ao `android/build.gradle` dele. Scripts que reescrevem arquivos sob `~/.pub-cache` circulam muito para esse erro e são uma armadilha: o cache é regenerado, então a correção some na próxima máquina e no CI.

## Causa 6: não há nada errado além do estado em disco

Nem todo exit code 1 é um problema de configuração. Um artefato escrito pela metade em `build/`, um daemon do Gradle segurando um classpath obsoleto, ou um diretório `.dart_tool` de outra versão do SDK produzem falhas que parecem estruturais e não são. Antes de uma sessão longa de depuração, limpe os casos baratos:

```bash
flutter clean
cd android && ./gradlew --stop && ./gradlew clean && cd ..
flutter pub get
flutter run
```

Se compilar depois disso, você tinha um problema de estado obsoleto e não há mais nada a corrigir. Se um `pub get` falhar no caminho, a saída do resolvedor de restrições é um exercício de diagnóstico próprio, coberto em [como ler um erro version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Variantes que caem nesta página por engano

- **`Gradle task assembleRelease failed with exit code 1`**: o mesmo invólucro em torno da variante de release. Tudo acima se aplica, mais R8 e o shrinking, que só rodam em release. Se debug compila e release não, comece definindo `isMinifyEnabled = false` para confirmar que o R8 é o culpado, e então corrija as regras keep ausentes em vez de deixar o shrinking desligado.
- **`Gradle task assembleDebug failed with exit code 1` imediatamente, em menos de dois segundos**: isso não é uma falha de compilação. O Gradle não conseguiu iniciar. Confira a URL da distribuição do wrapper em `android/gradle/wrapper/gradle-wrapper.properties` e o seu acesso de rede a `services.gradle.org`.
- **`Execution failed for task ':app:checkDebugAarMetadata'`**: uma dependência exige um `compileSdk` maior do que o seu app declara. Suba o `compileSdk` em `android/app/build.gradle.kts`; é um teto de tempo de compilação, não um alvo de runtime, então subir não muda o comportamento no aparelho.
- **A falha só acontece no CI**: compare as versões de JDK, Android SDK e NDK do runner com as da sua máquina. A Causa 2 e a Causa 3 explicam quase todos os relatos de "passa local, falha no CI", e ambas têm formato de ambiente, não de código.
- **A falha apareceu depois de atualizar o Flutter**: consulte o índice de mudanças incompatíveis da versão antes de depurar o sintoma. Um salto de framework que também move as versões de AGP e Gradle do template pode disparar várias das causas acima de uma vez, do mesmo jeito que uma [atualização de Flutter 2 para Flutter 3](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) faz.

A lição geral vale além dessa mensagem específica. Toda vez que uma falha de build do Flutter nomear uma tarefa Gradle e um exit code, a ferramenta é apenas a mensageira. Vá para `android/`, rode a tarefa você mesmo com `--stacktrace`, e leia o bloco sob `* What went wrong:`. A correção está sempre nesse bloco, e nunca está na linha que o Flutter imprimiu.

## Relacionados

- [Correção: conflito de AndroidX durante um build Android com Flutter](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- a variante de classes duplicadas de uma falha de configuração, e por que o AGP 8 desligando o Jetifier a trouxe de volta.
- [Flutter: seu projeto exige uma versão mais nova do Kotlin Gradle plugin](/pt-br/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) -- o piso de versão do KGP, que é uma falha distinta da colisão de extensões do AGP 9 acima.
- [Correção: background_fetch exige minSdkVersion 21](/pt-br/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) -- um exemplo trabalhado do conflito de SDK na fusão do manifesto da Causa 4.
- [Correção: Version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- o que fazer quando o `flutter pub get` da sequência de limpeza é justamente o que falha.
- [Migrar um app Flutter 2 para Flutter 3.x: checklist de null safety](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) -- o caminho de atualização mais amplo que costuma disparar várias dessas causas de Gradle de uma vez.

## Fontes

- [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide), documentação do Flutter
- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin), documentação do Flutter
- [Built-in Kotlin migration for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), documentação do Flutter
- [Flutter maintained plugins should support AGP 9.0](https://github.com/flutter/flutter/issues/181383), flutter/flutter
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html#java), documentação do Gradle
- [Android Gradle Plugin release notes](https://developer.android.com/build/releases/gradle-plugin), Android Developers
