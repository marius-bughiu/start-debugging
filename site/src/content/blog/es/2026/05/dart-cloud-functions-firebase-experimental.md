---
title: "Cloud Functions for Firebase ya habla Dart (experimental)"
description: "Firebase lanzó soporte experimental de Dart para Cloud Functions el 2026-05-06. Disparadores HTTPS y callable, arranques en frío AOT y la Firebase CLI compila por ti."
pubDate: 2026-05-19
tags:
  - "dart"
  - "flutter"
  - "firebase"
  - "cloud-functions"
  - "backend"
lang: "es"
translationOf: "2026/05/dart-cloud-functions-firebase-experimental"
translatedBy: "claude"
translationDate: 2026-05-19
---

El 2026-05-06 el equipo de Firebase [anunció el soporte experimental de Dart](https://firebase.blog/posts/2026/05/dart-functions-exp) para Cloud Functions, pocos días antes de Google I/O 2026. Para los equipos de Flutter que venían escribiendo backends en TypeScript por necesidad, esta es la primera ruta oficial hacia un stack 100% Dart en Firebase, con la Firebase CLI encargándose de la compilación y la implementación de extremo a extremo.

## Por qué es importante para los equipos de Flutter

Hoy una aplicación Flutter típica envía su lógica de servidor a Cloud Functions escritas en Node.js o Python. Eso significa dos lenguajes, dos sistemas de tipos, dos conjuntos de reglas de validación y un cambio de contexto constante al modelar el mismo objeto de dominio en ambos lados. Con las funciones nativas en Dart puedes colocar tus clases de datos compartidas, validadores y tipos de resultado en un único `package:` y consumirlos tanto desde la app como desde el backend sin una capa de traducción.

El equipo de Firebase también destaca el arranque en frío como una decisión deliberada de diseño. Como la Firebase CLI compila tu función localmente con `dart compile exe` y sube el binario AOT directamente a Cloud Run, no existe una fase de calentamiento de la VM. Las primeras cifras del anuncio hablan de arranques en frío de alrededor de 10 ms, muy por debajo del estándar habitual de TypeScript sobre Node.js.

## Requisitos previos y la bandera experimental

Según la [guía oficial de inicio](https://firebase.google.com/docs/functions/start-dart), necesitas:

- Dart SDK 3.9 o superior
- Firebase CLI 15.15.0 o superior

La característica está detrás de una bandera experimental, así que la activas una sola vez por máquina:

```bash
firebase experiments:enable dartfunctions
firebase init functions
```

Cuando el asistente de inicialización pregunte por el lenguaje, Dart aparecerá junto a JavaScript, TypeScript y Python.

## Una función HTTPS mínima

El esqueleto generado deja un `functions/bin/server.dart` con un disparador HTTPS. La forma es cercana al SDK de JS pero se lee como Dart idiomático:

```dart
import 'package:firebase_functions/firebase_functions.dart';

void main(List<String> args) {
  runFunctions((firebase) {
    firebase.https.onRequest(
      name: 'hello',
      (request) async {
        return Response.ok('Hello from Dart!');
      },
    );
  });
}
```

Despliega con el comando habitual y la CLI compilará y enviará el binario por ti:

```bash
firebase deploy --only functions
```

Para iterar en local, `firebase emulators:start` funciona igual que con Node.js. Las ediciones en caliente sobre tus archivos Dart recargan la función emulada sin reiniciar el conjunto.

## Lo que todavía no puedes hacer

Es una versión experimental y los bordes ásperos están a la vista. De la documentación:

- Solo los disparadores HTTPS (`onRequest`) y callable (`onCall`) pueden desplegarse. Firestore, Auth, Pub/Sub y los disparadores programados aún no se admiten.
- Las funciones callable desplegadas no pueden invocarse a través del helper `httpsCallable` del SDK cliente. Tienes que usar `httpsCallableFromURL` con la URL completa de Cloud Run.
- Las funciones Dart no aparecen en la Firebase Console durante esta versión preliminar. Aparecen en la Cloud Console en su lugar.

Si tu backend vive principalmente sobre endpoints HTTP y tu equipo ya está metido a fondo en Dart, esto basta para empezar a portar un servicio real. Si dependes de disparadores de Firestore o de trabajos programados, conviene seguir el [repo firebase-functions-dart](https://github.com/firebase/firebase-functions-dart) y el [Dart Admin SDK](https://pub.dev/packages/firebase_admin), pero quedarte en el runtime de Node.js por ahora.

Espera más sobre esto en Google I/O 2026, donde el equipo de Flutter tiene una [sesión dedicada](https://io.google/2026/explore/pa-keynote-12) ligada al anuncio.
