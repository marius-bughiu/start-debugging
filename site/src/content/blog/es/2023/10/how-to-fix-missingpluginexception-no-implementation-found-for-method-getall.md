---
title: "Cómo arreglar: MissingPluginException: No implementation found for method getAll"
description: "Soluciona el `MissingPluginException` 'No implementation found for method getAll' en Flutter en shared_preferences y plugins similares (package_info_plus, etc.): ProGuard, registro de plugins, minSdkVersion, hot restart."
pubDate: 2023-10-30
updatedDate: 2023-11-01
tags:
  - "flutter"
lang: "es"
translationOf: "2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este es un problema bastante común que normalmente aparece en builds de release de Flutter. La mayoría de las veces el problema se debe a que ProGuard elimina algunas APIs necesarias en tiempo de compilación, lo que provoca excepciones por implementación faltante como la siguiente.

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

Dicho esto, en realidad existen varias causas posibles para este problema y, por tanto, varias soluciones posibles. A continuación, las exploramos todas.

## Desactivar el minificado y el shrinking

Si ProGuard es realmente el culpable, deberíamos poder resolver esto rápidamente con unos pequeños cambios en la configuración. Ve a tu archivo `/android/app/build.gradle` y cambia la configuración de la build de `release` de:

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

A esto:

```gradle
buildTypes {
        release {
            signingConfig signingConfigs.release
            
            minifyEnabled false
            shrinkResources false
        }
}
```

## Actualizar la configuración de ProGuard

Si lo anterior no funcionó, podemos ir un paso más allá modificando la configuración de ProGuard. Para ello, añade las dos líneas siguientes dentro de tu archivo `build.gradle`, justo después de la línea `shrinkResources false`.

```gradle
useProguard true
proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
```

A continuación, crea un nuevo archivo `proguard-rules.pro` en la misma carpeta que tu `build.gradle` (`android/app/proguard-rules.pro`) con el siguiente contenido:

```gradle
-keep class androidx.lifecycle.DefaultLifecycleObserver
```

## Referenciar el plugin de forma explícita en `main.dart`

Si no quieres desactivar el minificado o el shrinking de ProGuard, puedes intentar referenciar explícitamente el plugin en tu archivo `main.dart`. Esto debería ayudar a ProGuard a anclar las dependencias necesarias y no eliminarlas durante la build.

Simplemente intenta llamar a cualquier método del plugin directamente dentro de tu archivo `main.dart` y vuelve a ejecutar la app.

## El plugin no se registró

Asegúrate de que tu plugin está registrado llamando al método `registerWith` en `main.dart`.

```dart
if (Platform.isAndroid) {
    SharedPreferencesAndroid.registerWith();
} else if (Platform.isIOS) {
    SharedPreferencesIOS.registerWith();
}
```

## Trabajando con `background_fetch`

Cuando trabajas con `background_fetch` es importante volver a registrar los plugins dentro de la tarea headless. Simplemente toma el código de registro anterior y añádelo al inicio de la función de la tarea.

```dart
void backgroundFetchTask(HeadlessTask task) async {
    if (Platform.isAndroid) {
        SharedPreferencesAndroid.registerWith();
    } else if (Platform.isIOS) {
        SharedPreferencesIOS.registerWith();
    }
}
```

## `minSdkVersion` demasiado bajo

Puede que estés apuntando a una versión de SDK inferior a la mínima requerida por el plugin. En ese caso, tras un arranque en frío de la app, deberías recibir un error similar al siguiente.

```gradle
The plugin shared_preferences requires a higher Android SDK version.
Fix this issue by adding the following to the file android\app\build.gradle:

android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

Sigue las instrucciones del mensaje de error y el problema debería resolverse.

## La build podría estar en un estado inválido

Quizá no haya nada mal en tu código ni en las dependencias del proyecto. El proyecto puede haber quedado en un estado inválido al instalar el plugin. Para intentar resolverlo, ejecuta el comando `flutter clean`, seguido de `flutter pub get`. Esto hará una restauración limpia de las dependencias del proyecto. Ahora vuelve a ejecutar tu app y comprueba si el problema persiste o no.

## Conflictos con otros paquetes

Hay algunos paquetes que se sabe que entran en conflicto y pueden provocar este problema. Intenta eliminarlos uno a uno para ver si el problema desaparece y, una vez identificado el culpable, prueba a actualizar el paquete, ya que los conflictos pueden estar resueltos en versiones más recientes.

Aquí tienes una lista de paquetes que podrían disparar el `MissingPluginException`:

-   admob\_flutter
-   flutter\_webrtc
-   flutter\_facebook\_login
