---
title: "Fix: o login do Firebase Auth não persiste em um build release do Flutter para Android"
description: "O Firebase Auth restaura a sessão do Android a partir de um arquivo SharedPreferences privado sem nenhuma chamada de rede, então um logout que só acontece em release nunca é falha de persistência. É outro google-services.json, uma renovação de token rejeitada, o App Check ou o seu próprio bloco catch."
pubDate: 2026-08-31
template: how-to
tags:
  - "errors"
  - "flutter"
  - "android"
  - "firebase"
  - "dart"
lang: "pt-br"
translationOf: "2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build"
translatedBy: "claude"
translationDate: 2026-08-31
---

Você faz login, encerra o app, abre de novo e o usuário sumiu. Só em release. Em debug a sessão sobrevive a todo reinício. O que você precisa saber antes de mexer em qualquer coisa é que o Firebase Auth no Android restaura o usuário autenticado de um arquivo `SharedPreferences` privado sem nenhuma chamada de rede, então "a persistência quebrou em release" quase nunca é o que está acontecendo. Ou o build release está abrindo outro arquivo de armazenamento, ou algo apagou esse armazenamento: uma renovação de token que voltou rejeitada em vez de apenas falhar, o App Check aplicando regras que só confiam no seu certificado de depuração, ou o seu próprio código de inicialização chamando `signOut()` dentro de um bloco catch. Isto foi verificado com `firebase_auth` 6.6.1 e `firebase_core` 4.14.0 no Flutter 3.47.1 com Dart 3.13.1, resolvendo `com.google.firebase:firebase-auth:24.2.0` no Android.

## Onde a sessão do Android realmente fica

O plugin do Flutter não implementa a persistência. Ele repassa para o SDK do Android, e o SDK do Android grava o usuário em um arquivo `SharedPreferences`. No `firebase-auth` 24.2.0 o armazenamento é `com.google.firebase.auth.internal.zzce`, cujo construtor se resolve assim:

```java
// Decompiled from com.google.firebase:firebase-auth:24.2.0
// zzce(Context, String persistenceKey)
this.zzc = context.getSharedPreferences(
    String.format("com.google.firebase.auth.api.Store.%s", persistenceKey),
    Context.MODE_PRIVATE);
```

A chave de persistência vem de `FirebaseApp.getPersistenceKey()`, que são dois valores base64 seguros para URL unidos por um sinal de mais:

```java
// com.google.firebase:firebase-common
// getPersistenceKey() == base64Url(appName) + "+" + base64Url(options.getApplicationId())
```

Para o app padrão, `[DEFAULT]` é codificado como `W0RFRkFVTFRd`, então um caminho real no dispositivo fica assim:

```
/data/data/<applicationId>/shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+<base64url of mobilesdk_app_id>.xml
```

Dois fatos saem desse construtor, e eles conduzem toda a investigação. Primeiro, restaurar o usuário é uma leitura de disco. O construtor de `FirebaseAuth` cria o `zzce` e tira dali o usuário armazenado, então um dispositivo sem rede continua abrindo com a sessão ativa. Segundo, o nome do arquivo é derivado do ID do app do Google presente no seu `google-services.json`. Mude esse valor entre variantes e você não perdeu uma sessão: você parou de abrir o arquivo em que ela foi escrita.

## Por que `currentUser` não tem condição de corrida no Android

Existe uma afirmação muito repetida de que `FirebaseAuth.instance.currentUser` fica null por um instante depois da inicialização e você precisa esperar por `authStateChanges()`. Isso é verdade na web e nos embedders de desktop. Não é verdade no Android, e saber disso evita que você "conserte" uma condição de corrida que não existe.

O plugin Android publica o usuário restaurado como constante do plugin durante `Firebase.initializeApp()`:

```kotlin
// firebase_auth 6.6.1, android/.../FlutterFirebaseAuthPlugin.kt
override fun getPluginConstantsForFirebaseApp(
    firebaseApp: FirebaseApp?
): Task<MutableMap<String, Any>> {
  // ...
  val firebaseAuth = FirebaseAuth.getInstance(firebaseApp!!)
  val firebaseUser = firebaseAuth.currentUser
  val user = PigeonParser.parseFirebaseUser(firebaseUser)
  if (user != null) {
    constants["APP_CURRENT_USER"] = PigeonParser.manuallyToList(user)
  }
  // ...
}
```

Essas constantes alimentam `MethodChannelFirebaseAuth.setInitialValues`, e os streams reemitem esse valor antes que qualquer coisa chegue pelo canal de eventos nativo:

```dart
// firebase_auth_platform_interface, method_channel_firebase_auth.dart
@override
Stream<UserPlatform?> authStateChanges() async* {
  yield currentUser;
  yield* _authStateChangesListeners[app.name]!.stream.map((event) => event.value);
}
```

Ou seja, no Android, assim que `await Firebase.initializeApp()` retorna, `currentUser` já está correto e o primeiro evento de `authStateChanges()` é esse mesmo valor. Se ele é null em release, o armazenamento estava mesmo vazio. Trocar `currentUser` por um `StreamBuilder` não muda a resposta, embora continue sendo o formato certo para um portão de autenticação por outros motivos, algo que vale a pena ler junto com [as diferenças entre StreamBuilder e o AsyncValue do Riverpod](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

## Passos de diagnóstico que isolam a causa

Execute na ordem. Cada um elimina uma classe inteira de explicação, e os dois primeiros levam uns cinco minutos.

1. **Torne o build release depurável para conseguir inspecioná-lo.**
   O `adb shell run-as` se recusa a tocar em um pacote que não esteja marcado como depurável, e é por isso que você não consegue ler o armazenamento de um APK release normal. Adicione um build type descartável em `android/app/build.gradle.kts`, compile e apague quando terminar.

   ```kotlin
   // android/app/build.gradle.kts, temporary
   buildTypes {
       create("releaseProbe") {
           initWith(getByName("release"))
           isDebuggable = true
           matchingFallbacks += listOf("release")
       }
   }
   ```

2. **Confirme se o arquivo de armazenamento existe e qual deles é.**
   Faça login, force a parada e liste o diretório de preferências do app. Se o arquivo está lá e não está vazio mas o app continua abrindo deslogado, você tem um problema de código, não de armazenamento. Se o arquivo sumiu, algo o apagou.

   ```bash
   adb shell run-as com.example.app ls -l shared_prefs/
   adb shell run-as com.example.app cat 'shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+...xml'
   ```

3. **Compare o ID do app do Google que cada variante realmente compila.**
   O plugin Gradle `google-services` grava os valores lidos em um arquivo de recursos gerado por variante. Compare os dois. Uma diferença aqui explica o sintoma por completo e nada mais precisa ser investigado.

   ```bash
   grep google_app_id android/app/build/generated/res/google-services/debug/values/values.xml
   grep google_app_id android/app/build/generated/res/google-services/release/values/values.xml
   ```

4. **Descarte o R8 com o relatório de uso em vez de adivinhar.**
   A redução de código está ligada nos builds release do Flutter, então ele é um suspeito legítimo, mas é barato eliminá-lo. Adicione `-printusage build/r8-usage.txt` ao `android/app/proguard-rules.pro`, recompile e procure `com.google.firebase.auth` no relatório.

5. **Observe a renovação do token.**
   Ative o log detalhado do Firebase Auth e inicie o app a frio com a rede ligada. Uma renovação que falha com erro de transporte deixa a sessão intacta. Uma renovação rejeitada é a que a apaga.

   ```bash
   adb shell setprop log.tag.FirebaseAuth VERBOSE
   adb logcat -s FirebaseAuth:V FirebaseApp:V
   ```

6. **Verifique as impressões digitais de certificado registradas no projeto.**
   Imprima as impressões com que a sua variante release está realmente assinada e compare com as configurações do projeto no Firebase, as restrições da chave de API no Google Cloud e a página de App Signing do Play Console.

   ```bash
   cd android && ./gradlew signingReport
   ```

## Causa 1: a variante release lê outro `google-services.json`

Esta é a resposta mais comum e a mais fácil de passar batido, porque nada nela parece um problema de autenticação.

Os source sets do Android permitem colocar um `google-services.json` em `android/app/src/debug/`, `android/app/src/prod/` ou em qualquer diretório de flavor, e o plugin Gradle escolhe o mais específico para a variante em construção. A CLI do FlutterFire incentiva o mesmo arranjo com `--android-out`. Se a sua variante debug resolve um arquivo de um projeto Firebase de desenvolvimento e a sua variante release resolve um de produção, então `options.getApplicationId()` difere, a chave de persistência difere e o nome do arquivo de armazenamento difere.

A consequência é precisa: uma sessão escrita por uma variante é invisível para a outra, e uma sessão escrita pela variante release antes de você trocar a configuração dela é invisível depois. O passo 3 acima pega isso com um único comando. A correção não é código: é garantir que a variante que você publica faz login e lê de volta contra o mesmo projeto sempre, e que quem testa saiba que trocar a configuração equivale a um logout.

Um `applicationIdSuffix` em debug produz uma situação parecida, porém mais simples: duas instalações separadas com sandboxes separados. Esse é o comportamento esperado e normalmente não é o que as pessoas relatam.

## Causa 2: o R8 está ligado em release, mas a configuração de fábrica é segura

O Flutter liga a redução de código para builds release por conta própria. Do plugin Gradle do Flutter, verificado contra um SDK local 3.44.8 onde essa lógica não mudou desde a 3.44:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt
if (FlutterPluginUtils.shouldShrinkResources(project)) {
    val releaseBuildType: BuildType = ...buildTypes.getByName("release")
    releaseBuildType.isMinifyEnabled = true
    releaseBuildType.isShrinkResources = FlutterPluginUtils.isBuiltAsApp(project)
    releaseBuildType.proguardFiles.add(...getDefaultProguardFile("proguard-android-optimize.txt"))
    releaseBuildType.proguardFiles.add(flutterProguardRules)
    // plus android/app/proguard-rules.pro if it exists
}
```

`shouldShrinkResources` retorna true a menos que a propriedade Gradle `shrink` seja explicitamente false, e a opção de linha de comando `--shrink` hoje é um no-op documentado: o texto de ajuda dela diz "This flag has no effect. Code shrinking is always enabled in release builds." Então sim, o R8 roda no seu build release independentemente do que o seu `build.gradle.kts` diga.

Ainda assim, isso não faz do R8 o culpado provável, porque o `firebase-auth` traz regras de consumidor que o AGP aplica automaticamente. O `proguard.txt` inteiro dentro do AAR 24.2.0 é:

```proguard
-keepclassmembers class * extends com.google.android.gms.internal.firebase-auth-api.zzalt {
  <fields>;
}
-dontwarn rx.**
-dontwarn android.crypto.hpke.**
```

Recorra ao passo 4 em vez de adicionar regras especulativas como `-keep class com.google.firebase.** { *; }`. Uma regra de keep genérica esconde a pergunta em vez de respondê-la, e se o relatório de uso mostrar que nada de `com.google.firebase.auth` foi removido, você eliminou esse ramo de vez.

## Causa 3: a renovação é rejeitada, e só em release

Numa inicialização a frio o SDK restaura o usuário do disco e depois renova o ID token, que vive uma hora, contra `securetoken.googleapis.com`. O SDK trata de forma diferente uma falha de transporte e uma rejeição. Uma falha de transporte deixa o usuário armazenado no lugar, e é por isso que um dispositivo offline continua logado. Uma rejeição que traz um código definitivo da tabela de erros do SDK, valores como `TOKEN_EXPIRED`, `USER_DISABLED` e `USER_NOT_FOUND`, apaga o usuário armazenado e dispara o listener de estado de autenticação com null. É por isso que o sintoma é um logout limpo e não um travamento.

Duas configurações transformam uma renovação que funciona em uma rejeitada apenas para builds release.

**Restrições da chave de API limitadas ao certificado de depuração.** Se a chave de API do Firebase tem uma restrição de aplicativo do tipo Android apps, toda requisição precisa apresentar um nome de pacote e uma impressão digital SHA-1 de certificado que estejam na lista. Uma chave restrita ao SHA-1 do keystore de depuração funciona perfeitamente com `flutter run` e retorna `403 PERMISSION_DENIED` com "Requests from this Android client application are blocked" assim que o app é assinado para release. Existe uma segunda variante, mais desagradável. O Firebase documenta que o Authentication precisa de duas APIs na lista de permissões de restrições de API da chave: a Identity Toolkit API (`identitytoolkit.googleapis.com`) e a Token Service API (`securetoken.googleapis.com`). Libere só a primeira e você obtém exatamente o quadro relatado: o login funciona, e a renovação da próxima abertura não.

**Aplicação do App Check.** Se o App Check está sendo aplicado ao Authentication, o cliente precisa anexar um token de atestação. A configuração comum no Flutter troca de provedor conforme o modo de build:

```dart
// firebase_app_check, called after Firebase.initializeApp()
await FirebaseAppCheck.instance.activate(
  androidProvider: kDebugMode ? AndroidProvider.debug : AndroidProvider.playIntegrity,
);
```

O provedor de depuração é registrado à mão no console do Firebase e sempre funciona para você. O Play Integrity precisa da impressão digital SHA-256 do certificado com que o app instalado está de fato assinado, e se você usa o Play App Signing essa é a chave do Google, não a sua chave de upload. Se ela faltar, o App Check falha só em produção. O Firebase também observa que builds não distribuídos pelo Google Play não conseguem obter o veredito `PLAY_RECOGNIZED`, então um APK release distribuído internamente precisa da configuração avançada correspondente relaxada, ou vai falhar na atestação em um aparelho perfeitamente saudável.

Os dois são problemas de impressão digital, e a mesma armadilha pega as pessoas duas vezes: `flutter run --release` assina com a configuração de depuração, porque o próprio template do Flutter faz isso de propósito. O comentário no `android/app/build.gradle.kts` gerado diz isso: "Signing with the debug keys for now, so `flutter run --release` works." Um build release que funciona na sua máquina e falha vindo do Play é uma diferença de impressão digital, não de modo de build.

## Causa 4: o seu próprio código faz o logout

Uma vez que o armazenamento, a configuração e as impressões digitais estão em ordem, a possibilidade restante é que o app tenha feito isso. O formato usual é uma chamada de inicialização que troca o ID token do Firebase por uma sessão no seu próprio backend:

```dart
// The bug: any failure is treated as an invalid session.
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} catch (_) {
  await FirebaseAuth.instance.signOut(); // wipes a perfectly good session
}
```

Em debug esse bloco catch nunca roda. Em release, uma rejeição do App Check ou da chave de API cai ali e o usuário é deslogado pelo seu próprio código, o que persiste porque o armazenamento realmente fica vazio para a próxima abertura. Separe os casos pelo código:

```dart
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} on FirebaseAuthException catch (e) {
  const fatal = {'user-token-expired', 'user-disabled', 'user-not-found', 'invalid-user-token'};
  if (fatal.contains(e.code)) {
    await FirebaseAuth.instance.signOut();
  } else {
    // network-request-failed, too-many-requests, and anything unexpected:
    // keep the session and retry later.
  }
}
```

Proteger esse caminho também significa que você não sai da shell enquanto uma chamada assíncrona ainda está em voo, que é a mesma disciplina de [cancelar assinaturas de stream no dispose](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Pegadinhas que parecem isto mas não são

**A resposta da permissão INTERNET faltando está errada para o Firebase Auth.** O template `src/main/AndroidManifest.xml` do Flutter não declara nenhuma permissão, enquanto os manifests gerados em `src/debug/` e `src/profile/` declaram `android.permission.INTERNET`, com o comentário de que a ferramenta precisa dela para o hot reload. Isso realmente quebra chamadas simples com `http` ou `dio` em builds release. Não quebra o Firebase Auth, porque o manifest da biblioteca `firebase-auth` 24.2.0 declara a permissão por conta própria e o mesclador de manifests a incorpora ao seu APK:

```xml
<!-- com.google.firebase:firebase-auth:24.2.0, AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

Confirme no seu próprio build em vez de acreditar em qualquer uma das duas afirmações: `build/app/outputs/logs/manifest-merger-release-report.txt` registra qual biblioteca contribuiu com cada nó.

**O Android Auto Backup pode entregar a um aparelho uma sessão obsoleta.** `android:allowBackup` é true por padrão e arquivos `SharedPreferences` são incluídos, então o armazenamento de autenticação viaja pelo backup em nuvem e pela transferência entre aparelhos. Nem o template do Flutter nem o manifest do `firebase-auth` o excluem. Se os seus relatos se concentram em aparelhos novos restaurados de um backup, exclua explicitamente:

```xml
<!-- android/app/src/main/res/xml/data_extraction_rules.xml, API 31+ -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="sharedpref" />
  </device-transfer>
</data-extraction-rules>
```

**Desinstalar apaga o armazenamento, e limpar os dados do app também.** O Firebase documenta isso como a única forma suportada de zerar a persistência nativa. Um testador que instala um APK novo por cima de uma desinstalação não está reproduzindo o seu bug.

## Relacionado

Se você está resolvendo problemas de release no Android e de Firebase em um app Flutter, estes cobrem as falhas vizinhas: a [migração para o singleton do `google_sign_in` 7.x](/pt-br/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) que muda como você obtém credenciais antes de entregá-las ao Firebase Auth, o [problema de ordem do token APNs](/pt-br/2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios/) que produz o mesmo quadro de "funciona em debug, silêncio em release" no iOS, a [rejeição por tamanho de página de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) que bloqueia o próprio envio do release, e a [mudança de layout edge-to-edge ao mirar o SDK 35](/pt-br/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) que chega na mesma janela de atualização.

## Fontes

- [Get Started with Firebase Authentication on Flutter](https://firebase.google.com/docs/auth/flutter/start) - a afirmação de que a persistência nativa não é configurável, e a diferença entre `authStateChanges`, `idTokenChanges` e `userChanges`.
- [Learn about and manage API keys for Firebase](https://firebase.google.com/docs/projects/api-keys) - o Authentication exige tanto a Identity Toolkit API quanto a Token Service API na lista de permissões de uma chave de API.
- [Get started using App Check with Play Integrity on Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider) - a exigência de registrar o SHA-256 e a ressalva do `PLAY_RECOGNIZED` para builds distribuídos fora do Google Play.
- [flutterfire issue #12727](https://github.com/firebase/flutterfire/issues/12727) - o 403 "Requests from this Android client application are blocked" produzido pelas restrições de aplicativo Android na chave de API.
- `com.google.firebase:firebase-auth:24.2.0` - `com/google/firebase/auth/internal/zzce` para o nome do armazenamento `SharedPreferences`, `com/google/firebase/auth/internal/zzaq` para a tabela de códigos de erro do servidor, e o `proguard.txt` e o `AndroidManifest.xml` incluídos.
- `firebase_auth` 6.6.1 - `android/.../FlutterFirebaseAuthPlugin.kt` para `getPluginConstantsForFirebaseApp`, e `firebase_auth_platform_interface` `method_channel_firebase_auth.dart` para os streams que reemitem `currentUser`.
- Flutter SDK 3.44.8 - `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt` para os padrões de redução em release, `runner/flutter_command.dart` para a opção no-op `--shrink`, e os templates de manifest e Gradle do `android.tmpl`.
