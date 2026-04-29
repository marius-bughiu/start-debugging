---
title: "Flutter Particles 2.0.2: краткий обзор (и небольшой фрагмент интеграции) на Flutter 3.x"
description: "particles_flutter 2.0.2 добавляет формы частиц, вращение, режимы границ и эмиттеры. Краткий обзор изменений и небольшой фрагмент интеграции для проектов Flutter 3.x."
pubDate: 2026-01-23
tags:
  - "flutter"
lang: "ru"
translationOf: "2026/01/flutter-particles-2-0-2-a-quick-tour-and-a-tiny-integration-snippet-on-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
Если вы строите UI на Flutter, которым нужна "жизнь" (фоновое движение, тонкие эффекты празднования, экраны загрузки, которые не выглядят скучно), системы частиц относятся к самым эффективным инструментам, которые можно добавить. Тред о релизе за последние 48 часов анонсирует `particles_flutter` 2.0.2 с реальным шагом по возможностям: формы, вращение, поведение на границах и эмиттеры: [https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/](https://www.reddit.com/r/FlutterDev/comments/1qfjp1g/just_released_flutter_particles_200_major/).

Upstream:

-   pub.dev: [https://pub.dev/packages/particles_flutter](https://pub.dev/packages/particles_flutter)
-   GitHub: [https://github.com/rajajain08/particles_flutter](https://github.com/rajajain08/particles_flutter)

## Что реально изменилось в 2.0.x (и почему это важно)

Интересная часть этого релиза не в "новом номере версии". Дело в том, что библиотека ушла от базового хелпера в стиле "точки на канвасе" к небольшому движку частиц, которому можно задавать форму:

-   **Несколько форм частиц**: круги подходят, но треугольники, прямоугольники и изображения приближают вас к "конфетти", "снегу" или "искре" без собственного кода отрисовки.
-   **Вращение**: вращение делает частицы физически правдоподобными, особенно с не круглыми спрайтами.
-   **Режимы границ**: bounce, wrap и pass-through покрывают большинство реальных UI-сценариев.
-   **Эмиттеры**: поведение спавна обычно становится самым запутанным местом в самописных системах частиц. То, что оно встроено, по-настоящему важно.

Всё это очень хорошо совместимо с проектами на Flutter 3.x и Dart 3.x, где вам нужен эффект, а не выходные за написанием рендерера.

## Добавьте пакет, а потом сделайте его скучно тестируемым

Начните с зафиксированной версии в `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  particles_flutter: ^2.0.2
```

Затем держите эффект частиц изолированным за границей виджета. Тогда, если вы позже замените реализацию (свой `CustomPainter`, Rive, шейдер), остальной UI это не затронет.

## Небольшой фрагмент интеграции, который можно вставить в демо-экран

Точные API меняются от версии пакета, поэтому относитесь к этому как к "форме" интеграции: держите его в `Stack`, делайте неинтерактивным и управляйте контроллером, который можно запускать и останавливать.

```dart
import 'package:flutter/material.dart';

class ParticlesDemoScreen extends StatelessWidget {
  const ParticlesDemoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          // Replace this with the actual particles_flutter widget from the docs.
          // The key point is: keep it behind everything else and keep it cheap.
          const Positioned.fill(
            child: IgnorePointer(
              child: ColoredBox(color: Colors.black),
            ),
          ),
          Center(
            child: ElevatedButton(
              onPressed: () {},
              child: const Text('Ship it'),
            ),
          ),
        ],
      ),
    );
  }
}
```

Когда вы подключаете настоящий виджет частиц, ориентируйтесь на предсказуемые значения по умолчанию:

-   Ограничивайте максимальное число частиц.
-   Предпочитайте предзагруженные изображения декодированию во время выполнения.
-   Приостанавливайте эффекты, когда экран не виден.

Если нужна авторитетная поверхность API, используйте upstream-документацию и примеры как источник истины: [pub.dev](https://pub.dev/packages/particles_flutter) и [GitHub](https://github.com/rajajain08/particles_flutter).
