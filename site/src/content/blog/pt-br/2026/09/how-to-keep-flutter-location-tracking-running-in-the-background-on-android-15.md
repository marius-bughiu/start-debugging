---
title: "Como manter o rastreamento de localização do Flutter rodando em segundo plano no Android 15"
description: "Rode um rastreador de localização em Flutter que sobrevive ao botão Home, a um deslize na tela de recentes e a uma reinicialização no Android 15 e 16: um foreground service do tipo location com sua própria engine do Flutter, as permissões exatas e a SecurityException que aparece quando as regras de while-in-use entram em ação. Testado com geolocator 14.0.3 e flutter_foreground_task 11.0.3."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "location"
  - "foreground-service"
lang: "pt-br"
translationOf: "2026/09/how-to-keep-flutter-location-tracking-running-in-the-background-on-android-15"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Resposta curta:** no Android 15 (e 16), um rastreador de localização em Flutter só continua rodando quando as atualizações de localização vêm de um **foreground service do tipo `location`** que roda **sua própria engine do Flutter**, e não de um stream no isolate da sua UI. Declare `FOREGROUND_SERVICE` e `FOREGROUND_SERVICE_LOCATION` além de `ACCESS_FINE_LOCATION`, dê ao service `android:foregroundServiceType="location"`, inicie-o a partir de um toque em botão enquanto sua activity está visível e escute `Geolocator.getPositionStream` dentro desse service. O próprio `foregroundNotificationConfig` do `geolocator` basta para "continuar rastreando enquanto o app está em segundo plano", mas ele morre quando o usuário descarta o app com um deslize. Se o rastreador também precisa voltar depois de uma reinicialização ou de um restart do sistema, o usuário tem que conceder "Permitir o tempo todo" (`ACCESS_BACKGROUND_LOCATION`), ou o Android lança uma `SecurityException` no momento em que o service chama `startForeground`.

Tudo a seguir foi feito com Flutter 3.44.8 (que usa `targetSdkVersion` 36 por padrão), `geolocator` 14.0.3 (`geolocator_android` 5.0.3) e `flutter_foreground_task` 11.0.3, e executado em um emulador Android 16 (API 36). O Android 16 aplica todas as regras de foreground service do Android 14 e do Android 15 descritas aqui, e como o Google Play exige `targetSdkVersion` 36 para apps novos e atualizações a partir de 31 de agosto de 2026, essas são as regras sob as quais seu app roda, qualquer que seja a versão do Android dos seus usuários.

## O que o Android 15 realmente mudou, e o que não mudou

A maioria dos relatos de "meu rastreador para no Android 15" não é causada pelo Android 15 em si. As regras que matam rastreadores de localização são mais antigas:

- **Android 12 (API 31)** proíbe iniciar um foreground service enquanto o app está em segundo plano, com exceção de uma lista de [isenções](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) (boot, toque em uma notificação, um alarme exato e assim por diante).
- **Android 14 (API 34)** exige que todo foreground service declare um [tipo](https://developer.android.com/develop/background-work/services/fg-service-types) e tenha a permissão correspondente. Para `location`, isso é `FOREGROUND_SERVICE_LOCATION`, além de `ACCESS_COARSE_LOCATION` ou `ACCESS_FINE_LOCATION` concedida no momento em que o service vai para o primeiro plano.
- **Permissões while-in-use**: a localização precisa e a aproximada só contam enquanto seu app está visível. Um service `location` iniciado a partir do segundo plano falha a menos que o app tenha `ACCESS_BACKGROUND_LOCATION`, mesmo quando o início em si é uma das isenções permitidas.

O que o [Android 15](https://developer.android.com/about/versions/15/behavior-changes-15) adicionou foi um limite diário de 6 horas para services `dataSync` e `mediaProcessing`, uma lista de tipos que um receiver de `BOOT_COMPLETED` não pode mais iniciar (`dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection`, e `microphone` desde o Android 14) e uma isenção de `SYSTEM_ALERT_WINDOW` mais rígida. `location` não está em nenhuma das listas. Isso importa porque muito código de rastreamento em Flutter copia um exemplo do `flutter_foreground_task` que declara `dataSync`. No Android 15, esse rastreador é encerrado depois de 6 horas e não consegue mais voltar após uma reinicialização. Declarar o tipo correto resolve os dois problemas.

## Por que o stream no seu widget para

O rastreador ingênuo é uma `StreamSubscription<Position>` em um objeto `State`. Seus callbacks rodam no isolate de UI da engine do Flutter que pertence à sua `FlutterActivity`. Quando o Android decide que esse processo está ocioso, ou o usuário remove o app dos recentes com um deslize, essa engine desaparece, e seu código Dart junto com ela. Nenhuma notificação de primeiro plano consegue manter código rodando em uma engine que não existe mais.

O `geolocator` tem uma solução intermediária para isso. Passe um `AndroidSettings` com um `foregroundNotificationConfig` e o `geolocator_android` promove seu próprio `GeolocatorLocationService` a foreground service:

```dart
// Flutter 3.44.8, geolocator 14.0.3
final sub = Geolocator.getPositionStream(
  locationSettings: AndroidSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 10,
    intervalDuration: const Duration(seconds: 5),
    foregroundNotificationConfig: const ForegroundNotificationConfig(
      notificationTitle: 'Recording trip',
      notificationText: 'Tracking in the background',
      enableWakeLock: true,
    ),
  ),
).listen((p) => debugPrint('GEO_ONLY ${p.latitude},${p.longitude}'));
```

O manifest do próprio plugin já declara esse service com `android:foregroundServiceType="location"`. Mas o `GeolocatorPlugin` se conecta a ele com `bindService`, nunca com `startService`, e faz o unbind quando a engine se desanexa. O comentário de documentação do plugin diz exatamente isso: a notificação "não roda seu service em segundo plano". Eu medi no emulador com API 36:

| Cenário | `geolocator` com `foregroundNotificationConfig` | service do `flutter_foreground_task` + `geolocator` dentro dele |
| --- | --- | --- |
| App visível | Posições entregues | Posições entregues |
| Botão Home pressionado | Posições entregues, tipo de FGS `0x8` | Posições entregues, tipo de FGS `0x8` |
| Removido dos recentes com um deslize | Service destruído, sem mais posições | O mesmo processo continua rodando, posições entregues |
| Reinicialização, apenas while-in-use | n/a | `SecurityException` em `startForeground` |
| Reinicialização, "Permitir o tempo todo" | n/a | Service reiniciado, posições entregues |

Depois do deslize, o log da versão só com geolocator terminou com "Unbinding from location service" e "Destroying location service". Na outra build, a engine do service continuou conectada ("There is still another flutter engine connected, not stopping location service") e a notificação continuou sendo atualizada com novas coordenadas.

Então `foregroundNotificationConfig` é a ferramenta certa quando "segundo plano" significa "o usuário mudou para outro app por um tempo durante uma corrida". Para um gravador de trajetos, um rastreador de entregas ou um app de fitness que precisa continuar até o usuário apertar Parar, as atualizações têm que viver em um service que tem sua própria engine.

## Construa o rastreador em uma engine de service separada

O `flutter_foreground_task` inicia um foreground service real, iniciado (e não apenas vinculado), sobe uma segunda engine do Flutter dentro dele e chama ali um ponto de entrada Dart de nível superior. Você pode rodar qualquer plugin a partir dessa engine, incluindo o `geolocator`. Os passos:

1. Adicione os pacotes.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.8
   dependencies:
     geolocator: ^14.0.3
     flutter_foreground_task: ^11.0.3
   ```

   O `flutter_foreground_task` 11.x exige Flutter 3.44+, Kotlin 2.2.20+ e Gradle 8.11.1+. Um projeto criado com Flutter 3.44.8 já usa AGP 9.0.1, Kotlin 2.3.20 e Gradle 9.1.0. Se o seu for mais antigo, veja antes [como migrar um projeto Android de Flutter para o AGP 9 com Kotlin integrado](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).

2. Declare as permissões e o service em `android/app/src/main/AndroidManifest.xml`.

   ```xml
   <!-- targetSdkVersion 36, flutter_foreground_task 11.0.3 -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
       <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
       <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
       <!-- Only if the tracker must restart after boot or a system kill -->
       <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
       <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

       <application ...>
           <!-- ... your activity ... -->
           <service
               android:name="com.pravera.flutter_foreground_task.service.ForegroundService"
               android:foregroundServiceType="location"
               android:exported="false" />
       </application>
   </manifest>
   ```

   Não renomeie o service: o plugin o inicia por esse nome de classe. `FOREGROUND_SERVICE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` e `POST_NOTIFICATIONS` também vêm do manifest do próprio plugin. `FOREGROUND_SERVICE_LOCATION` não vem de nenhum dos dois plugins, então você precisa adicioná-la por conta própria. `aapt2 dump xmltree` no APK gerado mostra os dois services, o do plugin e o do geolocator, com `foregroundServiceType=0x00000008` (location).

3. Escreva o task handler que roda na engine do service.

   ```dart
   // lib/location_task.dart -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   import 'dart:async';

   import 'package:flutter_foreground_task/flutter_foreground_task.dart';
   import 'package:geolocator/geolocator.dart';

   // Runs in the service's own Flutter engine, not in the UI isolate.
   @pragma('vm:entry-point')
   void startLocationTask() {
     FlutterForegroundTask.setTaskHandler(LocationTaskHandler());
   }

   // Shared by the UI (settings check) and the service (tracking).
   AndroidSettings trackingSettings() => AndroidSettings(
     accuracy: LocationAccuracy.high,
     distanceFilter: 10,
     intervalDuration: const Duration(seconds: 5),
     // No foregroundNotificationConfig: the flutter_foreground_task service
     // already is the location foreground service.
   );

   class LocationTaskHandler extends TaskHandler {
     StreamSubscription<Position>? _sub;

     @override
     Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
       _sub = Geolocator.getPositionStream(locationSettings: trackingSettings())
           .listen(
             (p) {
               FlutterForegroundTask.updateService(
                 notificationText:
                     '${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}',
               );
               FlutterForegroundTask.sendDataToMain(<String, Object>{
                 'lat': p.latitude,
                 'lng': p.longitude,
                 'ts': p.timestamp.millisecondsSinceEpoch,
               });
             },
             onError: (Object e) =>
                 FlutterForegroundTask.sendDataToMain('error: $e'),
           );
     }

     @override
     void onRepeatEvent(DateTime timestamp) {}

     @override
     Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
       await _sub?.cancel();
     }
   }
   ```

   `@pragma('vm:entry-point')` não é opcional. Em builds de release, o tree shaker removeria uma função que só é chamada por código nativo. Persista as posições aqui (em SQLite, em um arquivo ou em um lote HTTP) em vez de depender de `sendDataToMain`: depois de um deslize ou de uma reinicialização, não há nenhum isolate de UI escutando. Cancele a assinatura em `onDestroy`, pelos mesmos motivos explicados em [cancelar uma StreamSubscription no dispose](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

4. Peça as permissões, resolva as configurações de localização e inicie o service a partir da UI.

   ```dart
   // lib/main.dart (excerpt) -- Flutter 3.44.8, geolocator 14.0.3, flutter_foreground_task 11.0.3
   void main() {
     FlutterForegroundTask.initCommunicationPort();
     runApp(const MaterialApp(home: TrackerPage()));
   }

   // In the State's initState:
   FlutterForegroundTask.init(
     androidNotificationOptions: AndroidNotificationOptions(
       channelId: 'tracking',
       channelName: 'Trip tracking',
       channelDescription: 'Shown while a trip is being recorded.',
       onlyAlertOnce: true,
     ),
     iosNotificationOptions: const IOSNotificationOptions(),
     foregroundTaskOptions: ForegroundTaskOptions(
       eventAction: ForegroundTaskEventAction.nothing(),
       autoRunOnBoot: true,
       allowWakeLock: true,
     ),
   );

   Future<bool> _ensurePermissions() async {
     if (!await Geolocator.isLocationServiceEnabled()) return false;

     var perm = await Geolocator.checkPermission();
     if (perm == LocationPermission.denied) {
       perm = await Geolocator.requestPermission();
     }
     if (perm == LocationPermission.denied ||
         perm == LocationPermission.deniedForever) {
       return false;
     }

     // Resolve the "improve location accuracy" prompt here, while there is an
     // Activity. The service engine has none, so geolocator would report
     // "location service disabled" instead of showing the dialog.
     try {
       await Geolocator.getCurrentPosition(
         locationSettings: trackingSettings(),
       ).timeout(const Duration(seconds: 20));
     } on TimeoutException {
       // A slow first fix is fine; the settings check already ran.
     } on LocationServiceDisabledException {
       return false;
     }

     if (await FlutterForegroundTask.checkNotificationPermission() !=
         NotificationPermission.granted) {
       await FlutterForegroundTask.requestNotificationPermission();
     }
     return true;
   }

   Future<void> _start() async {
     if (!await _ensurePermissions()) return;
     // Called from a button tap: the activity is visible, so the
     // while-in-use location permission counts.
     final result = await FlutterForegroundTask.isRunningService
         ? await FlutterForegroundTask.restartService()
         : await FlutterForegroundTask.startService(
             serviceId: 4242,
             serviceTypes: [ForegroundServiceTypes.location],
             notificationTitle: 'Recording trip',
             notificationText: 'Waiting for GPS fix',
             callback: startLocationTask,
           );
     if (result is ServiceRequestFailure) {
       debugPrint('start failed: ${result.error}');
     }
   }
   ```

   Passe `serviceTypes: [ForegroundServiceTypes.location]` explicitamente. Sem isso, o plugin chama `startForeground` com `FOREGROUND_SERVICE_TYPE_MANIFEST`, que significa todos os tipos do atributo no manifest, e um `dataSync` perdido ali traz junto o limite de tempo do Android 15. Envolva seu `Scaffold` em `WithForegroundTask` se quiser que o botão voltar do sistema minimize o app em vez de fechar a activity.

5. Decida se você precisa de "Permitir o tempo todo". Se o rastreamento só precisa sobreviver enquanto o usuário mantém o trajeto ativo, pare aqui: localização precisa mais um service iniciado a partir de uma activity visível é suficiente, e no meu teste isso sobreviveu tanto ao Home quanto ao deslize. Se ele tem que voltar sozinho depois de uma reinicialização (`autoRunOnBoot`), de uma atualização do app ou de o sistema matar o processo, peça a localização em segundo plano como um segundo passo separado. Depois que a localização precisa for concedida, chamar `Geolocator.requestPermission()` de novo pede `ACCESS_BACKGROUND_LOCATION`, porque o `geolocator_android` a adiciona à solicitação quando o manifest a declara e o status atual é `whileInUse`. No Android 11+, isso leva o usuário para a página de configurações do sistema em vez de mostrar um diálogo, então explique o motivo antes de chamar.

## A SecurityException que você recebe sem localização em segundo plano

Este é o log do teste de reinicialização com apenas a localização while-in-use concedida, `targetSdkVersion` 36, emulador com API 36:

```text
I ActivityManager: Background started FGS: Allowed [callingPackage: net.startdebugging.tracker; ... code:BOOT_COMPLETED; ... allowWiu:-1; targetSdkVersion:36 ...]
W ActivityManager: Foreground service started from background can not have location/camera/microphone access: service net.startdebugging.tracker/com.pravera.flutter_foreground_task.service.ForegroundService
E ForegroundService: java.lang.SecurityException: Starting FGS with type location callerApp=ProcessRecord{b79ac40 3076:net.startdebugging.tracker/u0a214} targetSDK=36 requires permissions: all of the permissions allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION] any of the permissions allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]  and the app must be in the eligible state/exemptions to access the foreground only permission
E ForegroundService: 	at android.app.Service.startForeground(Service.java:863)
E ForegroundService: 	at com.pravera.flutter_foreground_task.service.ForegroundService.startForegroundService(ForegroundService.kt:283)
```

Leia em duas metades. A primeira linha diz que o *início* foi permitido: `BOOT_COMPLETED` é uma isenção de início em segundo plano, e o Android 15 não bloqueia `location` a partir do boot. O resto diz que o *acesso à localização* não foi: `allowWiu:-1` significa que a isenção while-in-use não se aplicou, então a permissão de localização precisa não contou e `startForeground` lançou a exceção. Depois de `pm grant ... ACCESS_BACKGROUND_LOCATION` e de outra reinicialização, o mesmo receiver iniciou o service, o `geolocator` registrou "position updates started" e a notificação mostrou coordenadas novas.

A mensagem é enganosa em um ponto: ela lista `FOREGROUND_SERVICE_LOCATION` e as permissões fine/coarse mesmo quando todas estão concedidas. Quando você a vir, verifique *de onde* o service foi iniciado antes de verificar o manifest. Se `FOREGROUND_SERVICE_LOCATION` realmente estiver faltando, você recebe exatamente o mesmo texto, dessa vez até a partir de um toque em botão em primeiro plano.

## Armadilhas que me custaram tempo

**A engine do service não tem Activity.** O cliente fused do `geolocator` primeiro chama `SettingsClient.checkLocationSettings`. Quando a configuração "Precisão do local" do Google está desativada, essa chamada precisa de um diálogo de resolução, e sem Activity o `geolocator_android` reporta `locationServicesDisabled` no lugar. Na minha primeira execução, o task handler recebeu "The location service on the device is disabled." enquanto a localização estava ativada. Executar `getCurrentPosition` com as mesmas configurações a partir da UI antes de iniciar o service mostra o diálogo uma vez. Depois que o usuário aceita, a verificação passa também dentro do service. `forceLocationManager: true` evita o Play services por completo, se você preferir não depender dessa configuração.

**`startService` pode reportar sucesso enquanto o service está em loop de crash.** Com `FOREGROUND_SERVICE_LOCATION` removida, `FlutterForegroundTask.startService` não retornou um `ServiceRequestFailure`. O plugin captura a `SecurityException` dentro de `onStartCommand` e para o service, e então sua lógica de `allowAutoRestart` ("The service will be restarted after 5 seconds because it wasn't properly stopped.") agenda outra tentativa. Isso gerou 8 exceções idênticas em cerca de 25 segundos. Verifique `adb logcat | grep ForegroundService` depois do primeiro início a cada manifest novo.

**Inicie apenas a partir de UI visível ou de um gatilho permitido.** Um toque no seu app, uma ação de notificação ou um widget funcionam. Um `Timer` que dispara depois que o usuário saiu do app, uma mensagem de dados do FCM ou um job do `WorkManager` não iniciam um service `location` a menos que o app tenha localização em segundo plano, e mesmo o início em si precisa de uma das isenções do Android 12.

**Task killers de fabricantes são um problema à parte.** Em um Pixel ou em um emulador, um foreground service `location` com uma notificação visível sobrevive indefinidamente. Algumas builds de fabricantes ainda o matam. `FlutterForegroundTask.requestIgnoreBatteryOptimization()` ajuda em algumas delas e é, por si só, uma das isenções de início em segundo plano. Pedir isso a todos os usuários é uma questão de política do Play, então só solicite quando o propósito central do seu rastreador depender disso.

**Notificações podem ficar ocultas, mas o service continua rodando.** No Android 13+, um `POST_NOTIFICATIONS` negado esconde a notificação da aba de notificações. O service ainda inicia e ainda aparece no Gerenciador de tarefas. Peça a permissão mesmo assim: usuários que não conseguem ver a notificação não fazem ideia de por que a bateria está acabando.

**O Play Console quer duas declarações.** Apps com target Android 14+ precisam declarar cada tipo de foreground service no Play Console com uma descrição e um vídeo. `ACCESS_BACKGROUND_LOCATION` precisa adicionalmente do formulário de declaração de permissões, de uma divulgação em destaque dentro do app e de uma política de privacidade. A [orientação sobre localização em segundo plano](https://support.google.com/googleplay/android-developer/answer/9799150) do Google recomenda preferir o acesso em primeiro plano sempre que possível. Esse é mais um motivo para entregar o passo 5 só se você realmente precisar de reinícios automáticos.

**O iOS é um modelo diferente.** O `flutter_foreground_task` no iOS é um fetch do `BGTaskScheduler` que roda por cerca de 30 segundos a cada 15 minutos. Não é rastreamento contínuo. No iOS, rastreamento contínuo significa `UIBackgroundModes` `location` mais `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)` no `geolocator`. Mantenha as duas plataformas atrás de caminhos de código separados.

## Leitura relacionada

- Se você acabar escrevendo o service por conta própria em Kotlin em vez de usar um plugin, [adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) cobre a infraestrutura dos canais.
- Mirar o SDK 35 ou superior muda mais do que os services. Veja [como corrigir a UI do Flutter que se sobrepõe à barra de navegação do Android depois de mirar o SDK 35](/pt-br/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/).
- Para trabalho periódico e não contínuo em segundo plano, [a correção do minSdkVersion do background_fetch](/pt-br/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) é um bom ponto de partida.

## Fontes

- Android Developers: [Foreground service types](https://developer.android.com/develop/background-work/services/fg-service-types) (tipo location, nota sobre while-in-use)
- Android Developers: [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- Android Developers: [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) (endurecimento de FGS, lista de `BOOT_COMPLETED`, timeout de `dataSync`)
- Ajuda do Play Console: [requisitos de foreground service](https://support.google.com/googleplay/android-developer/answer/13392821) e [requisitos de nível desejado da API](https://support.google.com/googleplay/android-developer/answer/11926878)
- [`geolocator` 14.0.3](https://pub.dev/packages/geolocator) e [código-fonte do `geolocator_android` 5.0.3](https://github.com/baseflow/flutter-geolocator/tree/main/geolocator_android) (`GeolocatorLocationService`, `StreamHandlerImpl`, `FusedLocationClient`)
- [`flutter_foreground_task` 11.0.3](https://pub.dev/packages/flutter_foreground_task) (`ForegroundService.kt`, `RebootReceiver.kt`)
