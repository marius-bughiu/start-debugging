---
title: "Correção: [firebase_messaging/apns-token-not-set] APNS token has not been set no Flutter iOS"
description: "getToken() roda antes de o APNs entregar o token do dispositivo ao iOS. Consulte getAPNSToken() até retornar um valor não nulo e depois chame getToken()."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "firebase"
  - "dart"
lang: "pt-br"
translationOf: "2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios"
translatedBy: "claude"
translationDate: 2026-08-21
---

Você chamou `FirebaseMessaging.instance.getToken()` antes de o APNs entregar o token do dispositivo ao iOS, e o plugin se recusa a continuar. Consulte `getAPNSToken()` em um laço até que ele retorne um valor não nulo e então chame `getToken()`. Se continuar nulo após dez segundos, você tem um problema de configuração, não uma condição de corrida: falta a capacidade Push Notifications, a inicialização automática está desativada ou você está em um simulador que não consegue se registrar. Isto foi verificado com `firebase_messaging` 16.5.0 e `firebase_core` 4.13.0 no Flutter 3.44.2.

## O erro em contexto

As versões atuais do plugin lançam isto:

```
[firebase_messaging/apns-token-not-set] APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.
```

Versões mais antigas usavam outra redação, e é por isso que os resultados de busca para esse problema estão divididos entre duas strings:

```
[firebase_messaging/apns-token-not-set] APNS token has not been set yet. Please ensure the APNS token is available by calling `getAPNSToken()`.
```

As duas são a mesma `FirebaseException`, as duas carregam `code: 'apns-token-not-set'` e as duas vêm do mesmo lugar. A mensagem engana de um jeito bem específico: ela manda chamar `getAPNSToken()`, mas `getAPNSToken()` é exatamente o que acabou de falhar. O que ela quer dizer é "espere até que `getAPNSToken()` retorne alguma coisa".

## Por que o token está faltando quando getToken roda

A verificação vive no Dart, não no código nativo. No `firebase_messaging_platform_interface` 4.9.3, o arquivo `method_channel_messaging.dart` define uma guarda privada:

```dart
// firebase_messaging_platform_interface 4.9.3
Future<void> _APNSTokenCheck() async {
  if (defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.iOS) {
    String? token = await getAPNSToken();

    if (token == null) {
      throw FirebaseException(
        plugin: 'firebase_messaging',
        code: 'apns-token-not-set',
        message:
            'APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.',
      );
    }
  }
}
```

No lado nativo, `getAPNSToken` é uma leitura direta, sem espera e sem nova tentativa:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)messagingGetAPNSToken:(id)arguments
         withMethodCallResult:(FLTFirebaseMethodCallResult *)result {
  NSData *apnsToken = [FIRMessaging messaging].APNSToken;
  if (apnsToken) {
    result.success(@{@"token" : [FLTFirebaseMessagingPlugin APNSTokenFromNSData:apnsToken]});
  } else {
    result.success(@{@"token" : [NSNull null]});
  }
}
```

Esse é todo o mecanismo. `FIRMessaging.APNSToken` fica nil até o iOS chamar `application:didRegisterForRemoteNotificationsWithDeviceToken:`, e esse callback dispara no tempo da Apple, depois de uma ida e volta de rede até o APNs. Normalmente chega um ou dois segundos após a inicialização, mas nada no seu aplicativo controla quando. A própria documentação do Firebase enuncia a restrição sem rodeios: no SDK do iOS 10.4.0 e superior, o token do APNs precisa estar disponível antes de você fazer requisições à API.

Ou seja, o erro não é "alguma coisa quebrou". No caso comum, ele é "você perguntou cedo demais".

## Quais chamadas realmente aplicam a verificação

Exatamente quatro métodos aguardam `_APNSTokenCheck()` na 4.9.3: `deleteToken()`, `getToken()`, `subscribeToTopic()` e `unsubscribeFromTopic()`. Todo o resto, incluindo `requestPermission()`, `getInitialMessage()` e o stream `onMessage`, roda sem ela.

Isso explica um padrão relatado que de outro modo parece contraditório: os pedidos de permissão aparecem normalmente e as mensagens em primeiro plano chegam, mas `subscribeToTopic()` lança a exceção. A inscrição em tópicos passa pela guarda; a entrega de mensagens não.

O próprio `getAPNSToken()` não passa pela guarda. Ele retorna nulo em vez de lançar exceção, e é isso que torna seguro consultá-lo em laço.

## Como é uma reprodução mínima?

Qualquer aplicativo que busque o token durante a inicialização vai esbarrar nisso em um início a frio:

```dart
// Flutter 3.44.2, firebase_core 4.13.0, firebase_messaging 16.5.0
Future<String?> brokenRegisterForPush() async {
  await Firebase.initializeApp();
  return FirebaseMessaging.instance.getToken();
}
```

Ele falha de forma intermitente, que é a pior característica desse bug. Em um início a quente, ou em um aparelho que já se registrou recentemente, o token costuma já estar em cache dentro do `FIRMessaging` e a chamada funciona. Em uma instalação limpa, com rede lenta ou na primeira execução depois de reinstalar o aplicativo, ele falha. Teste em uma instalação limpa antes de concluir que resolveu.

## Como esperar o token do APNs antes de chamar getToken?

Não existe callback nem stream para "o token do APNs já está disponível", então consultar em laço é a abordagem suportada. Este helper passa na análise limpa com `firebase_messaging` 16.5.0:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// Polls `getAPNSToken()` until APNs hands the token to the Firebase iOS SDK.
/// Returns null on non-Apple platforms and on timeout.
Future<String?> waitForAPNSToken({
  Duration timeout = const Duration(seconds: 10),
  Duration interval = const Duration(milliseconds: 250),
}) async {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.iOS &&
          defaultTargetPlatform != TargetPlatform.macOS)) {
    return null;
  }

  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < timeout) {
    final token = await FirebaseMessaging.instance.getAPNSToken();
    if (token != null) return token;
    await Future<void>.delayed(interval);
  }
  return null;
}
```

O retorno nulo no Android e na web importa. Se você escrever a guarda como um simples laço `while (token == null)` sem a verificação de plataforma, `getAPNSToken()` retorna nulo para sempre no Android e você gira em falso até estourar o tempo em toda inicialização no Android. A implementação da platform interface faz curto-circuito para nulo em qualquer plataforma que não seja da Apple antes mesmo de tocar no method channel.

Ligue isso ao registro:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPush() async {
  await Firebase.initializeApp();

  final messaging = FirebaseMessaging.instance;
  await messaging.setAutoInitEnabled(true);

  final settings = await messaging.requestPermission();
  debugPrint('authorizationStatus: ${settings.authorizationStatus}');

  final apnsToken = await waitForAPNSToken();
  if (apnsToken == null && !kIsWeb) {
    debugPrint('No APNs token: check Push Notifications capability.');
    return null;
  }

  return messaging.getToken();
}
```

Faça o mesmo antes das chamadas de tópico, já que elas também passam pela guarda:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<void> subscribeSafely(String topic) async {
  await waitForAPNSToken();
  await FirebaseMessaging.instance.subscribeToTopic(topic);
}
```

Se você preferir não reestruturar o código de inicialização existente, capture a exceção e tente de novo uma vez. Isso é estritamente pior do que esperar de antemão, porque queima uma ida e volta fracassada primeiro, mas é um diff pequeno:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPushHandled() async {
  try {
    return await FirebaseMessaging.instance.getToken();
  } on FirebaseException catch (e) {
    if (e.code == 'apns-token-not-set') {
      final token = await waitForAPNSToken();
      if (token == null) return null;
      return FirebaseMessaging.instance.getToken();
    }
    rethrow;
  }
}
```

Note que permissão é uma questão separada da disponibilidade do token. Registrar-se para notificações remotas é o que produz o token de dispositivo do APNs, e o plugin faz isso durante o registro, não em resposta ao pedido de permissão. Um usuário que recuse o aviso de notificação ainda pode ter um token do APNs válido, e é isso que faz o push silencioso em segundo plano funcionar.

## O que acontece quando a inicialização automática está desativada?

Esta é a causa que passa despercebida, e vale entendê-la porque o sintoma é um token que nunca chega, não importa quanto você espere no laço.

Se `FirebaseMessagingAutoInitEnabled` estiver como `NO` no seu `Info.plist`, ou se você chamou `setAutoInitEnabled(false)` e isso ficou persistido, o plugin nem se registra para notificações remotas na inicialização:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
if ([FIRMessaging messaging].isAutoInitEnabled) {
  [self registerForRemoteNotifications];
}
```

E mesmo que outra parte do seu aplicativo se registre, o callback do delegate guarda o token e retorna sem entregá-lo ao `FIRMessaging`:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)application:(UIApplication *)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken {
  FIRMessaging *messaging = [FIRMessaging messaging];
  if (!messaging.isAutoInitEnabled) {
    _apnsToken = deviceToken;
    return;
  }
  // ... setAPNSToken happens only past this point
}
```

`FIRMessaging.APNSToken` continua nil, então `getAPNSToken()` segue retornando nulo e seu laço estoura o tempo, mesmo que o iOS tenha dado com sucesso um token de dispositivo ao aplicativo.

O caminho de recuperação existe, mas você precisa acioná-lo. `setAutoInitEnabled(true)` chama `registerForRemoteNotifications` e depois descarrega o token guardado, e essa descarga também roda no início de toda chamada de método que o plugin atende:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)ensureAPNSTokenSetting {
  FIRMessaging *messaging = [FIRMessaging messaging];

  if (messaging.isAutoInitEnabled && messaging.APNSToken == nil && _apnsToken != nil) {
    [messaging setAPNSToken:_apnsToken type:FIRMessagingAPNSTokenTypeSandbox];
    _apnsToken = nil;
  }
}
```

Se você atrasa o registro do FCM de propósito por questões de consentimento, tudo bem, mas `await messaging.setAutoInitEnabled(true)` precisa vir antes de você esperar pelo token. É por isso que ele aparece em `registerForPush()` acima.

## O que checar quando o token nunca chega

Percorra esta lista na ordem. Os dois primeiros itens respondem pela maioria dos casos em que o laço estoura o tempo em um aparelho físico.

1. **Capacidade Push Notifications.** No Xcode, abra o target Runner, vá em Signing and Capabilities e confirme que Push Notifications está listada. Sem ela o aplicativo não tem o entitlement `aps-environment`, `registerForRemoteNotifications` falha e o iOS chama `didFailToRegisterForRemoteNotificationsWithError:` no lugar. O plugin registra esse erro com `NSLog` e nada mais, então é fácil não perceber. Verifique no console do Xcode se há uma linha dizendo que o aplicativo não tem direito a push.
2. **Background Modes.** Ative Background fetch e Remote notifications. O guia de configuração do FlutterFire exige os dois, e o APNs é necessário tanto para mensagens em primeiro plano quanto em segundo plano.
3. **Chave do APNs enviada ao Firebase.** Firebase Console, Project Settings, aba Cloud Messaging. Pelo menos uma chave é obrigatória. Uma chave faltando não bloqueia o token do APNs em si, mas quebra tudo que vem depois, então resolva já que você está aí.
4. **Method swizzling.** O guia de cliente do Firebase para Flutter é explícito ao dizer que o swizzling é obrigatório e que sem ele o gerenciamento do token do FCM não vai funcionar. Se você colocou `FirebaseAppDelegateProxyEnabled` como `NO` no `Info.plist`, precisa encaminhar os callbacks do delegate do APNs por conta própria. A correção mais simples é remover essa chave.
5. **Bundle ID divergente.** O identificador do pacote no Xcode precisa bater com o do `GoogleService-Info.plist`. Uma divergência aqui produz falhas confusas mais adiante, em vez de um erro claro.

## O simulador do iOS fornece um token do APNs?

Às vezes, e as condições são restritas o bastante para valer a pena enunciá-las com exatidão. O simulador suporta notificações remotas reais e tokens de dispositivo reais apenas no iOS 16 e posteriores, rodando em macOS 13 ou posterior, em um Mac com Apple silicon ou chip T2. Os tokens são únicos para a combinação daquele simulador com aquele Mac, e o simulador se registra no ambiente sandbox do APNs.

Fora dessa combinação, o simulador não consegue se registrar para notificações remotas, `getAPNSToken()` retorna nulo para sempre e nenhuma configuração resolve. Antes do Xcode 14, nenhum simulador conseguia produzir um token de dispositivo. Se você está caçando esse erro em um simulador antigo, em um Mac Intel ou em um runtime do iOS 15, mude para um aparelho físico antes de alterar qualquer código.

## Pegadinhas e casos parecidos

**Tipo de token sandbox versus produção.** O plugin escolhe o tipo de token do APNs a partir da macro de pré-processador `DEBUG` em tempo de compilação, usando `FIRMessagingAPNSTokenTypeSandbox` em builds de depuração e `FIRMessagingAPNSTokenTypeProd` nos demais. Isso nunca causa `apns-token-not-set`, mas causa o clássico relato de "funciona em debug, silêncio no TestFlight". Se as notificações pararem de chegar em um build de release, é aí que você deve olhar, não aqui.

**Reinstalações invalidam tokens.** Apagar e reinstalar o aplicativo produz um novo token do APNs e um novo token do FCM. Os registros de token no lado do servidor para a instalação anterior estão mortos. Escute `FirebaseMessaging.instance.onTokenRefresh` e reenvie, em vez de buscar uma vez na primeira execução e guardar em cache para sempre.

**`getAPNSToken()` retornar nulo não é esta exceção.** Se você vê um token do APNs nulo mas nenhum erro lançado, você chamou `getAPNSToken()` diretamente. Ele retorna nulo por design; só os quatro métodos com guarda convertem esse nulo em uma `FirebaseException`.

**Um timeout de dez segundos é um palpite, não uma garantia.** Em um aparelho sem rede, o callback simplesmente nunca dispara. Trate o timeout como uma falha suave: retorne nulo, deixe o aplicativo seguir e tente registrar de novo mais tarde, em vez de travar sua tela de abertura para sempre.

## Relacionados

Se você está enfrentando problemas de compilação e integração do iOS em um aplicativo Flutter, estes cobrem as falhas vizinhas: as [falhas de resolução de versões do CocoaPods](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) que aparecem logo depois de adicionar plugins do Firebase, a [quebra da compilação iOS no Xcode 16](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) e suas quatro causas distintas, o [erro de destino não encontrado](/pt-br/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) causado por uma exclusão de arquitetura obsoleta no Podfile, o [crash da VM do Dart em builds de depuração do iOS](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) que nenhum entitlement resolve, e a [migração para o singleton do google_sign_in 7.0](/pt-br/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) se você estiver configurando o Firebase Auth ao mesmo tempo.

## Fontes

- [Configurar um aplicativo cliente do Firebase Cloud Messaging no Flutter](https://firebase.google.com/docs/cloud-messaging/flutter/client) - o requisito do token do APNs a partir do SDK do iOS 10.4.0, e o requisito de method swizzling.
- [Guia de integração com a Apple do FlutterFire](https://firebase.flutter.dev/docs/messaging/apple-integration/) - capacidade Push Notifications, Background Modes, envio da chave do APNs.
- `firebase_messaging_platform_interface` 4.9.3, `lib/src/method_channel/method_channel_messaging.dart` - a guarda `_APNSTokenCheck()` e os quatro métodos que a aguardam.
- `firebase_messaging` 16.5.0, `ios/firebase_messaging/Sources/firebase_messaging/FLTFirebaseMessagingPlugin.m` - `messagingGetAPNSToken`, `ensureAPNSTokenSetting` e a condição de inicialização automática no registro.
- [Issue #10625 do flutterfire](https://github.com/firebase/flutterfire/issues/10625) - a issue que o comentário no código-fonte de `_APNSTokenCheck` cita como a razão de a guarda existir.
- [Suporte a notificações push no simulador com Xcode 14](https://github.com/firebase/firebase-ios-sdk/pull/10503) - a mudança no firebase-ios-sdk que tornou os tokens de dispositivo do simulador utilizáveis.
