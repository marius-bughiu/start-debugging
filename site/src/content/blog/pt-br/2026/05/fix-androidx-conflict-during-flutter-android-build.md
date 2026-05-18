---
title: "Solução: conflito de AndroidX durante a build Android do Flutter"
description: "A solução em 30 segundos: defina android.useAndroidX=true e android.enableJetifier=true em android/gradle.properties, depois encontre qualquer plugin ainda na antiga support library e atualize ou substitua."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "androidx"
lang: "pt-br"
translationOf: "2026/05/fix-androidx-conflict-during-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-05-18
---

A solução em uma frase: um `AndroidX conflict` durante uma build Android do Flutter significa que duas metades do seu grafo de dependências discordam sobre qual Android support library elas usam. O engine do Flutter e qualquer plugin publicado nos últimos cinco anos usam `androidx.*`. Um único plugin (ou uma biblioteca Java transitiva) que ainda referencie `android.support.*` é o suficiente para quebrar a build. Defina `android.useAndroidX=true` e `android.enableJetifier=true` em `android/gradle.properties`, rode `flutter clean`, depois `flutter pub get` e `flutter build apk` de novo. Se o Gradle ainda recusar, encontre o plugin culpado com `./gradlew app:dependencies` e atualize ou substitua. Não edite nada em `android/app/build.gradle` ainda.

```text
* What went wrong:
Execution failed for task ':app:checkDebugDuplicateClasses'.
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules
    core-1.6.0-runtime (androidx.core:core:1.6.0) and
    support-compat-28.0.0-runtime (com.android.support:support-compat:28.0.0)

  Go to the documentation to learn how to <a href="d.android.com/r/tools/classpath-sync-errors">Fix dependency resolution errors</a>.

FAILURE: Build failed with an exception.
BUILD FAILED in 12s
```

Este guia foi escrito contra Flutter 3.41.5, Dart 3.11, Android Gradle Plugin 8.7 e Gradle 8.11, o canal stable em maio de 2026. O comportamento descrito aqui é o mesmo desde que o time de tooling do Android congelou o namespace `android.support.*` em 2018 e lançou o Jetifier como a ponte para o bytecode legado. O projeto Flutter habilitou AndroidX por padrão para apps novos no [Flutter 1.12](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (dezembro de 2019); qualquer coisa gerada desde então vem com `useAndroidX=true` de fábrica. Se você está batendo nesse erro, o app quase certamente foi criado em um SDK Flutter anterior à 1.12 e nunca teve a migração aplicada.

## O que o erro realmente significa

`androidx.*` é a segunda geração da Android support library. O Google reescreveu o namespace de pacotes uma vez e se comprometeu a nunca renomeá-lo de novo. Classes sob `android.support.v4.*`, `android.support.v7.*`, `android.support.design.*`, etc. são as support libraries originais e estão congeladas desde a 28.0.0 em setembro de 2018.

O sistema de build do Android se recusa a compilar um APK que contenha as duas metades ao mesmo tempo porque os nomes de classe duplicados colidem no classpath. O erro aparece em uma de três formas concretas:

```text
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules ...
```

```text
This app is using AndroidX dependencies, but the project does not have
the property android.useAndroidX set to true. Configure your project for
AndroidX. See https://goo.gle/flutter-androidx-migration
```

```text
Cannot fit requested classes in a single dex file (# methods: 73512 > 65536)
```

A primeira é uma colisão literal de classpath. A segunda é a verificação prévia da ferramenta Flutter notando que o projeto ainda tem o padrão legado. A terceira é o mesmo conflito expresso mais adiante: puxar as duas bibliotecas estoura o limite de 64K métodos do Dalvik porque toda classe de support tem uma gêmea em AndroidX.

Jetifier é o workaround que vem com o AGP. Em tempo de build ele reescreve toda referência a `android.support.*` dentro de qualquer JAR ou AAR que venha de uma dependência de terceiros, transformando-a na referência equivalente de `androidx.*`. Com Jetifier ligado, um plugin que ainda distribui bytecode de support library é silenciosamente traduzido e a colisão de classes duplicadas some. Com Jetifier desligado, o duplicado fica exposto e a build falha. AGP 8 e posteriores definem `enableJetifier` como `false` por padrão por razões de velocidade de build, e é por isso que esse erro está de volta na capa para projetos que viveram anos sem ninguém notar o plugin legado em sua árvore.

## Uma reprodução mínima

Crie um app Flutter novo em um SDK recente, depois adicione um plugin que ainda referencie a support library através de uma dependência Java transitiva:

```bash
# Flutter 3.41.5
flutter create androidx_repro
cd androidx_repro
flutter pub add some_old_plugin:^1.2.0  # any plugin whose Android side
                                        # depends on com.android.support:*
```

Depois desligue deliberadamente o workaround:

```properties
# android/gradle.properties, Flutter 3.41.5, AGP 8.7
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G
android.useAndroidX=true
android.enableJetifier=false
```

Rode a build:

```bash
flutter build apk --debug
```

O Gradle imprime a falha de classes duplicadas acima e sai com código diferente de zero. A única linha que dispara a regressão é `enableJetifier=false` combinada com uma dependência transitiva de `com.android.support:*`. Religue o Jetifier e a mesma build tem sucesso, mesmo que nada na árvore de plugins tenha mudado.

## Solução, na ordem de quão frequentemente é a resposta

Rode os passos na ordem. Cada passo assume que o anterior não resolveu o erro.

### 1. Defina ambas as flags de AndroidX

Abra `android/gradle.properties` (não o arquivo Gradle do SDK do Flutter, não o `build.gradle` do projeto raiz) e confirme que ambas as linhas estão presentes:

```properties
# android/gradle.properties, Flutter 3.41.5
android.useAndroidX=true
android.enableJetifier=true
```

`useAndroidX=true` diz ao AGP que seu próprio código e o engine do Flutter são AndroidX. `enableJetifier=true` diz ao AGP para reescrever qualquer bytecode de terceiros que ainda referencie a support library. Você precisa dos dois. Definir apenas `useAndroidX=true` enquanto um plugin ainda distribui classes de support é exatamente a configuração que produz o erro de classes duplicadas.

Se o arquivo não existir (raro em um projeto Flutter 1.12+, comum em apps migrados de Android nativo), crie-o. Depois rode:

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter clean` é obrigatório aqui porque o Gradle faz cache do grafo de resolução de dependências; sem ele a build vai reutilizar o grafo que falhou e reportar o mesmo erro.

### 2. Encontre e atualize o plugin legado

Se o Jetifier está ligado e a build ainda falha, o duplicado não é a support library em si, mas um plugin cujo `android/build.gradle` declara `com.android.support:*` diretamente e usa algo que o Jetifier não consegue reescrever (annotation processors são os infratores mais comuns, já que o Jetifier só opera em JARs do classpath de runtime por padrão).

Liste a árvore de dependências do Android:

```bash
# from android/ directory, Flutter 3.41.5
./gradlew app:dependencies --configuration releaseRuntimeClasspath | grep -i "com.android.support"
```

A saída nomeia o plugin e a coordenada da support library. Cruze a referência com seu `pubspec.yaml`. Três resoluções, em ordem de preferência:

1. **Atualize o plugin** se existir uma versão mais nova. Rode `flutter pub outdated` e procure o culpado. Uma versão publicada após o final de 2019 será AndroidX nativa e o conflito some.
2. **Substitua o plugin** se ele não tem mais manutenção. A comunidade Flutter reconstruiu a maioria dos plugins pré-1.12 com um nome diferente; busque no [pub.dev](https://pub.dev) o mesmo domínio (notificações, image picker, etc.) e escolha a opção mantida mais recente.
3. **Forke e faça patch** se nenhum dos anteriores ajuda. Clone o repo do plugin, mude toda linha `com.android.support:appcompat-v7:28.0.0` em `android/build.gradle` para `androidx.appcompat:appcompat:1.6.1` (o [mapeamento de classes do AndroidX](https://developer.android.com/jetpack/androidx/migrate/class-mappings) traduz os nomes velhos para os novos), atualize seu `pubspec.yaml` para apontar para o fork via `git:`, e rode `flutter pub get`.

### 3. Suba `compileSdk` para uma versão que inclua AndroidX

Se você migrou esse app de Android nativo, o `android/app/build.gradle` pode fixar `compileSdkVersion` em 28 ou menos. AndroidX requer `compileSdk` 28 ou superior e funciona melhor na versão estável mais recente. Flutter 3.41.5 define `flutter.compileSdkVersion` como 35 por padrão; se você sobrescreveu, restaure o padrão ou defina explicitamente:

```groovy
// android/app/build.gradle, Flutter 3.41.5, AGP 8.7
android {
    namespace "com.example.androidx_repro"
    compileSdk 35
    ndkVersion flutter.ndkVersion

    defaultConfig {
        applicationId "com.example.androidx_repro"
        minSdkVersion 21      // AndroidX requires at least 19; pick 21 unless you have a reason
        targetSdkVersion 35
    }
}
```

`minSdkVersion 21` é o piso prático para um app AndroidX em 2026. Ir mais baixo funciona em princípio mas puxa shims de compatibilidade que produzem erros de classpath diferentes mas igualmente confusos durante a etapa de merge.

### 4. Habilite multidex se o duplicado foi embora mas o erro de limite dex permanece

O limite de 64K métodos é anterior ao AndroidX e o AGP liga multidex automaticamente quando `minSdkVersion >= 21`. Se você ainda está vendo o erro "cannot fit requested classes", tem um `minSdk` menor que 21 e precisa optar explicitamente:

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        multiDexEnabled true
    }
}

dependencies {
    implementation "androidx.multidex:multidex:2.0.1"
}
```

Isso não é uma solução para o conflito de AndroidX em si, é a passada de limpeza quando você já resolveu as classes duplicadas mas a contagem de métodos residual ainda transborda.

### 5. Último recurso: desligar o Jetifier somente depois de auditar cada dependência

Uma vez que você confirmou via `./gradlew app:dependencies` que nenhum plugin na árvore ainda referencia `com.android.support:*`, defina `android.enableJetifier=false` para o ganho de velocidade de build. A reescrita de classpath do Jetifier é o passo mais caro em uma build Android a frio de um app Flutter grande (15-30 segundos em um projeto típico nas nossas medições). Desligá-lo não requer mudança alguma no seu código ou nas dependências de pub, mas se você fizer isso sem auditar antes, o conflito volta da próxima vez que uma atualização transitiva puxe uma biblioteca legada e você vai pensar que o erro não tem nada a ver com Jetifier porque você o removeu semanas atrás.

## Pegadinhas e casos parecidos

Alguns casos que produzem um erro semelhante ou parecem um conflito de AndroidX mas não são:

- **`Could not find com.android.tools.build:gradle:X.Y.Z`**: não é um problema de AndroidX. O repositório Google Maven está inacessível, ou seu `settings.gradle` perdeu a entrada do repositório `google()`. Adicione `google()` a `pluginManagement.repositories` e `dependencyResolutionManagement.repositories`.
- **`Manifest merger failed : Attribute application@appComponentFactory ...`**: essa é a assinatura histórica de um choque AndroidX/support especificamente no manifest, antes de existir a verificação a nível de bytecode do AGP. A mesma solução (ligar ambas as flags) resolve, mas o gatilho é o `AndroidManifest.xml` de um plugin declarando um nome de componente `android.support.*` em vez de seu código Java referenciar uma classe de support.
- **`Class not found: com.android.support.FileProvider`**: o `AndroidManifest.xml` de um plugin hardcoda o caminho da support library. O Jetifier não reescreve XML do manifest por padrão. Ou atualize o plugin ou sobrescreva o elemento `<provider>` em seu próprio `AndroidManifest.xml` com o equivalente AndroidX (`androidx.core.content.FileProvider`).
- **`Execution failed for task ':app:processDebugMainManifest'`** durante um `flutter run` em uma build de release: geralmente um descasamento de `targetSdkVersion` entre plugins. AndroidX está bem; o merge falha porque dois plugins discordam sobre `android:exported` para uma activity. Não relacionado, mesmo que apareça no mesmo passo do Gradle.
- **A build tem sucesso no macOS mas falha no Linux CI**: a causa raiz mais comum é um `~/.gradle/caches` desatualizado na máquina do desenvolvedor que mascara a flag de AndroidX faltante. O runner Linux tem cache limpo e resolve o grafo de dependências do zero. A solução é a mesma (as flags), mas o sintoma parece um problema só de CI.
- **Um projeto `flutter create` recém-criado bate nisso**: não deveria. Se um app novo bate em um conflito de AndroidX antes de você adicionar qualquer plugin, seu SDK Flutter é anterior à 1.12 e você precisa atualizar. Rode `flutter upgrade` e rode `flutter create` de novo contra o novo SDK; copie seu `lib/` em vez de editar o projeto quebrado.

Se você está recorrendo a `enableJetifier=true` mais de uma vez por ano no mesmo projeto, tem pelo menos um plugin cujo mantenedor parou de acompanhar a plataforma Android. Substitua. O Jetifier está oficialmente designado como um shim transitório, e o time do AGP declarou publicamente que ele será removido em um lançamento maior futuro.

## Relacionados

- [Solução: Version solving failed em pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Solução: Gradle build failed to produce an .apk file em MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)
- [Solução: Failed to build iOS app com Xcode 16 e Flutter 3.x](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Como visar múltiplas versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Solução: A RenderFlex overflowed by N pixels no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/)

## Fontes

- [Migração para AndroidX no Flutter](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (docs.flutter.dev)
- [Migrate to AndroidX](https://developer.android.com/jetpack/androidx/migrate) (developer.android.com)
- [Mapeamento de classes do AndroidX](https://developer.android.com/jetpack/androidx/migrate/class-mappings) (developer.android.com)
- [Notas de versão do Android Gradle Plugin: padrão do enableJetifier](https://developer.android.com/build/releases/gradle-plugin) (developer.android.com)
- [flutter/flutter issue 25325: rastreamento do suporte AndroidX](https://github.com/flutter/flutter/issues/25325) (thread canônica da migração original)
