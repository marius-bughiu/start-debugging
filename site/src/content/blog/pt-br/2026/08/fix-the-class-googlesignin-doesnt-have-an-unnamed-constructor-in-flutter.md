---
title: "Correção: The class 'GoogleSignIn' doesn't have an unnamed constructor"
description: "O google_sign_in 7.0.0 tornou GoogleSignIn um singleton. Troque GoogleSignIn(scopes: ...) por GoogleSignIn.instance, aguarde initialize() uma vez e chame authenticate()."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "google-sign-in"
  - "firebase"
lang: "pt-br"
translationOf: "2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-20
---

`GoogleSignIn` virou um singleton no `google_sign_in` 7.0.0 (publicado em 2025-06-24), então `GoogleSignIn(...)` não compila mais. Use `GoogleSignIn.instance`, aguarde o novo método `initialize()` exatamente uma vez na inicialização e chame `authenticate()` no lugar de `signIn()`. O argumento `scopes:` que você passava para o construtor não tem substituto direto: a autorização agora é uma etapa separada, através de `user.authorizationClient`. Não existe migração automática, então reserve tempo real para um aplicativo real.

## O erro, na íntegra

O analisador reporta isto contra um `pubspec.yaml` que resolve `google_sign_in` 7.x, em qualquer plataforma:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor. Try using one
        of the named constructors defined in 'GoogleSignIn' - lib\auth.dart:5:36 -
        new_with_undefined_constructor_default
```

A dica não leva a lugar nenhum. O único construtor nomeado da classe é `GoogleSignIn._()`, que é privado do pacote, então não há nada para você chamar. O diagnóstico vem da regra genérica do analisador para "sem construtor padrão" e não sabe que o pacote espera que você passe por um campo estático.

Ele nunca chega sozinho. Rodar `flutter analyze` em um arquivo de login típico do 6.x contra o `google_sign_in` 7.2.0 no Flutter 3.44.2 produz a cascata completa:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor
error - The method 'signIn' isn't defined for the type 'GoogleSignIn'
error - The method 'isSignedIn' isn't defined for the type 'GoogleSignIn'
error - The method 'signInSilently' isn't defined for the type 'GoogleSignIn'
error - The getter 'accessToken' isn't defined for the type 'GoogleSignInAuthentication'
 info - Uses 'await' on an instance of 'GoogleSignInAuthentication', which is not a
        subtype of 'Future'
```

Vale ler esse último `info` com atenção. `GoogleSignInAccount.authentication` agora é um getter síncrono, então cada `await account.authentication` no seu código é uma operação sem efeito que o analisador marca apenas como aviso de estilo, não como erro.

## Por que o construtor desapareceu no google_sign_in 7.0.0

A API do 6.x era um invólucro em Dart sobre o SDK do Google Sign-In, que o Google descontinuou tanto no Android quanto na Web. No Android a substituição é o Credential Manager mais o `AuthorizationClient`, e o Google [vem avisando os desenvolvedores desde setembro de 2024](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html) de que as APIs legadas de login do `play-services-auth` vão sumir. Esses SDKs têm um formato fundamentalmente diferente, então a superfície do plugin do Flutter mudou junto.

Três dessas mudanças explicam quase todos os erros de compilação que você vai encontrar.

O plugin não modela mais "um objeto que você configura e depois usa". Os SDKs subjacentes operam no nível do processo, e criar dois objetos `GoogleSignIn` no 6.x nunca funcionou de verdade. O guia de migração do pacote é direto: tornar a classe um singleton apenas impõe uma restrição que já existia.

A configuração saiu do construtor e foi para uma chamada assíncrona explícita a `initialize()`. Na web essa chamada tem trabalho real a fazer e pode levar um tempo perceptível, algo que um construtor não consegue expressar.

Autenticação e autorização agora são separadas. No 6.x, `GoogleSignIn(scopes: [...])` juntava "quem é esse usuário" com "me deixe ler os contatos dele" em um único diálogo de consentimento. No 7.x você autentica primeiro e pede os scopes no momento em que realmente precisa dos dados.

## Reprodução mínima: o código 6.x que para de compilar

```dart
// Flutter 3.44.2, Dart 3.12.2, google_sign_in 7.2.0
// Every line of this compiled fine on google_sign_in 6.3.0.
import 'package:google_sign_in/google_sign_in.dart';

final GoogleSignIn _googleSignIn = GoogleSignIn(
  scopes: <String>['email', 'https://www.googleapis.com/auth/contacts.readonly'],
);

Future<void> signIn() async {
  final GoogleSignInAccount? account = await _googleSignIn.signIn();
  if (account == null) return;
  final GoogleSignInAuthentication auth = await account.authentication;
  print(auth.accessToken);
  print(auth.idToken);
}
```

Não recorra ao `dart fix` aqui. Rodar `dart fix --dry-run` neste arquivo com o `google_sign_in` 7.2.0 instalado reporta `Nothing to fix!`, porque o pacote não traz nenhuma camada de compatibilidade para os membros removidos. Cada ponto de chamada é uma edição manual.

## Como substituo GoogleSignIn(...) pelo singleton

Chame `initialize()` uma vez, antes de qualquer outra coisa tocar no plugin. Em um app Flutter isso significa `main()` ou uma inicialização de execução única, não `initState` em uma tela de login que pode ser empilhada duas vezes.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await GoogleSignIn.instance.initialize(
    // Both are optional. Omit them if your Info.plist GIDClientID or your
    // google-services.json already supplies the values.
    clientId: 'IOS_OR_WEB_CLIENT_ID.apps.googleusercontent.com',
    serverClientId: 'SERVER_CLIENT_ID.apps.googleusercontent.com',
  );

  runApp(const MyApp());
}
```

`initialize()` aceita `clientId`, `serverClientId`, `nonce` e `hostedDomain`. Os valores passados aqui têm precedência sobre os dos seus arquivos de configuração de plataforma. Não existe parâmetro `scopes` nem `signInOption`: `SignInOption.games` foi removido inteiramente da interface de plataforma.

A chamada interativa de login fica assim:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> onSignInPressed() async {
  if (!GoogleSignIn.instance.supportsAuthenticate()) {
    return; // Web. See the renderButton section below.
  }
  try {
    final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
    final String? idToken = user.authentication.idToken; // no await
  } on GoogleSignInException catch (e) {
    if (e.code == GoogleSignInExceptionCode.canceled) return;
    debugPrint('${e.code}: ${e.description}');
  }
}
```

Duas diferenças no nível de tipos importam. `authenticate()` retorna um `GoogleSignInAccount` não anulável, então a guarda `if (account == null)` do 6.x agora é código morto. E o cancelamento é uma exceção em vez de um null: o usuário desistindo lança `GoogleSignInException` com um `code` igual a `GoogleSignInExceptionCode.canceled`. Se você apagar a antiga verificação de null e esquecer o try/catch, cada login cancelado vira uma exceção não tratada nos seus logs.

`GoogleSignInExceptionCode` também traz `interrupted`, `clientConfigurationError`, `providerConfigurationError`, `uiUnavailable`, `userMismatch` e `unknownError`. Ele ficou sem ser exportado por acidente no 7.0.0 e voltou no 7.1.0, então exija ao menos a 7.1.0 se quiser fazer um switch sobre ele.

## O que substitui signIn, signInSilently e currentUser

Cada membro removido e seu equivalente no 7.x, conferido contra o `google_sign_in` 7.2.0:

| google_sign_in 6.x | google_sign_in 7.x |
| --- | --- |
| `GoogleSignIn(...)` | `GoogleSignIn.instance` mais `await initialize(...)` |
| `signIn()` | `authenticate({scopeHint})` |
| `signInSilently()` | `attemptLightweightAuthentication()` |
| `isSignedIn()` | você mesmo rastreia por `authenticationEvents` |
| `currentUser` | você mesmo rastreia por `authenticationEvents` |
| `onCurrentUserChanged` | `authenticationEvents` |
| `canAccessScopes(scopes)` | `authorizationClient.authorizationForScopes(scopes)` |
| `requestScopes(scopes)` | `authorizationClient.authorizeScopes(scopes)` |
| `account.authHeaders` | `authorizationClient.authorizationHeaders(scopes)` |
| `account.serverAuthCode` | `authorizationClient.authorizeServer(scopes)` |
| `clearAuthCache(token:)` | `clearAuthorizationToken(accessToken:)`, adicionado no 7.2.0 |
| `signOut()`, `disconnect()` | sem mudanças |

Vale registrar os dois sobreviventes: `signOut()` e `disconnect()` mantiveram nomes e assinaturas, e é por isso que uma migração pela metade pode compilar em um arquivo e falhar no seguinte.

`attemptLightweightAuthentication()` tem um tipo de retorno que parece erro de digitação e não é. Ele retorna `Future<GoogleSignInAccount?>?`, um future anulável. Um future nulo significa que a plataforma não consegue responder rápido (o exemplo que o pacote dá é a web com FedCM), então você deve renderizar uma interface de sessão encerrada e esperar por `authenticationEvents` em vez de aguardar qualquer coisa.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
final Future<GoogleSignInAccount?>? attempt =
    GoogleSignIn.instance.attemptLightweightAuthentication();
if (attempt != null) {
  final GoogleSignInAccount? user = await attempt;
}
```

Repare também que "leve" não é "silencioso". A troca de nome é deliberada: na web isso pode mostrar um cartão flutuante de login, e no Android uma folha de seleção de conta. Por padrão a chamada engole `canceled`, `interrupted` e `uiUnavailable` e retorna null nesses casos; passe `reportAllExceptions: true` se quiser que sejam lançados.

## Para onde foi o argumento scopes

Para uma segunda etapa, separada. `GoogleSignInAccount` expõe um `authorizationClient`, e é ali que os tokens de acesso vivem agora. O formato recomendado é tentar primeiro uma concessão existente e só mostrar a interface se isso falhar:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
const List<String> scopes = <String>[
  'https://www.googleapis.com/auth/contacts.readonly',
];

Future<String> accessTokenFor(GoogleSignInAccount user) async {
  // Returns null instead of prompting if the scopes are not yet granted.
  final GoogleSignInClientAuthorization? existing =
      await user.authorizationClient.authorizationForScopes(scopes);
  if (existing != null) return existing.accessToken;

  // Shows consent UI. Call it from a button press, not from initState.
  final GoogleSignInClientAuthorization granted =
      await user.authorizationClient.authorizeScopes(scopes);
  return granted.accessToken;
}
```

Esses dois métodos chegam ao mesmo ponto de entrada da plataforma com um único indicador invertido. Executar o fluxo contra um `GoogleSignInPlatform` falso em um teste registra exatamente esta sequência de chamadas:

```
init
authenticate scopeHint=[]
clientAuth prompt=false     <- authorizationForScopes
clientAuth prompt=true      <- authorizeScopes
```

Se você quer o antigo diálogo de consentimento combinado, passe `scopeHint` para `authenticate()`. É uma dica e nada mais: plataformas que não conseguem combinar os fluxos ignoram, e o pacote avisa explicitamente que `authorizationForScopes` ainda pode retornar null depois. Escreva o caminho alternativo mesmo assim.

Para uma troca com o servidor, `authorizeServer(scopes)` retorna um `GoogleSignInServerAuthorization` carregando um `serverAuthCode`. É uma ida e volta separada da autorização de cliente, e essa é de longe a surpresa mais comum para apps que liam `account.serverAuthCode` direto do resultado do login.

## Para onde foi authentication.accessToken

Ele mudou de tipo, porque um token de acesso é um artefato de autorização e `authentication` agora carrega apenas artefatos de autenticação. No 7.x, `GoogleSignInAuthentication` tem exatamente um campo:

```dart
// google_sign_in 7.2.0, lib/src/token_types.dart
class GoogleSignInAuthentication {
  const GoogleSignInAuthentication({required this.idToken});
  final String? idToken;
}
```

O token de acesso passou para `GoogleSignInClientAuthorization.accessToken`, que não é anulável, e o código de autorização de servidor para `GoogleSignInServerAuthorization.serverAuthCode`.

Essa é a mudança que quebra integrações com o Firebase Auth, e a correção é menor do que a maioria das threads de migração sugere. `GoogleAuthProvider.credential` no `firebase_auth` 6.5.7 é declarado como `credential({String? idToken, String? accessToken})` com um assert exigindo ao menos um dos dois. Um token de ID sozinho basta:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0, firebase_auth 6.5.7
Future<UserCredential> signInWithGoogle() async {
  final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();

  final AuthCredential credential = GoogleAuthProvider.credential(
    idToken: user.authentication.idToken,
  );
  return FirebaseAuth.instance.signInWithCredential(credential);
}
```

Não chame `authorizeScopes` só para produzir um `accessToken` para essa chamada. Isso dispara um diálogo de consentimento que seus usuários não precisam ver, para scopes que você não vai usar.

## O que acontece com authenticate no Flutter web

Ele lança uma exceção. O `google_sign_in_web` 1.1.3 retorna `false` de `supportsAuthenticate()`, e `authenticate()` lança:

```
UnimplementedError: authenticate is not supported on the web.
Instead, use renderButton to create a sign-in widget.
```

O Google Identity Services exige que o botão de login seja renderizado pelo próprio SDK dele, então seu `ElevatedButton` customizado não consegue disparar o fluxo. Proteja com `supportsAuthenticate()` e, na web, renderize o widget de `package:google_sign_in_web/web_only.dart` e pegue o resultado em `authenticationEvents`. Note que o guia de migração descreve isso como um `UnsupportedError` enquanto a implementação de fato lança `UnimplementedError`, então não faça correspondência pelo tipo exato.

Armadilha relacionada, só na web: `authorizationRequiresUserInteraction()` retorna `true` ali, porque o fluxo de autorização usa um popup que os navegadores bloqueiam fora de um gesto do usuário. Chamar `authorizeScopes` de um `FutureBuilder` ou de `initState` funciona no mobile e falha na web.

## Posso simplesmente fixar o google_sign_in 6.x

Por pouco tempo, sim. `google_sign_in: 6.3.0` ainda resolve limpo no Flutter 3.44.2, trazendo `google_sign_in_android` 6.2.1 e `google_sign_in_ios` 5.9.0. Nada no SDK estável atual do Flutter bloqueia isso.

Trate como paliativo e não como plano. O lado Android do 6.x se apoia nas APIs descontinuadas de login do `play-services-auth` que [a própria página de migração do Google](https://developer.android.com/identity/sign-in/legacy-gsi-migration) diz que serão removidas. Você está escolhendo quando fazer essa migração, não se vai fazer.

## Armadilhas que sobrevivem a uma compilação limpa

**Pular o `initialize()` mata o stream de eventos em silêncio.** O pacote voltado ao app só sintetiza eventos em `authenticationEvents` se `initialize()` determinou que a implementação de plataforma não tem um stream de eventos próprio. Um teste com uma plataforma falsa confirma o modo de falha: autentique sem inicializar e o stream fica vazio, sem nenhuma exceção lançada. O login funciona, a interface nunca atualiza.

**Chamar `initialize()` mais de uma vez é comportamento indefinido.** O pacote documenta com essas palavras. Uma inicialização que roda de novo na reconstrução de um provider cai nisso.

**No Android, um erro de configuração pode chegar como `canceled`.** O SDK do Credential Manager retorna um cancelamento para algumas configurações incorretas, e o plugin não tem como distinguir. Se `authenticate()` lançar `canceled` logo depois do seletor de conta, confira o SHA de assinatura daquela variante de build e confirme que seu `google-services.json` contém uma entrada `oauth_client` com `client_type: 3`.

**Sua versão do Flutter pode limitar a implementação Android.** O `google_sign_in` 7.2.0 em si exige Flutter 3.29 e Dart 3.7, mas o `google_sign_in_android` 7.2.16 exige Flutter 3.44 e Dart 3.12. Em versões mais antigas do Flutter, o pub resolve um pacote de implementação mais velho em vez de falhar, então a versão do plugin no `pubspec.lock` não conta a história toda. É a mesma classe de armadilha que [fixar a versão do engine do Flutter para builds reproduzíveis](/pt-br/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

**O próprio `testing.dart` do pacote ainda documenta a API do 6.x.** `FakeSignInBackend` traz um comentário de documentação mostrando `GoogleSignIn()` e `setMockMethodCallHandler`. Ele não foi atualizado para o 7.x, e seus nomes de method channel não batem mais com o plugin. Escreva um `GoogleSignInPlatform` falso e atribua a `GoogleSignInPlatform.instance` no lugar.

## Relacionado

- O mesmo formato de atualização aparece em [migrar do Riverpod 2.x para o Riverpod 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), onde os erros de compilação são a parte fácil e as mudanças de comportamento não são.
- Uma atualização de plugin que renomeia valores de erro em vez de APIs: [biometric_signature 10.0.0 e seus novos valores BiometricError](/pt-br/2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x/).
- O login é um longo intervalo assíncrono, então [proteger setState com a verificação mounted após um intervalo assíncrono](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) se aplica diretamente ao código que você está reescrevendo.
- Se subir o plugin também quebrou seu build de iOS, comece por [CocoaPods could not find compatible versions for pod](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- Para manter um app compilável em mais de um SDK enquanto uma migração dessas acontece, veja [como mirar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Fontes

- [google_sign_in no pub.dev](https://pub.dev/packages/google_sign_in), versão 7.2.0, publicada em 2025-09-17. O `MIGRATION.md` que vem dentro do pacote é o mapeamento autoritativo de 6.x para 7.x.
- [Changelog do google_sign_in](https://pub.dev/packages/google_sign_in/changelog), para a lista de mudanças incompatíveis do 7.0.0 e a correção da exportação de `GoogleSignInExceptionCode` no 7.1.0.
- [google_sign_in_android no pub.dev](https://pub.dev/packages/google_sign_in_android), cujo README documenta a exigência do `serverClientId` e o comportamento de `canceled` como sinal de configuração errada.
- [About the migration from legacy Google Sign-In](https://developer.android.com/identity/sign-in/legacy-gsi-migration) no Android Developers.
- [Streamlining Android authentication: Credential Manager replaces legacy APIs](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), o anúncio de setembro de 2024 por trás da reescrita do plugin.

Cada string de erro, resolução de versões e sequência de chamadas acima foi reproduzida localmente no Flutter 3.44.2 com Dart 3.12.2.
