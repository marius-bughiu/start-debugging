---
title: "Correção: ClassNotFoundException para MainActivity quando um app Flutter Android é iniciado"
description: "O .MainActivity do manifest é resolvido em relação ao namespace do Gradle, e nenhuma classe com esse nome está no APK. Faça o namespace, a linha package do Kotlin e o manifest concordarem."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "pt-br"
translationOf: "2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches"
translatedBy: "claude"
translationDate: 2026-10-06
---

A classe de activity indicada no seu `AndroidManifest.xml` mesclado não existe nos arquivos dex do APK. Em um app Flutter, isso quase sempre significa que um de três valores ficou dessincronizado durante uma renomeação: `namespace` em `android/app/build.gradle.kts` (em relação ao qual o `.MainActivity` do manifest é resolvido), a linha `package` no topo de `MainActivity.kt`, ou o source set de flavor em que o arquivo está. Deixe a linha `package` igual ao `namespace`, não mexa no `applicationId` a menos que você realmente queira uma nova identidade na loja, depois rode `flutter clean` e compile de novo. A pasta em que o arquivo `.kt` está não importa.

Tudo abaixo foi reproduzido no macOS com Flutter 3.44.8 (Dart 3.12.2), cujo template de `flutter create` fixa AGP 9.0.1, Kotlin 2.3.20 e Gradle 9.1.0, rodando em um emulador arm64 com Android 16 (API 36). Cada cenário foi compilado com `flutter build apk`, inspecionado com `aapt2` e `dexdump` do build-tools 36.1.0, e iniciado com `adb shell am start`.

## O erro em contexto

Este é o crash da minha reprodução depois de alterar apenas o `namespace` (caminhos encurtados):

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.RuntimeException: Unable to instantiate activity ComponentInfo{com.example.clsrepro/com.acme.shop.MainActivity}: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[[zip file "/data/app/~~.../com.example.clsrepro-.../base.apk"],nativeLibraryDirectories=[/data/app/~~.../lib/arm64, /system/lib64, /system_ext/lib64]]
E AndroidRuntime: Caused by: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[...]
```

Leia a parte `ComponentInfo{A/B}` com atenção, porque ela diz qual valor está errado. `A` é o application ID sob o qual o app foi instalado. `B` é a classe totalmente qualificada que o sistema tentou instanciar. Se `B` não for uma classe que existe no seu código Kotlin, o manifest e o código discordam. O build é bem-sucedido, o APK é instalado e o app morre antes de o engine do Flutter iniciar, então nenhum código Dart ou log seu é executado. O stack trace está em `adb logcat -b crash`.

## Por que a classe está faltando

O Android inicia o seu app lendo o `android:name` da activity de launcher no manifest mesclado e carregando exatamente esse nome de classe dos `classes*.dex` do APK. O template do Flutter escreve isso de forma abreviada:

```xml
<!-- android/app/src/main/AndroidManifest.xml, Flutter 3.44.8 template -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    ... >
```

Um nome que começa com ponto é anexado ao `namespace` do módulo vindo de `build.gradle.kts`, e não ao `applicationId` nem a qualquer pacote que o seu arquivo Kotlin declare. A classe que acaba no dex recebe o nome dado pela linha `package` em `MainActivity.kt`. Nada no build verifica se esses dois batem, então há três maneiras de chegar ao crash:

1. **O `namespace` mudou, a linha `package` do Kotlin não.** O manifest agora aponta para `<new namespace>.MainActivity`, e o dex ainda tem `<old package>.MainActivity`.
2. **A linha `package` do Kotlin mudou, o `namespace` não.** O espelho do item 1.
3. **A classe nem é compilada nesta variante.** Normalmente o `MainActivity.kt` foi movido para um source set de flavor (`src/free/kotlin`) e você compilou outro flavor, ou o arquivo foi apagado quando alguém regenerou a pasta `android/`.

Não é o R8. A etapa de recursos (AAPT2) gera uma regra keep para cada classe referenciada no manifest, então um build de release não consegue remover a `MainActivity`. Mais sobre isso abaixo.

## Reprodução mínima

Comece a partir de um template limpo e altere uma linha:

```bash
# Flutter 3.44.8, AGP 9.0.1
flutter create --org com.example --platforms android clsrepro
cd clsrepro
```

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8 template, AGP 9.0.1
android {
    namespace = "com.acme.shop"          // was "com.example.clsrepro"
    // ...
    defaultConfig {
        applicationId = "com.example.clsrepro"
        // ...
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/example/clsrepro/MainActivity.kt, unchanged
package com.example.clsrepro

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

`flutter build apk --debug` é bem-sucedido. Aqui está o que realmente há dentro do APK, e o que aconteceu ao iniciar, para cada variante que testei:

| Cenário | `android:name` do manifest (mesclado) | Classe no dex | Resultado |
|---|---|---|---|
| Base do template | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | roda |
| Apenas `namespace` alterado | `com.acme.shop.MainActivity` | `com.example.clsrepro.MainActivity` | **ClassNotFoundException** |
| Apenas `applicationId` alterado | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | roda (instalado como `com.acme.shop`) |
| Apenas a linha `package` do Kotlin alterada | `com.example.clsrepro.MainActivity` | `com.acme.shop.MainActivity` | **ClassNotFoundException** |
| `namespace` e linha `package` alterados, arquivo deixado na pasta antiga | `com.acme.shop.MainActivity` | `com.acme.shop.MainActivity` | roda |
| `MainActivity.kt` em `src/free/kotlin`, flavor `free` | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | roda |
| o mesmo, flavor `paid` | `com.example.clsrepro.MainActivity` | (nenhuma) | **ClassNotFoundException** |
| Base do template, `--release` (R8 ligado) | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | roda |

Duas linhas merecem atenção. Alterar apenas o `applicationId` é inofensivo, porque o nome da classe nunca dependeu dele. E mover o arquivo para combinar com o novo pacote não é obrigatório: o Kotlin não exige que o diretório corresponda à declaração `package`, então a linha com o arquivo ainda em `com/example/clsrepro/` roda sem problemas. A maioria dos guias de "renomeie o pacote do seu Flutter" manda mover as pastas primeiro, e essa é justamente a etapa que menos importa.

## A correção, passo a passo

### 1. Leia os três valores no APK compilado, não no seu código-fonte

Arquivos de código-fonte podem enganar (um editor não salvo, um override de flavor, um placeholder no manifest). O APK não. Com o build-tools do Android SDK no seu `PATH`:

```bash
# Android SDK build-tools 36.1.0, after flutter build apk --debug
APK=build/app/outputs/flutter-apk/app-debug.apk

# 1. The application ID it installs as
aapt2 dump packagename $APK

# 2. The activity class the manifest asks for
aapt2 dump xmltree --file AndroidManifest.xml $APK | grep -A2 "E: activity" | grep android:name

# 3. The MainActivity classes that actually exist
unzip -o -q $APK 'classes*.dex' -d /tmp/dex
for d in /tmp/dex/classes*.dex; do dexdump $d | grep "Class descriptor" | grep MainActivity; done
```

Na reprodução com o `namespace` quebrado, isso imprimiu `com.acme.shop.MainActivity` no passo 2 e `Lcom/example/clsrepro/MainActivity;` no passo 3. Se o passo 3 não imprimir nada, você está no caso "não compilada nesta variante"; pule para o passo 4.

### 2. Faça a linha `package` do Kotlin corresponder ao `namespace`

Decida em qual nome você quer que o seu código fique e defina os dois com ele:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1
android {
    namespace = "com.acme.shop"
    defaultConfig {
        applicationId = "com.acme.shop"   // only if you want a new store identity, see below
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/acme/shop/MainActivity.kt, Flutter 3.44.8
package com.acme.shop

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

Mova o arquivo para `kotlin/com/acme/shop/` por organização, se quiser. Para Kotlin, é opcional. Se a sua activity for um arquivo Java (`MainActivity.java`, comum em projetos Flutter mais antigos), mova também: a convenção do Java e as refatorações da IDE esperam que o diretório corresponda ao pacote.

Se preferir não mexer no `namespace`, você pode escrever o nome totalmente qualificado no manifest (`android:name="com.example.clsrepro.MainActivity"`). Isso funciona, mas esconde a divergência em vez de eliminá-la, e a próxima alteração de `namespace` não vai levá-lo junto.

### 3. Procure com grep por restos do nome antigo

Uma renomeação que esquece um arquivo produz exatamente este crash. Pesquise toda a árvore `android/`, incluindo manifests de outros source sets (`src/debug/AndroidManifest.xml`, `src/profile/AndroidManifest.xml`) e quaisquer outros arquivos Kotlin ou Java que declarem o pacote antigo:

```bash
# from the Flutter project root
grep -rn "com.example.clsrepro" android/ --include='*.kt' --include='*.java' --include='*.xml' --include='*.kts' --include='*.gradle'
```

Subclasses personalizadas de `Application`, `BroadcastReceiver`s e `Service`s declarados com um ponto inicial são resolvidos em relação ao `namespace` da mesma forma, então quebram com a mesma exceção (a mensagem só cita uma classe diferente, e para um `Application` ela diz "Unable to instantiate application").

### 4. Se a classe estiver totalmente ausente, corrija o source set

Quando o `dexdump` não mostra nenhuma `MainActivity`, descubra onde o arquivo está:

```bash
find android/app/src -name 'MainActivity.*'
```

Tudo que está em `src/main/` é compilado em todas as variantes. Tudo que está em `src/<flavor>/` ou `src/<buildType>/` só é compilado para aquela variante. Na minha reprodução, colocar `MainActivity.kt` em `src/free/kotlin` e rodar `flutter run --flavor paid` produziu `Didn't find class "com.example.clsrepro.MainActivity"` sob o application ID `com.example.clsrepro.paid`. Ou mova o arquivo de volta para `src/main/kotlin`, ou dê a cada flavor sua própria cópia com o mesmo pacote. Se o arquivo simplesmente sumiu (uma pasta `android/` regenerada), recrie-o a partir do template acima.

### 5. Limpe e reinstale

```bash
# Flutter 3.44.8
flutter clean
flutter pub get
flutter run
```

Intermediários desatualizados podem manter um dex antigo depois de uma renomeação, e uma instalação antiga sob o application ID anterior ainda pode ser dona do ícone de launcher em que você está tocando. Se você alterou o `applicationId`, desinstale o pacote antigo (`adb uninstall com.example.clsrepro`) para não continuar testando o build anterior.

## Alterar applicationId versus namespace

Esses dois valores respondem a perguntas diferentes, e a maioria dos crashes vem de tratá-los como um só:

- `applicationId` é a identidade no dispositivo e no Google Play. Alterá-lo depois de publicar cria um app diferente do ponto de vista do Play. Ele nunca afeta nomes de classes.
- `namespace` é o pacote das classes geradas `R` e `BuildConfig` e a base de todo nome de classe abreviado no manifest. É uma questão apenas de código.

A documentação do Android recomenda sempre definir o `applicationId` explicitamente, porque, se ele estiver ausente, usa o `namespace` como fallback, e aí uma renomeação no nível do código muda silenciosamente também a sua identidade na loja. O template do Flutter já define os dois. Se tudo o que você quer é um novo bundle ID para uma nova listagem na loja, altere o `applicationId` e mais nada: essa é a única renomeação da tabela acima que não consegue produzir este crash.

Também há um custo em renomear a própria classe da activity depois de publicar. A documentação de `<activity>` diz para não alterar o `android:name` de uma activity exportada depois que o app for publicado. A `MainActivity` do Flutter é exportada, e atalhos de launcher e ícones fixados nas telas iniciais dos usuários referenciam o componente pelo nome da classe. Se você precisar movê-la, um `<activity-alias>` com o nome antigo apontando para a nova classe mantém os atalhos existentes funcionando.

## Builds de release e R8

Um palpite comum é que o R8 removeu a `MainActivity` em um build de release. Ele não remove, desde que o manifest a cite. Durante o processamento de recursos, o AAPT2 escreve uma regra keep para cada componente que encontra no manifest. No meu build de release, `build/app/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt` continha:

```text
-keep class com.example.clsrepro.MainActivity { <init>(); }
```

e o `mapping.txt` mapeava a classe para ela mesma, sem renomeação. O APK de release iniciou normalmente. Então, se um build de release falha com este erro enquanto o debug funciona, procure uma diferença entre as variantes (um manifest só de release em `src/release/`, um source set de flavor) antes de começar a escrever regras do ProGuard. Uma classe que o R8 realmente remove é uma que você só alcança por reflection e nunca cita em um manifest, e isso normalmente aparece mais tarde como uma `ClassNotFoundException` para aquela classe, não para a `MainActivity`.

## Erros parecidos

- **Um erro de build sobre `io.flutter.app.FlutterActivity` ou `FlutterApplication`**: um app ainda no embedding Android v1. Isso é um problema de migração, tratado no [checklist de migração do Flutter 2 para o 3.x](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).
- **O build falha antes de existir um APK** (erros do daemon do Kotlin ou do Gradle): você nunca chega a iniciar o app. Veja [Daemon compilation failed: null](/pt-br/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/) e [Timeout waiting to lock journal cache](/pt-br/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/).
- **`MissingPluginException` em um method channel**: a activity iniciou bem, mas um handler foi registrado no lugar errado. O padrão de registro do channel está em [como adicionar código específico de plataforma sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Relacionados

- [Migrar um projeto Flutter Android para o AGP 9 com Kotlin embutido](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), incluindo como confirmar que a sua `MainActivity` chegou ao dex depois da migração.
- [Correção: e: Daemon compilation failed: null em um build Gradle Flutter Android](/pt-br/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Como adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Correção: Timeout waiting to lock journal cache em um build Flutter Android](/pt-br/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Fontes

- [Configure the app module: namespace and application ID](https://developer.android.com/build/configure-app-module), Android Developers.
- [Elemento `<activity>`, `android:name`](https://developer.android.com/guide/topics/manifest/activity-element#nm), Android Developers.
- [Set the application ID](https://developer.android.com/build/configure-app-module#set-application-id), Android Developers.
- [Shrink, obfuscate, and optimize your app](https://developer.android.com/build/shrink-code), Android Developers.
- [Build and release an Android app](https://docs.flutter.dev/deployment/android), documentação do Flutter.
