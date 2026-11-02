---
title: "Исправление: LateInitializationError: Field '...' has not been initialized в Flutter"
description: "Исправьте чтение неинициализированных late-полей во Flutter: синхронная инициализация или явные состояния загрузки, ошибки и данных с проверенным кодом."
pubDate: 2026-06-24
updatedDate: 2026-11-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Чтение поля `late`, которому ещё не присвоено значение, вызывает `LateInitializationError`. Найдите чтение в первом кадре стека вашего кода и проверьте, какая ветка должна была выполнить присваивание. `late` не ожидает завершения асинхронной операции. Примеры проверены на Flutter 3.44.8 и Dart 3.12.2.

## Воспроизведение ошибки

Эта программа компилируется, но завершается ошибкой при чтении `name`:

```dart
class Profile {
  late String name;
}

void main() {
  print(Profile().name);
}
```

Dart VM выводит `LateInitializationError: Field 'name' has not been initialized.` Это диагностическое сообщение, а не имя публичного класса `dart:core`, который нужно импортировать или отдельно перехватывать. Исправьте отсутствующую инициализацию.

## Представьте загрузку, ошибку и данные

Запрос, запущенный в `initState()`, может ещё выполняться во время первого `build()`. Этот законченный виджет использует nullable-состояние и обрабатывает успех и ошибку. Передайте асинхронную функцию в `loadName`:

```dart
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.loadName});
  final Future<String> Function() loadName;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final name = await widget.loadName();
      if (!mounted) return;
      setState(() => _name = name);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Text('Failed: $_error');
    final name = _name;
    if (name == null) return const CircularProgressIndicator();
    return Text(name);
  }
}
```

Пример загружает данные один раз на экземпляр `State`. Если запрос зависит от меняющихся входных данных виджета, обрабатывайте изменения в `didUpdateWidget` либо используйте виджет или провайдер с подходящим ключом. Проверки `mounted` предотвращают обновление уничтоженного состояния, но не отменяют запрос. Подойдут и `FutureBuilder` с сохранённым Future, и `AsyncValue`. Само поле для Future может быть `late final`, если присвоено до чтения; результат Future может появиться позже.

## Выберите момент инициализации по зависимости

- **Синхронное значение:** присвойте его до первого чтения, обычно в `initState()`, если нужен `widget`. `TextEditingController` также освобождайте в `dispose()`.
- **Отложенное значение:** `late final value = compute();` запускает инициализатор при первом доступе. Late-инициализатор экземпляра может обращаться к членам экземпляра, включая `widget` в `State`; первый доступ должен соответствовать этапу жизненного цикла. Инициализатор всё ещё может выбросить ошибку или вызвать рекурсию.
- **Унаследованная зависимость:** вызовы, регистрирующие зависимость, например `Theme.of(context)`, размещают в `build()` или `didChangeDependencies()`, а не в `initState()`. Этот метод вызывается до первого build и при изменении зависимостей. Ограничение касается регистрации зависимости, а не любого использования `context`.

## Похожие ошибки и неверные решения

Повторное присваивание полю `late final` вызывает вариант «already initialized». Удалите лишнее присваивание либо сделайте поле изменяемым, если это требуется. `late` не отключает все проверки анализатора: Dart обнаруживает заведомо неинициализированные локальные late-переменные и некоторые повторные присваивания локальным late final. Когда статический анализ не может доказать корректность, остаются проверки времени выполнения. Это не только debug-assertions; текст сообщения может зависеть от backend и режима сборки.

До чтения значение должно быть готово либо ожидание нужно явно представить в состоянии. Сам по себе `await` не делает `late` ошибочным, если все потребители сначала ждут готовности; ошибка — преждевременное чтение виджетом.

**Исправление от 2 ноября 2026 года:** уточнены проверки анализатора, отложенный доступ к членам экземпляра, унаследованные зависимости и диагностика release; удалена ссылка на несуществующий публичный класс ошибки. Обновлённый виджет прошёл анализ и тесты успешной загрузки, ошибки и завершения после уничтожения.

## Источники и связанные статьи

- [Dart: late variables](https://dart.dev/language/variables#late-variables)
- [Dart: definitely_unassigned_late_local_variable](https://dart.dev/tools/diagnostics/definitely_unassigned_late_local_variable)
- [Flutter: initState](https://api.flutter.dev/flutter/widgets/State/initState.html)
- [Flutter: didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)
- [Dart: null safety](https://dart.dev/null-safety/understanding-null-safety#late-variables)

- [BuildContext / await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [TextEditingController / dispose](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Controllers / dispose](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter 2 → 3.x / null safety](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
