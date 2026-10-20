---
title: "Correção: PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10) com Google Sign-In no Flutter"
description: "ApiException: 10 é DEVELOPER_ERROR: o Google não reconhece o nome do pacote mais o SHA-1 do certificado de assinatura do APK instalado. Registre o SHA-1 da chave que realmente assinou o build e passe o ID de cliente Web como serverClientId."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "google-sign-in"
  - "firebase"
lang: "pt-br"
translationOf: "2026/10/fix-platformexception-sign-in-failed-apiexception-10-google-sign-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`ApiException: 10` é `CommonStatusCodes.DEVELOPER_ERROR`: o Google Play services recusou o login porque o par "nome do pacote Android + SHA-1 do certificado que assinou o APK instalado" não corresponde a nenhum cliente OAuth Android do projeto Google Cloud por trás do seu `serverClientId`. Seu código Dart está correto. Execute `./gradlew signingReport` (ou `apksigner verify --print-certs` no APK exato que você instalou), registre esse SHA-1 para esse `applicationId` exato e adicione o SHA-1 do Play App Signing para builds de loja. Depois, confira se `serverClientId` é o ID de cliente **Web**, não o Android. Verificado com `google_sign_in` 6.3.0 (`google_sign_in_android` 6.2.1) e `google_sign_in` 7.2.0 (`google_sign_in_android` 7.2.18, `play-services-auth` 21.6.0, `androidx.credentials` 1.6.0) no Flutter 3.44.8 com AGP 9.0.1.

## O erro completo

No `google_sign_in` 6.x, `GoogleSignIn().signIn()` lança isto no Android:

```
PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10: , null, null)
```

No `google_sign_in` 7.x, a mesma configuração incorreta não chega mais até você como `PlatformException`. O plugin Android 7.x reporta falhas como resultados estruturados e o lado Dart os transforma em uma `GoogleSignInException`. Dependendo da etapa que falha, você vê um destes:

```
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, [28444] Developer console is not set up correctly., null)
GoogleSignInException(code GoogleSignInExceptionCode.canceled, ...)
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, Authorization failed: 10: ..., null)
```

O primeiro vem do Credential Manager durante `authenticate()`. O segundo é o traiçoeiro: o próprio README do plugin avisa que alguns erros de configuração fazem o Credential Manager retornar "canceled" depois que o usuário escolhe uma conta, e o plugin não consegue distinguir isso de um cancelamento real. O terceiro vem de `authorizationClient.authorizeScopes()`, que ainda passa pelo `AuthorizationClient` do Play services e expõe o mesmo código de status 10. Se você migrou do 6.x para o 7.x e o erro "mudou", provavelmente não corrigiu nada, a mesma causa raiz só é reportada de outra forma.

## Por que o Google retorna DEVELOPER_ERROR

Os números são constantes do Play services, não mágica. Extraí os valores dos jars que o Gradle resolveu para esta reprodução:

```bash
# play-services-basement 18.1.0, play-services-auth 21.6.0
javap -constants -cp classes.jar com.google.android.gms.common.api.CommonStatusCodes
#   public static final int DEVELOPER_ERROR = 10;
javap -constants -cp classes.jar com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
#   public static final int SIGN_IN_FAILED = 12500;
#   public static final int SIGN_IN_CANCELLED = 12501;
```

No `google_sign_in_android` 6.2.1, `errorCodeForStatus` mapeia 12501 para `sign_in_canceled`, 4 para `sign_in_required`, 7 para `network_error`, e deixa todo o resto, incluindo o 10, cair em `sign_in_failed` com `e.toString()` como mensagem. É por isso que a string que você pesquisa sempre carrega o nome totalmente qualificado da classe `ApiException`.

O que DEVELOPER_ERROR significa na prática: o Google identifica um app Android pelo nome do pacote e pela impressão digital SHA-1 do seu certificado de assinatura, como descrito no guia [Authenticating Your Client](https://developers.google.com/android/guides/client-auth) do Google. Quando o app pede um ID token para um ID de cliente Web, o Google procura um cliente OAuth Android no **mesmo projeto** com esse nome de pacote e essa impressão digital. Sem correspondência, erro 10. Em ordem de frequência com que vejo, as causas são:

1. **O SHA-1 da chave que assinou este build não está registrado.** Normalmente a chave de release ou a chave do Play App Signing, às vezes a chave de debug em outra máquina ou no CI.
2. **O nome do pacote não corresponde.** Um flavor com `applicationIdSuffix` instala `com.example.app.dev`, mas só `com.example.app` está registrado.
3. **O ID de cliente errado é passado como `serverClientId`.** O ID de cliente Android em vez do Web, ou um cliente Web de outro projeto Google Cloud.
4. **Um `google-services.json` desatualizado** sem entrada de cliente OAuth Web, de modo que o plugin não encontra nada ou pega o `default_web_client_id` errado.

## Reprodução mínima

A configuração mais simples que produz o erro é um lado Dart correto com um projeto Google Cloud que não conhece a chave de assinatura. Este é o código do 7.x. Nada aqui está errado, e esse é o ponto:

```dart
// Flutter 3.44.8, google_sign_in 7.2.0 (google_sign_in_android 7.2.18)
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

// Web OAuth client ID (client_type 3), NOT the Android one.
const String kWebClientId = '1234567890-abc.apps.googleusercontent.com';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await GoogleSignIn.instance.initialize(serverClientId: kWebClientId);
  runApp(const MaterialApp(home: SignInPage()));
}

class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  Future<void> _signIn() async {
    try {
      final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
      debugPrint('Signed in as ${user.email}');
    } on GoogleSignInException catch (e) {
      // e.code is a GoogleSignInExceptionCode, e.description holds the
      // platform message, for example "[28444] Developer console is not set up correctly".
      debugPrint('Google Sign-In failed: ${e.code.name} / ${e.description}');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: FilledButton(onPressed: _signIn, child: const Text('Sign in')),
        ),
      );
}
```

O projeto ao redor é o template padrão do `flutter create` com uma mudança que a maioria dos apps reais tem: um flavor `dev` com `applicationIdSuffix = ".dev"` e um build de release assinado por um keystore de upload. Registre apenas o SHA-1 de debug para o pacote base, e toda variante exceto `prodDebug` falha com o erro 10. Não executei um login real contra um projeto Google Cloud para este post (isso exige uma conta real em um celular com Play habilitado); a saída de build, assinatura e nome de pacote abaixo foi medida neste projeto exato.

## Correção 1: registre o SHA-1 da chave que realmente assinou o build

Não adivinhe qual é a chave. Pergunte ao Gradle. A partir da pasta `android/` do projeto Flutter:

```bash
# Flutter 3.44.8, AGP 9.0.1, OpenJDK 17
cd android
./gradlew signingReport
```

A saída lista cada variante com seu keystore e suas impressões digitais. No projeto da reprodução, resumida:

```
Variant: devDebug
Config: debug
Store: /Users/<you>/.android/debug.keystore
SHA1: <debug-sha1>
Variant: devRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
Variant: prodRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
```

Duas coisas a tirar daqui. Primeiro, debug e release são chaves diferentes, então precisam de duas impressões digitais. Segundo, o keystore de debug fica em `~/.android/debug.keystore` em **cada máquina**. O laptop do seu colega e o runner do seu CI geram cada um o seu no primeiro build, com impressões digitais diferentes. "Funciona na minha máquina, erro 10 na sua" é exatamente isso.

Depois, adicione a impressão digital onde o seu projeto é gerenciado:

- **Firebase**: Project settings, Your apps, escolha o app Android, Add fingerprint. O Firebase cria para você o cliente OAuth Android correspondente no projeto Google Cloud subjacente.
- **Somente Google Cloud**: Google Auth Platform, Clients, Create client, tipo Android, informe o nome do pacote e o SHA-1. Um cliente Android por par (nome do pacote, SHA-1).

Se você precisa da impressão digital de um build que já tem, leia-a do artefato em vez do keystore que você acha que foi usado. Para um APK, use o `apksigner` do Android build-tools:

```bash
# Android build-tools 36.1.0
apksigner verify --print-certs build/app/outputs/flutter-apk/app-dev-release.apk
# Signer #1 certificate DN: CN=Repro
# Signer #1 certificate SHA-256 digest: af3cbfe5...cc071a0a
# Signer #1 certificate SHA-1 digest: 16af74412946e25b13bba5a429c5ccd8368306e9
```

Não use `keytool -printcert -jarfile` em um APK Flutter. Neste projeto ele imprime `Not a signed jar file`, porque o `minSdk` do template é 24 e o AGP assina apenas com o APK Signature Scheme v2 (`apksigner verify -v` informa `Verified using v1 scheme (JAR signing): false`). `keytool -printcert -jarfile` funciona no `.aab`, que é assinado como jar com a chave de upload.

### Builds de loja: adicione também a chave do Play App Signing

Esta é a causa por trás da maioria dos relatos de "funciona no meu APK de release, falha quando instalado pelo Google Play". Com o Play App Signing, que é obrigatório para apps novos, o Google remove sua assinatura de upload e reassina os APKs que entrega com a própria chave de assinatura de app. O SHA-1 que os celulares dos seus usuários apresentam é o **dessa** chave, que você nunca teve localmente. Copie-o do Play Console, em Test and release, App integrity, App signing, "App signing key certificate", e registre-o ao lado da chave de upload. As faixas de teste interno são reassinadas da mesma forma, então elas pegam isso antes da produção.

O template padrão do Flutter piora a situação: seu build type `release` assina com a chave de debug ("Signing with the debug keys for now, so `flutter run --release` works"). Um build de release que funciona localmente pode ser simplesmente um build assinado com debug, o que não prova nada sobre a chave que o Play vai usar.

## Correção 2: registre o nome de pacote que realmente está instalado

O `signingReport` não imprime nomes de pacote. Leia o instalado a partir do APK:

```bash
# Android build-tools 36.1.0
aapt2 dump badging build/app/outputs/flutter-apk/app-dev-release.apk | head -1
# package: name='net.startdebugging.gsiapp.dev' versionCode='1' versionName='0.1.0' ...
```

O `applicationIdSuffix` do flavor `dev` transformou `net.startdebugging.gsiapp` em `net.startdebugging.gsiapp.dev`, que para o Google é um app diferente. Cada flavor precisa do seu próprio cliente OAuth Android (Firebase: seu próprio app Android com seu próprio `google-services.json` em `android/app/src/<flavor>/`). Note que o `namespace` em `build.gradle.kts` é irrelevante aqui: apenas o `applicationId` (mais sufixos) é o que o dispositivo informa. Se flavors são novidade para você, [o que é um flavor do Flutter e como ele difere de um modo de build](/pt-br/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/) explica onde entra o `applicationIdSuffix`.

## Correção 3: passe o ID de cliente Web como serverClientId

O ID token é emitido para o seu **servidor**, então o ID de cliente que você entrega ao plugin é o cliente de aplicativo Web (o Firebase o chama de `client_type: 3` no `google-services.json`). O ID de cliente Android nunca é passado no código, o Google o encontra pelo nome do pacote e pelo SHA-1. Passar o ID de cliente Android como `serverClientId`, ou um cliente Web de outro projeto, produz o mesmo erro 10.

```dart
// google_sign_in 7.2.0
await GoogleSignIn.instance.initialize(
  // From Google Auth Platform > Clients, type "Web application",
  // in the SAME project as the Android client.
  serverClientId: '1234567890-web.apps.googleusercontent.com',
);
```

```dart
// google_sign_in 6.3.0 (legacy API)
final googleSignIn = GoogleSignIn(
  serverClientId: '1234567890-web.apps.googleusercontent.com',
  scopes: ['email'],
);
```

Se você omitir `serverClientId`, as duas versões do plugin recorrem ao recurso de string `default_web_client_id`, que o plugin Gradle `google-services` gera a partir do `google-services.json`. No 7.x, se esse recurso também estiver ausente, você recebe um erro diferente e explícito: `GoogleSignInExceptionCode.clientConfigurationError` com "serverClientId must be provided on Android". Se você vir isso, seu `google-services.json` não tem uma entrada `oauth_client` com `client_type: 3`. Habilite o Google como provedor de login no Firebase (ou adicione um app web ao projeto) e baixe o arquivo novamente.

## Correção 4: baixe o google-services.json novamente e espere

Depois de adicionar impressões digitais no Firebase, baixe o `google-services.json` novamente e substitua `android/app/google-services.json`. A rigor, o cliente Android é correspondido no servidor, então o arquivo importa principalmente para o `default_web_client_id`, mas um arquivo anterior à mudança é uma fonte comum de entrada Web desatualizada ou ausente. Depois execute `flutter clean` para que os recursos gerados sejam recompilados. As mudanças no Google Cloud também nem sempre são instantâneas; dê a uma impressão digital recém-adicionada alguns minutos, e há relatos de demora maior, antes de concluir que não funcionou.

## Armadilhas e erros parecidos

**`ApiException: 12500` não é o mesmo erro.** 12500 é `SIGN_IN_FAILED`. Aparece em problemas como uma tela de consentimento OAuth incompleta (e-mail de suporte ou nome do app ausentes), e não por pacote e impressão digital desconhecidos. Corrija primeiro a configuração da tela de consentimento.

**`ApiException: 12501` é um cancelamento**, e o plugin 6.x o mapeia para `sign_in_canceled`. Se um usuário não cancelou de fato, olhe a configuração de novo, especialmente no 7.x, onde o Credential Manager pode disfarçar uma configuração incorreta de cancelamento.

**`ApiException: 7` é um erro de rede** (`network_error` no 6.x). Emuladores sem conectividade o produzem, não uma configuração incorreta.

**Nenhuma conta no dispositivo.** No 7.x, um emulador sem conta Google conectada, ou com os prompts "Sign in with Google" desativados nas configurações da conta Google, gera `NoCredentialException`, que o plugin reporta como "No credential available". Isso é estado do dispositivo, não o erro 10. Use uma imagem de emulador com Google Play.

**Migrar para o 7.x não elimina a exigência do SHA.** O Credential Manager usa a mesma busca de cliente OAuth Android. Se você está no meio da migração e travado na mudança do construtor, [o post sobre a migração para o singleton do GoogleSignIn](/pt-br/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) cobre o lado da API.

**Firebase Auth por cima.** Se você entrega o ID token do Google para `FirebaseAuth.signInWithCredential`, uma configuração correta do Google ainda pode deixar problemas de release do lado do Firebase, como restrições de chave de API vinculadas ao SHA-1 de debug. Eles são tratados em [login do Firebase Auth que não persiste em um build de release](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

**Falhas só em release podem não ter relação.** Se o build de release falha antes mesmo de chegar ao login, é um problema diferente, veja [a correção de "Could not create Dart VM instance" em build de release](/pt-br/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Uma checklist que resolve

1. Compile a variante exata que falha e execute `apksigner verify --print-certs` e `aapt2 dump badging` nesse APK.
2. No projeto Google Cloud que é dono do seu ID de cliente Web, confirme que existe um cliente Android com exatamente esse nome de pacote e SHA-1.
3. Para builds instalados pelo Play, adicione o SHA-1 do App signing key certificate do Play Console.
4. Confirme que `serverClientId` (ou `default_web_client_id`) é o cliente Web desse mesmo projeto.
5. Baixe o `google-services.json` novamente, execute `flutter clean`, recompile e dê alguns minutos ao Google.

Se os cinco itens estiverem corretos e você ainda receber o erro 10, quase certamente você está olhando para um projeto diferente daquele do qual o token é solicitado. Compare o prefixo numérico do ID de cliente Web com o número do projeto no console.

## Relacionados

- [Correção: The class 'GoogleSignIn' doesn't have an unnamed constructor](/pt-br/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- [Correção: login do Firebase Auth não persiste em um build de release Android do Flutter](/pt-br/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [O que é um flavor do Flutter e como ele difere de um modo de build?](/pt-br/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)
- [Correção: Could not create Dart VM instance em um build de release do Flutter](/pt-br/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)

## Fontes

- [google_sign_in_android README: Integration and Troubleshooting](https://pub.dev/packages/google_sign_in_android)
- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in)
- [Authenticating Your Client (SHA-1 fingerprints, signingReport)](https://developers.google.com/android/guides/client-auth)
- [CommonStatusCodes reference](https://developers.google.com/android/reference/com/google/android/gms/common/api/CommonStatusCodes)
- [Credential Manager troubleshooting guide](https://developer.android.com/identity/sign-in/credential-manager-troubleshooting-guide)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [FlutterFire discussion #18477: ApiException 10 only in the Google Play version](https://github.com/firebase/flutterfire/discussions/18477)
