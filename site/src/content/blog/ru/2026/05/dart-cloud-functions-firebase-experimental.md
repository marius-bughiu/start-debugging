---
title: "Cloud Functions for Firebase теперь говорит на Dart (экспериментально)"
description: "2026-05-06 Firebase выпустил экспериментальную поддержку Dart для Cloud Functions. HTTPS и callable-триггеры, AOT-холодные старты, а компиляцию берёт на себя Firebase CLI."
pubDate: 2026-05-19
tags:
  - "dart"
  - "flutter"
  - "firebase"
  - "cloud-functions"
  - "backend"
lang: "ru"
translationOf: "2026/05/dart-cloud-functions-firebase-experimental"
translatedBy: "claude"
translationDate: 2026-05-19
---

2026-05-06 команда Firebase [анонсировала экспериментальную поддержку Dart](https://firebase.blog/posts/2026/05/dart-functions-exp) в Cloud Functions, за несколько дней до Google I/O 2026. Для команд Flutter, которые до сих пор писали бэкенды на TypeScript просто потому, что иначе нельзя, это первый официальный путь к стеку только на Dart в Firebase, при этом Firebase CLI берёт на себя компиляцию и развёртывание от начала до конца.

## Почему это важно для команд Flutter

Сегодня типичное приложение Flutter отправляет свою серверную логику в Cloud Functions, написанные на Node.js или Python. Это значит два языка, две системы типов, два набора правил валидации и постоянное переключение контекста при моделировании одного и того же доменного объекта с обеих сторон. С нативными функциями на Dart вы можете положить общие классы данных, валидаторы и типы результатов в один `package:` и использовать их как из приложения, так и из бэкенда без промежуточного слоя трансляции.

Команда Firebase также называет холодный старт сознательным решением в дизайне. Поскольку Firebase CLI компилирует вашу функцию локально через `dart compile exe` и загружает AOT-бинарник напрямую в Cloud Run, фаза прогрева VM отсутствует. Первые цифры из релизного поста говорят о холодных стартах около 10 ms, что заметно ниже типичного уровня TypeScript на Node.js.

## Предварительные требования и экспериментальный флаг

Согласно [официальному руководству по запуску](https://firebase.google.com/docs/functions/start-dart), вам понадобятся:

- Dart SDK 3.9 или выше
- Firebase CLI 15.15.0 или выше

Возможность скрыта за экспериментальным флагом, который вы включаете один раз на машину:

```bash
firebase experiments:enable dartfunctions
firebase init functions
```

Когда мастер init спросит про язык, Dart появится рядом с JavaScript, TypeScript и Python.

## Минимальная HTTPS-функция

Сгенерированный шаблон создаёт `functions/bin/server.dart` с одним HTTPS-триггером. Форма близка к JS SDK, но читается как идиоматичный Dart:

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

Разверните привычной командой, и CLI скомпилирует и отправит бинарник за вас:

```bash
firebase deploy --only functions
```

Для локальной итерации `firebase emulators:start` работает так же, как и для Node.js. Горячие правки в файлах Dart перезагружают эмулируемую функцию, не перезапуская весь набор.

## Что пока недоступно

Это экспериментальный релиз, и его шероховатости заявлены открыто. Из документации:

- Развернуть можно только HTTPS- (`onRequest`) и callable-триггеры (`onCall`). Firestore, Auth, Pub/Sub и запланированные триггеры пока не поддерживаются.
- Развёрнутые callable-функции нельзя вызывать через хелпер `httpsCallable` клиентского SDK. Нужно использовать `httpsCallableFromURL` с полным URL Cloud Run.
- Dart-функции не отображаются в Firebase Console во время этой предварительной версии. Вместо этого они появляются в Cloud Console.

Если ваш бэкенд в основном живёт на HTTP-эндпойнтах и команда уже глубоко в Dart, этого достаточно, чтобы начать переносить реальный сервис. Если же вы зависите от триггеров Firestore или запланированных задач, имеет смысл следить за [репозиторием firebase-functions-dart](https://github.com/firebase/firebase-functions-dart) и [Dart Admin SDK](https://pub.dev/packages/firebase_admin), но пока оставаться на рантайме Node.js.

Подробнее об этом ждите на Google I/O 2026, где у команды Flutter [запланирована сессия](https://io.google/2026/explore/pa-keynote-12), привязанная к этому анонсу.
