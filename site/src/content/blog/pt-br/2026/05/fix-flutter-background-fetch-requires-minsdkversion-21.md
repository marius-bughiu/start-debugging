---
title: "Correção: o plugin background_fetch do Flutter exige minSdkVersion 21"
description: "A correção em 30 segundos: defina minSdkVersion como 21 (ou maior) em android/app/build.gradle. background_fetch é construído sobre o JobScheduler do Android, que só existe a partir da API 21."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "background_fetch"
lang: "pt-br"
translationOf: "2026/05/fix-flutter-background-fetch-requires-minsdkversion-21"
translatedBy: "claude"
translationDate: 2026-05-18
---

A correção em uma frase: o plugin `background_fetch` (Transistor Software) traz um `AndroidManifest.xml` e código Kotlin que conectam o `JobScheduler` do Android, introduzido na API 21 (Android 5.0 Lollipop). Se o `android/app/build.gradle` do seu app Flutter ainda usa `minSdkVersion 19` (ou `16`, em apps gerados num SDK Flutter anterior a 2023), o manifest merger recusa o build com `uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]`. Abra `android/app/build.gradle`, troque `minSdkVersion` para no mínimo `21`, rode `flutter clean`, depois `flutter pub get` e `flutter build apk`. Se você está num SDK Flutter mais novo que usa `minSdk flutter.minSdkVersion`, sobrescreva o padrão global do Flutter em vez de colocar o número literal, caso contrário o plugin Gradle do Flutter vai sobrescrever sua edição silenciosamente no próximo build.

```text
> Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]
    /Users/me/myapp/build/background_fetch/intermediates/merged_manifest/debug/AndroidManifest.xml as the library might be using APIs not available in 19
    Suggestion: use a compatible library with a minSdk of at most 19,
        or increase this project's minSdk version to at least 21,
        or use tools:overrideLibrary="com.transistorsoft.flutter.backgroundfetch" to force usage (may lead to runtime failures)

FAILURE: Build failed with an exception.
BUILD FAILED in 14s
```

Este guia foi escrito contra Flutter 3.41.5, Dart 3.11, `background_fetch` 1.6.2, Android Gradle Plugin 8.7 e Gradle 8.11, o canal estável em maio de 2026. O erro em si está estável desde `background_fetch` 1.0.0; só o `minSdkVersion` padrão de um projeto Flutter recém-gerado se moveu, por isso algumas equipes pegam isso no primeiro build de um app recém-atualizado e outras nunca viram.

## O que o erro realmente diz

O sistema de build do Android executa uma fase de manifest merger que combina o `AndroidManifest.xml` da aplicação com os manifestos de cada AAR no classpath. Cada manifesto declara uma tag `<uses-sdk android:minSdkVersion="X"/>`. O merger escolhe o valor mais alto e recusa um build cujo `minSdkVersion` no nível da aplicação seja menor do que o que qualquer biblioteca declara. `background_fetch` declara `minSdkVersion 21` no [manifesto do plugin](https://github.com/transistorsoft/flutter_background_fetch/blob/master/android/src/main/AndroidManifest.xml), e a única forma de satisfazer o merger é elevar a aplicação para coincidir.

O erro aparece em três formas concretas dependendo da versão do Android Gradle Plugin e da geração do template Flutter:

```text
Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21
declared in library [:background_fetch]
```

```text
The plugin background_fetch requires a higher Android SDK version.
Fix this issue by adding the following to /Users/me/myapp/android/app/build.gradle:
android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

```text
A problem occurred evaluating project ':background_fetch'.
> com.transistorsoft.flutter.backgroundfetch requires Android SDK 21 or above
```

O primeiro é a saída crua do manifest merger. O segundo é a dica pré-voo da CLI `flutter`, que só dispara para plugins que anunciam seu `minSdkVersion` via descritor de plugin do Flutter. O terceiro é uma asserção Gradle embutida no `android/build.gradle` do plugin. As três rastreiam para a mesma restrição: `JobScheduler` e as classes `android.app.job.JobInfo`, `JobService` e `JobParameters` que `background_fetch` invoca foram adicionadas na API 21. Na API 19 elas simplesmente não existem; na API 20 (Android Wear 4.4W) apenas um subconjunto de `JobService` foi enviado. O plugin não vai rodar em nada abaixo de 21, então o manifest merger bloqueia o build antes que você consiga publicar um APK quebrado.

## Por que API 21 especificamente

`JobScheduler` existe por uma razão: antes dele, agendar trabalho em segundo plano repetitivo no Android significava `AlarmManager` com um wake lock, um `IntentService` e um loop de retentativas feito à mão. Essa abordagem drenava bateria, escapava do modo Doze a partir do Android 6.0 e foi depreciada em partes no Android 8.0, 9.0 e 10. `JobScheduler` permite ao SO unir trabalho em segundo plano entre apps, adiá-lo conforme estado de carga ou tipo de rede, e sobreviver à morte do processo. `background_fetch` é, internamente, um wrapper Dart-friendly sobre `JobScheduler` (e o equivalente iOS, `BGTaskScheduler`). Ele não pode, por construção, mirar numa API menor que 21 sem reescrever todo o backend.

O [README](https://pub.dev/packages/background_fetch) do plugin e seu `CHANGELOG.md` declaram esse requisito desde a 1.0.0 em 2018, mas o erro voltou a ser comum em 2025 quando o Google Play começou a recusar apps que miram em `targetSdkVersion 33` ou menor, levando a recompilações em massa de bases de código Flutter antigas que não tocaram seu `android/app/build.gradle` desde 2019.

## Uma reprodução mínima

Crie um app Flutter num SDK que ainda use `minSdkVersion 19` por padrão, adicione o plugin e rode um build de debug:

```bash
# Flutter 3.7.0 (December 2022), the last template before the 19 -> 21 bump
flutter create background_fetch_repro
cd background_fetch_repro
flutter pub add background_fetch
flutter build apk --debug
```

`flutter pub add background_fetch` resolve para `^1.6.2` e escreve uma dependência transitiva no manifesto do plugin Android. O próximo build vai falhar com `Manifest merger failed`. O mesmo erro se reproduz num projeto Flutter 3.41.5 recém-gerado se você baixou manualmente o `minSdkVersion` porque um plugin diferente (`flutter_blue_classic`, por exemplo) parecia precisar de um valor menor.

## A correção, em detalhe

Existem três caminhos viáveis dependendo de qual SDK Flutter gerou o projeto. Escolha o que coincide com seu `android/app/build.gradle`.

### Caminho A: build.gradle Groovy com números literais

Se `android/app/build.gradle` contém um literal `minSdkVersion 19`, troque o literal:

```groovy
// android/app/build.gradle
// Flutter 3.0 through 3.15 era template
android {
    compileSdkVersion 34

    defaultConfig {
        applicationId "com.example.myapp"
        minSdkVersion 21        // was 19
        targetSdkVersion 34
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
}
```

Salve e rode `flutter clean && flutter pub get && flutter build apk`. O merger agora escolhe 21 a partir do app e aceita o 21 do plugin.

### Caminho B: build.gradle Groovy usando flutter.minSdkVersion

Flutter 3.16 e posteriores substituem o literal por uma referência a uma propriedade definida pelo plugin Gradle do Flutter:

```groovy
// android/app/build.gradle
// Flutter 3.16 through 3.27 era template
android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}
```

`flutter.minSdkVersion` passou a ter 21 por padrão a partir do Flutter 3.16, então essa ramificação já passa. Se seu projeto está nesse template e ainda falha no manifest merger, algo está sobrescrevendo a propriedade. Verifique `android/local.properties` por uma linha velha `flutter.minSdkVersion=19` e apague, ou passe `-Pflutter.minSdkVersion=21` na linha de comando do Gradle se sua CI injeta um valor antigo. Não troque a referência da propriedade por um literal; o plugin Gradle do Flutter na 3.41 reescreve `android/app/build.gradle` a cada `flutter run` sob certas condições ([flutter/flutter#177141](https://github.com/flutter/flutter/issues/177141)) e vai desfazer sua edição.

### Caminho C: build.gradle.kts em Kotlin DSL

Flutter 3.29 mudou o template para Kotlin DSL. A forma é a mesma com sintaxe Kotlin:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.29 and later
android {
    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = flutter.minSdkVersion       // resolves to 21 on Flutter 3.29+
        targetSdk = flutter.targetSdkVersion
    }
}
```

Se precisa fixar um valor explícito (por exemplo, porque outro plugin exige 23), ponha `minSdk = 23`. O plugin Gradle do Flutter respeita literais explícitos no template Kotlin DSL; só o template Groovy tem hoje o bug de sobrescrita.

Depois de qualquer um dos três, rode:

```bash
flutter clean
flutter pub get
flutter build apk --release
```

`flutter clean` importa aqui porque o manifest merger cacheia sua decisão em `build/app/intermediates/merged_manifest/`. Um build subsequente sem o passo de clean vai repetir o merge falho a partir do disco e você vai achar que sua edição não fez nada.

## O que realmente custa elevar minSdkVersion para 21

API 21 significa Android 5.0 Lollipop, lançado em outubro de 2014. O próprio [painel de distribuição](https://developer.android.com/about/dashboards) do Google (última atualização significativa antes de o Google mover para dentro do Android Studio) coloca a fatia de dispositivos abaixo de API 21 muito abaixo de 0,3 por cento em 2026, quase tudo Kindle Fire antigos e celulares sem atualização de mercados emergentes. A Play Store não aceita mais novas releases mirando abaixo de API 24, então para um app distribuído pela Play isso é irrelevante. Se você distribui APK por sideload ou lojas alternativas pode ter um público de cauda longa em API 19 ou 20, e nesse caso `background_fetch` simplesmente não é uma opção: não tem shim. Use `WorkManager` diretamente através de um canal [Pigeon](https://pub.dev/packages/pigeon) ou aceite um serviço em primeiro plano com uma notificação persistente.

## Erros depois que o merger passa

Vários erros derivados parecem o primeiro mas têm outras causas raiz. Reconheça-os para não continuar subindo `minSdkVersion` e quebrar a compatibilidade à toa.

**Outro plugin precisa de mais que 21.** Se depois da correção você vê `cannot be smaller than version 23 declared in library [:flutter_blue_plus]`, esse é outro plugin pedindo API 23. Suba `minSdkVersion` para o mais alto declarado por qualquer plugin na sua árvore. Rode `./gradlew app:dependencies` a partir de `android/` para enumerá-los.

**Tag de manifesto faltando para tarefas headless.** Se você usa `BackgroundFetch.registerHeadlessTask` para receber callbacks enquanto o app está terminado, o manifesto precisa declarar o receiver. O manifesto do plugin já inclui isso, mas apps que definem manualmente `tools:replace="android:label"` na tag `<application>` (uma correção da era da migração AndroidX) podem acidentalmente sobrescrever também `android:name` ou dropar o receiver. Leia [o guia de conflito AndroidX](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) se suspeita disso; o sintoma é silencioso (nenhum callback dispara), não um erro de build.

**Identificador BGTaskScheduler do iOS faltando.** O erro do Android é o mais barulhento, mas existe uma configuração paralela no iOS. `Info.plist` precisa de um array `BGTaskSchedulerPermittedIdentifiers` com `com.transistorsoft.fetch`, e o projeto Xcode precisa da capability `background-fetch` habilitada em Signing and Capabilities. A correção do Android acima vai deixar o build passar no Android, mas o build iOS ainda falha ou, pior, compila e nunca dispara um callback em produção.

**O daemon do Gradle cacheia o manifesto fundido.** Em CI, `flutter clean` nem sempre é suficiente. O daemon do Gradle guarda saídas de `:app:processDebugManifest` em `~/.gradle/caches/`. Se uma execução de CI falhou uma vez com o `minSdkVersion` velho, a próxima pode repetir a falha a menos que você chame `./gradlew --stop` antes do próximo build ou apague o diretório de cache.

**Jetifier num AGP recente muda a cara do erro.** AGP 8.7 desabilita Jetifier por padrão. Se você o reabilitou explicitamente em `gradle.properties` (`android.enableJetifier=true`), o manifest merger roda depois que o Jetifier reescreve o AAR da biblioteca, e a mensagem de erro troca `com.transistorsoft.flutter.backgroundfetch` por um nome reescrito para `androidx.*`. Mesma causa raiz, texto de superfície diferente. A correção é idêntica.

**NDK ou buildToolsVersion pinados abaixo de 30.** Um número muito pequeno de projetos antigos pina `buildToolsVersion "29.0.3"` em `android/app/build.gradle`. `background_fetch` 1.6 foi compilado contra build tools do Android 14 e não vai linkar contra símbolos de `JobService` abaixo de 30. Remova o pin ou suba para `34.0.0`.

## Leituras relacionadas

A migração AndroidX é a outra metade da razão pela qual builds Flutter Android quebram em projetos antigos: veja [conflito AndroidX durante build Flutter Android](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) para o comportamento detalhado do manifest merger e Jetifier. Se o que falha é `flutter pub get`, [version solving failed em pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) percorre a cadeia de "because" do resolvedor. O paralelo iOS para muitos dos mesmos sintomas vive em [Failed to build iOS app com Xcode 16 e Flutter 3.x](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/). E se a falha real do Android é a linha de comando do Gradle, não o manifest merger, [Gradle build failed to produce an .apk file em MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) tem os mesmos passos de triagem com caminhos específicos do MAUI, mas as notas sobre cache do AGP se aplicam igual.

## Fontes

- [Pacote `background_fetch` no pub.dev](https://pub.dev/packages/background_fetch)
- [Guia de instalação Android do `flutter_background_fetch`](https://github.com/transistorsoft/flutter_background_fetch/blob/master/help/INSTALL-ANDROID.md)
- [Referência da API `JobScheduler` do Android (adicionada na API 21)](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Documentação do manifest merger do Android Gradle Plugin](https://developer.android.com/build/manage-manifests)
- [flutter/flutter#177141: plugin Gradle do Flutter sobrescreve `minSdk` explícito](https://github.com/flutter/flutter/issues/177141)
- [Notas de versão do Flutter 3.16: `minSdkVersion` padrão elevado para 21](https://docs.flutter.dev/release/release-notes/release-notes-3.16.0)
