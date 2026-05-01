---
title: "Como corrigir: MissingPluginException: No implementation found for method getAll"
description: "Corrija o `MissingPluginException` 'No implementation found for method getAll' do Flutter em shared_preferences e plugins similares (package_info_plus, etc.): ProGuard, registro de plugin, minSdkVersion, hot restart."
pubDate: 2023-10-30
updatedDate: 2023-11-01
tags:
  - "flutter"
lang: "pt-br"
translationOf: "2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esse é um problema bem comum, que costuma aparecer em builds de release do Flutter. Na maior parte das vezes ele é causado por o ProGuard remover algumas APIs necessárias durante a build, levando a exceções de implementação ausente como a abaixo.

```plaintext
Unhandled exception:
MissingPluginException(No implementation found for method getAll on channel plugins.flutter.io/shared_preferences)
      MethodChannel.invokeMethod (package:flutter/src/services/platform_channel.dart:278:7)
<asynchronous suspension>
      SharedPreferences.getInstance (package:shared_preferences/shared_preferences.dart:25:27)
<asynchronous suspension>
      main (file:///lib/main.dart)
<asynchronous suspension>
      _startIsolate.<anonymous closure> (dart:isolate/runtime/libisolate_patch.dart:279:19)
      _RawReceivePortImpl._handleMessage (dart:isolate/runtime/libisolate_patch.dart:165:12)
```

Dito isso, na verdade existem várias causas possíveis para esse problema e, portanto, várias soluções possíveis. Abaixo exploramos todas elas.

## Desabilitar minify e shrink

Se o ProGuard for de fato o culpado, dá para resolver isso rápido com alguns ajustes na configuração. Vá até o arquivo `/android/app/build.gradle` e mude a configuração de build de `release` de:

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

Para isto:

```gradle
buildTypes {
        release {
            signingConfig signingConfigs.release
            
            minifyEnabled false
            shrinkResources false
        }
}
```

## Atualizar a configuração do ProGuard

Se o passo acima não funcionou, podemos ir um pouco além e mudar a configuração do ProGuard. Para isso, adicione as duas linhas a seguir no arquivo `build.gradle`, logo após a linha `shrinkResources false`.

```gradle
useProguard true
proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
```

Em seguida, crie um arquivo `proguard-rules.pro` na mesma pasta do seu `build.gradle` (`android/app/proguard-rules.pro`), com o seguinte conteúdo:

```gradle
-keep class androidx.lifecycle.DefaultLifecycleObserver
```

## Referenciar o plugin explicitamente em `main.dart`

Se você não quer desabilitar o minify e o shrink do ProGuard, pode tentar referenciar o plugin explicitamente no seu arquivo `main.dart`. Isso ajuda o ProGuard a localizar as dependências necessárias e não removê-las durante a build.

Basta chamar qualquer método do plugin diretamente dentro do `main.dart` e rodar o app de novo.

## O plugin não foi registrado

Garanta que seu plugin está registrado chamando o método `registerWith` no `main.dart`.

```dart
if (Platform.isAndroid) {
    SharedPreferencesAndroid.registerWith();
} else if (Platform.isIOS) {
    SharedPreferencesIOS.registerWith();
}
```

## Trabalhando com `background_fetch`

Ao trabalhar com `background_fetch` é importante registrar novamente os plugins dentro da tarefa headless. É só pegar o código de registro acima e colocá-lo no início da função da tarefa.

```dart
void backgroundFetchTask(HeadlessTask task) async {
    if (Platform.isAndroid) {
        SharedPreferencesAndroid.registerWith();
    } else if (Platform.isIOS) {
        SharedPreferencesIOS.registerWith();
    }
}
```

## `minSdkVersion` muito baixo

Talvez você esteja mirando uma versão de SDK menor do que a mínima exigida pelo plugin. Nesse caso, depois de um cold start do app, você deve receber um erro parecido com o de baixo.

```gradle
The plugin shared_preferences requires a higher Android SDK version.
Fix this issue by adding the following to the file android\app\build.gradle:

android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

Basta seguir as instruções da mensagem de erro e o problema deve ser resolvido.

## A build pode estar em estado inválido

Talvez não haja nada de errado com o seu código ou com as dependências do projeto. O projeto pode ter ficado em um estado inválido durante a instalação do plugin. Para tentar resolver, rode o comando `flutter clean`, seguido de `flutter pub get`. Isso faz uma restauração limpa das dependências do projeto. Depois rode o app de novo e veja se o problema continua.

## Conflitos com outros pacotes

Existem alguns pacotes conhecidos por entrar em conflito e provocar esse problema. Tente removê-los um a um para ver se o problema desaparece e, identificando o culpado, tente atualizar o pacote — os conflitos podem ter sido resolvidos em versões mais recentes.

Veja uma lista de pacotes que podem disparar o `MissingPluginException`:

-   admob\_flutter
-   flutter\_webrtc
-   flutter\_facebook\_login
