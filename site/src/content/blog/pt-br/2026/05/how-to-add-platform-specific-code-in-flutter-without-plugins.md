---
title: "Como adicionar código específico de plataforma no Flutter sem plugins"
description: "Chame código nativo de Android (Kotlin) e iOS (Swift) a partir de um app Flutter 3.x sem escrever um plugin: MethodChannel, EventChannel, BasicMessageChannel, a tabela de tipos do StandardMessageCodec, regras de threading e os casos em que um plugin ainda compensa."
pubDate: 2026-05-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "ios"
  - "platform-channels"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins"
translatedBy: "claude"
translationDate: 2026-05-05
---

Resposta curta: coloque um `MethodChannel` no seu `main.dart`, registre o mesmo nome de canal no `FlutterActivity` do Android e no `AppDelegate` do iOS, e chame com `await channel.invokeMethod(...)`. Use `EventChannel` para fluxos do nativo para o Dart (sensores, broadcasts) e `BasicMessageChannel` para bytes ou strings crus. Você só precisa de um plugin federado quando quer reaproveitar a integração em vários apps ou publicá-la no pub.dev. Testado com Flutter 3.27.1, Android Gradle Plugin 8.7.3 e Xcode 16.2 (Swift 5.10).

A expressão "código específico de plataforma" geralmente significa uma única coisa na documentação do Flutter: um method channel que cruza a fronteira Dart-nativo. Essa ponte existe em todo app Flutter, com ou sem plugin. Um plugin é apenas um canal empacotado, com uma fachada em Dart e um registro em tempo de build em dois arquivos `Podfile` / Gradle. Se você só precisa da integração em um app, o empacotamento é overhead. Este post mostra como pular essa parte e ainda manter o código sustentável.

## Por que pular o scaffolding de plugin

`flutter create --template plugin` gera um plugin federado: `my_plugin`, `my_plugin_android`, `my_plugin_ios`, `my_plugin_platform_interface`, mais um app de exemplo. Esse formato é o certo se vários apps vão compartilhar a integração ou se você pretende publicá-la. Para um único app, ele custa:

- Seis arquivos `pubspec.yaml` adicionais e um `melos.yaml` se você quiser CI em um passo só.
- Uma platform interface que adiciona uma indireção para cada método.
- Uma versão de pacote separada para incrementar quando o código do app quiser chamar um novo método nativo.
- Um segundo ambiente de teste (o app `example/` do plugin) que vai se descolar do app real.

Em uma base de código de um único app, o canal pode viver ao lado do recurso que o usa. Um botão que alterna o estado da lanterna e um `FlashlightService` que envolve o canal são vinte linhas de Dart e vinte linhas de Kotlin / Swift.

## Os três canais de que você realmente precisa

O Flutter inclui três tipos de canal em `package:flutter/services.dart`. Escolha pela forma da chamada, não pelo recurso.

- `MethodChannel`: requisição / resposta. O Dart chama um método nomeado no lado nativo, aguarda um resultado, e o lado nativo pode lançar um erro tipado. Use para "abrir um seletor de arquivos", "obter o modelo do dispositivo", "vibrar por 200 ms".
- `EventChannel`: stream do nativo para o Dart. O lado nativo abre um `StreamSink`; o Dart se inscreve e escuta. Use para sensores, broadcast receivers do sistema (estado de carga, mudança de rede), ou qualquer callback que o sistema operacional dê para você.
- `BasicMessageChannel`: mensagens cruas, sem tipo, com um codec à sua escolha (`StandardMessageCodec`, `JSONMessageCodec`, `StringCodec`, `BinaryCodec`). Use quando você controla os dois lados e quer evitar o overhead do nome de método, ou quando está enviando bytes (frames de áudio, buffers de imagem).

Os três são assíncronos no lado Dart. Os três serializam a carga útil por meio de um `MessageCodec`. O codec padrão é `StandardMessageCodec`, que entende um conjunto fixo e pequeno de tipos. Se sua carga útil não couber nesse conjunto, você mesmo serializa.

## Tabela de tipos do StandardMessageCodec

Esta é a tabela para deixar aberta enquanto você escreve código de canal. Qualquer coisa fora dela volta como `null` ou lança, dependendo da plataforma.

| Dart                                | Android (Java/Kotlin)               | iOS (Swift)                                  |
| ----------------------------------- | ----------------------------------- | -------------------------------------------- |
| `null`                              | `null`                              | `nil` / `NSNull`                             |
| `bool`                              | `Boolean`                           | `Bool` / `NSNumber(value: Bool)`             |
| `int` (32 or 64 bit)                | `Integer` / `Long`                  | `Int32` / `Int64` / `NSNumber`               |
| `double`                            | `Double`                            | `Double` / `NSNumber(value: Double)`         |
| `String`                            | `String`                            | `String`                                     |
| `Uint8List`                         | `byte[]`                            | `FlutterStandardTypedData(bytes:)`           |
| `Int32List` / `Int64List` / `Float64List` | `int[]` / `long[]` / `double[]` | `FlutterStandardTypedData(int32:)` etc.      |
| `List<dynamic>`                     | `List<Object?>`                     | `[Any?]`                                     |
| `Map<dynamic, dynamic>`             | `Map<Object?, Object?>`             | `[AnyHashable: Any?]`                        |

`DateTime`, classes personalizadas e `BigInt` não estão na lista. Converta para `int` (epoch ms), `Map` ou `String` na fronteira.

## Um exemplo completo de MethodChannel: nível de bateria

É o exemplo canônico do Flutter, expandido para mostrar a estrutura de arquivos que você de fato entregaria.

### 1. Lado Dart (`lib/services/battery_service.dart`)

```dart
// Flutter 3.27.1, Dart 3.6
import 'package:flutter/services.dart';

class BatteryUnavailable implements Exception {
  final String message;
  BatteryUnavailable(this.message);
  @override
  String toString() => 'BatteryUnavailable: $message';
}

class BatteryService {
  static const _channel = MethodChannel('com.example.app/battery');

  Future<int> getBatteryLevel() async {
    try {
      final level = await _channel.invokeMethod<int>('getBatteryLevel');
      if (level == null) throw BatteryUnavailable('null result');
      return level;
    } on PlatformException catch (e) {
      throw BatteryUnavailable(e.message ?? e.code);
    } on MissingPluginException {
      throw BatteryUnavailable('handler not registered on this platform');
    }
  }
}
```

Três detalhes que merecem atenção. Primeiro, o nome do canal é DNS reverso mais um sufixo de recurso; é a convenção que todo plugin Flutter segue e evita colisões com algum pacote futuro. Segundo, `invokeMethod<int>` é genérico, o que dá um sinal em tempo de compilação sobre o que o codec deve produzir. Terceiro, `MissingPluginException` é lançada quando o nome do canal não está registrado na plataforma em execução. Capture e converta em um erro razoável; caso contrário, o usuário recebe um stack trace de `package:flutter`.

### 2. Lado Android (`android/app/src/main/kotlin/.../MainActivity.kt`)

```kotlin
// AGP 8.7.3, Kotlin 2.0, Flutter 3.27.1
package com.example.app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.app/battery"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getBatteryLevel" -> {
                        val level = readBatteryLevel()
                        if (level >= 0) result.success(level)
                        else result.error("UNAVAILABLE", "Battery level not available", null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun readBatteryLevel(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } else {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val l = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val s = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (l >= 0 && s > 0) (l * 100) / s else -1
        }
    }
}
```

`configureFlutterEngine` roda uma vez por engine, não uma vez por recriação de activity, então é o lugar seguro para conectar o handler. Não registre o canal dentro de `onCreate` se sua `MainActivity` estende `FlutterFragmentActivity`, ou você vai vazar handlers a cada mudança de configuração.

### 3. Lado iOS (`ios/Runner/AppDelegate.swift`)

```swift
// Xcode 16.2, Swift 5.10, iOS 13+ deployment target, Flutter 3.27.1
import UIKit
import Flutter

@main
@objc class AppDelegate: FlutterAppDelegate {
    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let controller = window?.rootViewController as! FlutterViewController
        let channel = FlutterMethodChannel(
            name: "com.example.app/battery",
            binaryMessenger: controller.binaryMessenger
        )

        channel.setMethodCallHandler { [weak self] call, result in
            guard call.method == "getBatteryLevel" else {
                result(FlutterMethodNotImplemented)
                return
            }
            self?.readBatteryLevel(result: result)
        }

        GeneratedPluginRegistrant.register(with: self)
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    private func readBatteryLevel(result: FlutterResult) {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        if device.batteryState == .unknown {
            result(FlutterError(code: "UNAVAILABLE", message: "Battery info unavailable", details: nil))
        } else {
            result(Int(device.batteryLevel * 100))
        }
    }
}
```

Três pontos específicos da plataforma. Primeiro, `isBatteryMonitoringEnabled` precisa ser `true` antes de ler `batteryLevel`, senão você recebe `-1.0`. Segundo, `FlutterError` é o equivalente em iOS do `result.error(...)` do Android; aparece no Dart como `PlatformException`. Terceiro, `GeneratedPluginRegistrant.register(with: self)` continua presente mesmo sem você ter escrito plugin algum: o build ainda emite um registrante para qualquer plugin transitivo no `pubspec.yaml`.

## EventChannel para streams

`MethodChannel` está errado para "me avise quando o estado da bateria mudar". Você acabaria fazendo polling. `EventChannel` deixa o lado nativo empurrar.

### Assinante em Dart

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

class BatteryStateService {
  static const _events = EventChannel('com.example.app/battery_state');

  Stream<String> watch() => _events
      .receiveBroadcastStream()
      .map((dynamic event) => event as String);
}
```

`receiveBroadcastStream()` retorna um único broadcast stream compartilhado por todos os ouvintes. Cancelar a última assinatura avisa o lado nativo para desmontar o broadcast receiver / observer, então não guarde uma referência para uma assinatura que você não usa.

### Handler no Android

```kotlin
// AGP 8.7.3, Kotlin 2.0
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import io.flutter.plugin.common.EventChannel

class BatteryStateStreamHandler(private val context: Context) : EventChannel.StreamHandler {
    private var receiver: BroadcastReceiver? = null

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                               status == BatteryManager.BATTERY_STATUS_FULL
                events.success(if (charging) "charging" else "discharging")
            }
        }
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    }

    override fun onCancel(arguments: Any?) {
        if (receiver != null) {
            context.unregisterReceiver(receiver)
            receiver = null
        }
    }
}
```

Conecte dentro de `configureFlutterEngine`:

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/battery_state")
    .setStreamHandler(BatteryStateStreamHandler(applicationContext))
```

Use `applicationContext`, não a activity, ou você vaza a activity pela vida toda do broadcast receiver.

### Handler no iOS

```swift
// Swift 5.10
import Flutter
import UIKit

class BatteryStateStreamHandler: NSObject, FlutterStreamHandler {
    private var sink: FlutterEventSink?

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(stateChanged),
            name: UIDevice.batteryStateDidChangeNotification,
            object: nil
        )
        stateChanged()
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        NotificationCenter.default.removeObserver(self)
        sink = nil
        return nil
    }

    @objc private func stateChanged() {
        let s = UIDevice.current.batteryState
        sink?(s == .charging || s == .full ? "charging" : "discharging")
    }
}
```

E no `AppDelegate`:

```swift
let stateChannel = FlutterEventChannel(
    name: "com.example.app/battery_state",
    binaryMessenger: controller.binaryMessenger
)
stateChannel.setStreamHandler(BatteryStateStreamHandler())
```

Envie um valor inicial em `onListen` para que o primeiro `await for (final s in service.watch())` não fique esperando pelo primeiro broadcast do sistema operacional.

## BasicMessageChannel para cargas cruas

`BasicMessageChannel` pula o dispatcher de nomes de método e usa o codec que você passar. Útil quando os dois lados são seus e a carga útil é uniforme.

```dart
// Flutter 3.27.1
import 'package:flutter/services.dart';

final _logChannel = BasicMessageChannel<String>(
  'com.example.app/log',
  StringCodec(),
);

Future<void> sendLog(String line) => _logChannel.send(line) as Future<void>;
```

```kotlin
// AGP 8.7.3, Kotlin 2.0
import io.flutter.plugin.common.BasicMessageChannel
import io.flutter.plugin.common.StringCodec

BasicMessageChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/log", StringCodec.INSTANCE)
    .setMessageHandler { message, reply ->
        android.util.Log.i("flutter", message ?: "")
        reply.reply(null)
    }
```

Para cargas binárias, use `BinaryCodec` nos dois lados e você recebe `ByteData` no Dart, `ByteBuffer` no Kotlin, `FlutterStandardTypedData` no Swift.

## Modelo de threading e os detalhes que mordem

O canal em si é assíncrono, mas o callback do handler roda na thread de plataforma, não em uma thread de fundo.

- **Android**: handlers rodam na main thread do Android. Trabalho longo bloqueia a thread de UI e causa ANR. Mova o trabalho para uma coroutine ou para `Executors.newSingleThreadExecutor()`, e depois chame `result.success(...)` de volta na main thread (`Handler(Looper.getMainLooper()).post { ... }`).
- **iOS**: handlers rodam na `DispatchQueue` principal. Mesma regra: faça o trabalho em uma fila de fundo, despache a chamada `result(...)` de volta para a main.
- **Isolates de fundo**: `MethodChannel` historicamente exigia o isolate raiz. A partir do Flutter 3.7+ você pode passar um `binaryMessenger` personalizado de um isolate de fundo usando `BackgroundIsolateBinaryMessenger.ensureInitialized(token)`, mas só para canais que você cria, e só para codecs que não capturem estado local do isolate.
- **Hot restart**: o hot restart re-executa `main()`, mas não re-executa `configureFlutterEngine`. Handlers registrados em `configureFlutterEngine` sobrevivem a um hot restart, que é o que você quer. Handlers registrados dentro do `initState` de um widget Flutter, não, porque a engine guarda o registro anterior e você acaba com dois handlers.

A armadilha de "dois handlers" é a causa mais comum de `MissingPluginException` depois de um hot reload: alguém registrou o handler a partir de um widget, o widget reconstruiu, o handler antigo continuou lá, o novo briga pelo canal. Registre os canais exatamente uma vez, em `MainActivity.configureFlutterEngine` ou em `AppDelegate.application(_:didFinishLaunchingWithOptions:)`.

## Erros, tipos e codecs na prática

Três regras mantêm o código de canal chato:

1. **Sempre tipe o lado Dart**: `invokeMethod<int>`, `invokeMethod<String>`, `invokeMethod<Map<Object?, Object?>>`. O codec é dinâmico em tempo de execução; você quer a verificação estática.
2. **Sempre envie `result.error(code, message, details)` do nativo**: `code` vira `PlatformException.code`, que é o que seu código Dart usa no switch. Nunca lance de dentro do handler; `MethodChannel` não consegue transformar uma exceção do Kotlin em `PlatformException` a menos que você embrulhe.
3. **Converta na fronteira**: não envie um `Map<String, Object>` com tipos misturados e parseie do outro lado. Defina um DTO pequeno (`{level: int, charging: bool}`) e escreva um construtor `fromMap` em cada lado. Se o DTO crescer além de quatro campos, use [Pigeon](https://pub.dev/packages/pigeon) para gerar o marshalling, mas os canais em si continuam seus.

## Quando um plugin ainda compensa

Pule o plugin até que uma destas seja verdadeira:

- Você quer publicar no pub.dev. Plugins têm um contrato firme para a platform interface.
- A mesma integração é necessária em três ou mais apps. A terceira cópia é quando o custo de um pacote privado fica abaixo do custo de manter os canais em sincronia.
- Você precisa de imports condicionais para `web`, `windows` ou `linux` para que o código Dart não tente chamar um lado nativo inexistente. O padrão de plugin federado resolve isso com uma implementação default vazia; em um único app você replica a mesma ideia na mão com uma classe stub.
- Você precisa registrar vários canais e quer que sejam anexados de forma preguiçosa. `FlutterPlugin.onAttachedToEngine` é o hook de ciclo de vida suportado; rolar uma versão sua é fácil de errar no Android assim que você começa a lidar com attach / detach de activities.

Para a cauda longa (um canal, um app, um par de plataformas), a abordagem inline acima é o que bases de código Flutter em produção fazem na prática.

## Relacionado

- A [solução para MissingPluginException 'No implementation found for method getAll'](/pt-br/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) cobre o que fazer quando um canal registrado ainda lança em builds de release (ProGuard, registro de plugin, hot restart).
- Para uma configuração de CI multi-versão que exercita seu código de canal contra vários SDKs do Flutter, veja [como mirar várias versões do Flutter em uma única pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- Se seu código de plataforma está do lado .NET e a integração é MAUI em vez de Flutter, o [guia MAUI só para Windows e macOS](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) mostra o equivalente de gating por target framework.

## Fontes

- Documentação do Flutter, [Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels).
- Referência da API do Flutter, [MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html), [EventChannel](https://api.flutter.dev/flutter/services/EventChannel-class.html), [BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html).
- Referência da API do Flutter, [StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html) para a tabela de tipos suportados.
- Documentação do Android, [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager).
- Documentação da Apple, [UIDevice batteryLevel](https://developer.apple.com/documentation/uikit/uidevice/1620042-batterylevel).
- Canais de isolate de fundo do Flutter, [BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html) (Flutter 3.7+).
