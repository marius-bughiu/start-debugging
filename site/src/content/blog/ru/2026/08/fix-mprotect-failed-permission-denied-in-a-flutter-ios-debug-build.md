---
title: "Исправление: mprotect failed: 13 (Permission denied) в отладочной сборке Flutter для iOS"
description: "iOS запрещает Dart VM делать страницы памяти исполняемыми, поэтому JIT падает при запуске. Для iOS 26 нужен Flutter 3.35.0 или новее, для iOS 18.4 достаточно 3.32.0. Никакой entitlement это не лечит."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "ios"
  - "xcode"
lang: "ru"
translationOf: "2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build"
translatedBy: "claude"
translationDate: 2026-08-14
---

Обновите Flutter. Этот сбой возникает потому, что iOS отказывается разрешать Dart VM превращать доступную для записи страницу памяти в исполняемую, а именно это нужно JIT и именно на этом работает режим debug. Flutter 3.35.0 (Dart 3.9.0, 2025-08-14) стал первым стабильным релизом, который переживает такую ситуацию на физических устройствах с iOS 26; Flutter 3.32.0 (Dart 3.8.0) был первым, который пережил её на iOS 18.4. Не существует entitlement, ключа Info.plist или флага сборки, которые можно добавить в старый SDK, чтобы проблема исчезла. Если вы уже на 3.35.0 или новее, а падение осталось, значит в схеме Xcode отсутствует LLDB Init File, и это вторая половина решения.

## Полный текст падения

Приложение умирает внутри `Dart_Initialize`, ещё до построения первого виджета:

```
../../../flutter/third_party/dart/runtime/vm/virtual_memory_posix.cc: 428: error: mprotect failed: 13 (Permission denied)
version=3.7.0 (stable) (Wed Feb 5 04:53:58 2025 -0800) on "ios_arm64"
pid=726, thread=259, isolate_group=vm-isolate(0x11ea52800), isolate=vm-isolate(0x11ebe5800)
os=ios, arch=arm64, comp=no, sim=no
  pc 0x0000000110302e84 fp 0x000000016eee4f50 Dart_DumpNativeStackTrace+0x18
  pc 0x000000010feb1428 fp 0x000000016eee4f70 dart::Assert::Fail(char const*, ...) const+0x30
  pc 0x000000010ffac33c fp 0x000000016eee5420 dart::Code::FinalizeCode(...)+0x82c
  pc 0x0000000110039cb0 fp 0x000000016eee5a30 dart::StubCode::Init()+0x320
  pc 0x000000010fefc4f4 fp 0x000000016eee64e0 dart::Dart::DartInit(Dart_InitializeParams const*)+0x2b18
  pc 0x00000001102e9754 fp 0x000000016eee6960 Dart_Initialize+0x60
  pc 0x000000010fe71e24 fp 0x000000016eee6f30 flutter::DartVM::Create(...)+0x1d64
=== Crash occurred when compiling unknown function in unoptimized JIT mode in unknown pass
```

Три детали опознают проблему однозначно. Кадр называется `dart::StubCode::Init()`, он выполняется раньше, чем появляется ваш код, поэтому ваш Dart здесь ни при чём. Число `13` соответствует `EACCES` от POSIX-функции `mprotect`. А последняя строка прямо упоминает режим JIT.

## Почему iOS отклоняет вызов mprotect

Отладочные сборки Flutter запускают Dart VM в режиме JIT. Это не деталь реализации, от которой можно отказаться: hot reload работает за счёт компиляции нового Dart-кода в машинный код прямо внутри работающего процесса, то есть VM пишет байты в страницу памяти, а затем исполняет их.

Политика W^X от Apple гласит, что страница может быть либо доступной для записи, либо исполняемой, но никогда одновременно. Классический обход состоит в том, чтобы выделить страницу как RW, записать туда скомпилированный код, а затем вызвать `mprotect(PROT_READ | PROT_EXEC)`. Именно так и поступала Dart VM в `VirtualMemory::Protect` в файле `runtime/vm/virtual_memory_posix.cc`.

Начиная с бета-версий iOS 18.4 и с дополнительным ужесточением в iOS 26 ядро перестало разрешать такой переход сторонним приложениям, даже при наличии entitlement `get-task-allow`, который есть у сборки для разработки. `mprotect` возвращает `EACCES`, срабатывает `ASSERT` внутри VM, и процесс аварийно завершается. Об этом полностью посвящена задача [flutter/flutter#163984](https://github.com/flutter/flutter/issues/163984), приоритет P1, открытая с февраля по июль 2025 года и собравшая 61 комментарий.

Два следствия, которые стоит усвоить до того, как начнёте что-то менять:

**Сборки release и profile не затронуты.** Они компилируются AOT. Машинный код уже находится в бинарнике приложения, загрузчик отображает его как исполняемый, и VM никогда не запрашивает смену защиты. Если ваш CI зелёный, а сборка в TestFlight запускается, это ожидаемо и никак не подтверждает, что с вашей конфигурацией всё в порядке.

**Симулятор не затронут.** Он работает на ядре macOS, которое это ограничение не применяет. В команде, где один человек тестирует на симуляторе, а другой на устройстве, картина расколется ровно пополам, и именно поэтому первый час поисков выглядит настолько запутанно.

## Какая версия Flutter действительно нужна

Исправление пришло двумя частями, в двух разных стабильных релизах. Происхождение коммитов я проверял через GitHub Compare API по тегам релизов Dart SDK, а не по обсуждению в задаче.

| Цель | Первая рабочая стабильная версия | Dart | Дата выхода |
| --- | --- | --- | --- |
| Физическое устройство с iOS 18.4 | Flutter 3.32.0 | 3.8.0 | 2025-05-20 |
| Физическое устройство с iOS 26 | Flutter 3.35.0 | 3.9.0 | 2025-08-14 |
| iOS 26, инструмент сам управляет LLDB | Flutter 3.38.0 | 3.10.0 | 2025-11-12 |

Первая часть, это хук `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` в VM, добавленный коммитом Dart `939699a9` от 2025-02-28. Он является предком тега `3.8.0`, поэтому есть во всём начиная с Flutter 3.32.0.

Вторая часть, это двойное отображение страниц кода, три коммита июня 2025 года (`d194fcec`, `dc0567c0`, `c111f693`). Они являются предками `3.9.0`, но не `3.8.1`, и поэтому 3.32.x падает на iOS 26, а 3.35.0 нет. Вместо переключения защиты одного отображения VM теперь отображает одну и ту же физическую память дважды: представление RW, через которое пишет компилятор, и отдельное представление RX, из которого исполняет процессор. Вызова `mprotect` нет, отклонять ядру нечего.

Практическая инструкция сводится к одной строке:

```bash
# Latest stable at time of writing is 3.47.0 (Dart 3.13.0, 2026-08-12)
flutter upgrade
flutter clean
```

`flutter clean` здесь не суеверие. Инструмент Flutter пишет сгенерированные файлы LLDB в `ios/Flutter/ephemeral/`, и устаревшие копии от предыдущего SDK вызывали сбои, о которых неоднократно сообщали в задаче, пока исправление раскатывали.

## Я на Flutter 3.35 или новее, а падение осталось

Значит с VM всё в порядке, а со стороной отладчика нет. Двойного отображения необходимо, но недостаточно: отображение RX становится корректным только после того, как отладчик коснётся страниц, поэтому LLDB обязан участвовать в запуске. Flutter подключает его через схему Xcode, и если в схеме этой настройки нет, вы получаете то же самое падение на `mprotect`.

Инструмент пытается мигрировать схему за вас при каждой сборке debug или profile. Когда это не удаётся, он печатает следующее:

```
Running Flutter in debug mode on new iOS versions requires a LLDB Init File,
but the Runner scheme does not have it set. To ensure debug mode works, please
complete the following:
  * Open Xcode > Product > Scheme > Edit Scheme and for the Run and Test actions,
    set LLDB Init File to:

  $(SRCROOT)/Flutter/ephemeral/flutter_lldbinit
```

Сделайте ровно это и учтите, что нужны обе операции, Run и Test. Миграция проверяет их независимо и пожалуется на ту, которой не хватает. Если у вас уже есть собственный LLDB Init File, Flutter не станет его перезаписывать, а предложит подключить свой файл из вашего:

```
command source /path/to/ios/Flutter/ephemeral/flutter_lldbinit
```

В проекте add-to-app путь другой, потому что модуль Flutter собирается как Swift-пакет и сгенерированные файлы попадают в вывод пакета. Укажите в схеме LLDB Init File как `$(FLUTTER_SWIFT_PACKAGE_OUTPUT)/Scripts/flutter_lldbinit` либо подключите его относительно вашего собственного файла:

```
command source --relative-to-command-file "../my_flutter_app/build/ios/SwiftPackages/Scripts/flutter_lldbinit"
```

Хост-проекты add-to-app получают здесь предупреждение, а не ошибку, потому что инструмент не может знать, какую из ваших схем вы запускаете. Он просматривает все файлы `.xcscheme` в проекте на наличие строки `customLLDBInitFile` и предупреждает, только если её нет ни в одном. Проект с пятью схемами, где настроена не та, эту проверку пройдёт и всё равно упадёт.

## Как JIT вообще работает, если mprotect заблокирован

Разобраться стоит, потому что это объясняет ограничение из следующего раздела.

Сгенерированный файл `ios/Flutter/ephemeral/flutter_lldb_helper.py` ставит точку останова на символ, который VM экспортирует исключительно как сигнал отладчику, а затем пишет в страницы со стороны отладчика, которому разрешено менять исполняемую память отлаживаемого процесса:

```python
# Generated by Flutter 3.44.2 into ios/Flutter/ephemeral/flutter_lldb_helper.py
import lldb

def handle_new_rx_page(frame: lldb.SBFrame, bp_loc, extra_args, intern_dict):
    """Intercept NOTIFY_DEBUGGER_ABOUT_RX_PAGES and touch the pages."""
    base = frame.register["x0"].GetValueAsAddress()
    page_len = frame.register["x1"].GetValueAsUnsigned()

    data = bytearray(page_len)
    data[0:8] = b'IHELPED!'

    error = lldb.SBError()
    frame.GetThread().GetProcess().WriteMemory(base, data, error)
    if not error.Success():
        print(f'Failed to write into {base}[+{page_len}]', error)
        return

def __lldb_init_module(debugger: lldb.SBDebugger, _):
    target = debugger.GetDummyTarget()
    bp = target.BreakpointCreateByRegex("^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$")
    bp.SetScriptCallbackFunction('{}.handle_new_rx_page'.format(__name__))
    bp.SetAutoContinue(True)
    print("-- LLDB integration loaded --")
```

Маркер `IHELPED!` служит диагностикой: `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` читает первые восемь байт обратно и благодаря этому отличает ситуацию "отладчик обработал страницу" от ситуации "точка останова так и не была поставлена", а это и есть разница между рабочей конфигурацией и падением из начала статьи.

Если в консоли Xcode вы видите `-- LLDB integration loaded --`, значит init file подключён верно.

## Что изменилось во Flutter 3.38 и новее

Начиная с Flutter 3.38.0 инструмент перестал делегировать запуск на физических устройствах Xcode и сам управляет `devicectl` и `lldb` (PR [#173417](https://github.com/flutter/flutter/pull/173417), [#173443](https://github.com/flutter/flutter/pull/173443) и [#173724](https://github.com/flutter/flutter/pull/173724)). `flutter run` запускает приложение в остановленном состоянии, а затем подаёт LLDB такую последовательность:

```
device select <device-id>
breakpoint set --func-regex '^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$'
breakpoint command add --script-type python <breakpoint-id>
device process attach --pid <app-pid>
process continue
```

Всё это скрыто за feature flag, включённым по умолчанию во всех каналах. Проверено на локальной установке Flutter 3.44.2, файл `packages/flutter_tools/lib/src/features.dart` объявляет:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/features.dart
const lldbDebugging = Feature(
  name: 'support for debugging with LLDB for physical iOS devices',
  configSetting: 'enable-lldb-debugging',
  environmentOverride: 'FLUTTER_LLDB_DEBUGGING',
  master: FeatureChannelSetting(available: true, enabledByDefault: true),
  beta: FeatureChannelSetting(available: true, enabledByDefault: true),
  stable: FeatureChannelSetting(available: true, enabledByDefault: true),
);
```

Требуются iOS 17 или новее и Xcode 26 или новее. Ниже любого из этих порогов инструмент молча возвращается к запуску через Xcode, и поэтому машина, на которой всё ещё стоит Xcode 16, может показывать совершенно другие симптомы, чем машина коллеги с той же версией Flutter. Сверьте `xcodebuild -version`, прежде чем сравнивать наблюдения.

Отключить это можно глобально или для отдельного проекта, если механизм ведёт себя плохо:

```bash
flutter config --no-enable-lldb-debugging
```

```yaml
# pubspec.yaml, disables LLDB debugging for this project only
flutter:
  config:
    enable-lldb-debugging: false
```

## Что делать, если обновить Flutter нельзя

Если вы зафиксированы на старом SDK, а фиксации на 3.7.x в обсуждении задачи встречались часто, ни бэкпорта, ни решения внутри приложения нет. Остаются три варианта: тестировать на симуляторе, тестировать на устройстве с iOS 18.3 или старше, либо запускать `flutter run --profile`, который компилируется AOT и потому неуязвим. Режим profile стоит вам hot reload, но сохраняет DevTools, временную шкалу и инспектор виджетов, так что как временная мера для работы над UI без частых итераций он вполне пригоден.

Поднять давно зафиксированный SDK через четыре стабильных релиза, это отдельный проект. Если вы ведёте несколько приложений с разными фиксациями, [сборка под несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) обойдётся дешевле, чем обновлять всё сразу.

## Ловушки, похожие на эту ошибку, но другие по природе

**Отладочной сборке теперь нужен постоянно подключённый отладчик.** Запуск debugserver на устройстве и есть то, что делает JIT легальным, поэтому сборка debug, запущенная с домашнего экрана без подключённого отладчика, упадёт точно так же. Это не регрессия, о которой стоит сообщать, это механизм. Для всего, что вы отдаёте тестировщикам, используйте сборку profile или release.

**Беспроводная отладка на iOS 26 медленная, а не сломанная.** Flutter 3.44 печатает "Wireless debugging on iOS 26 may be slower than expected. For better performance, consider using a wired (USB) connection." Каждая передача страницы RX означает обращение к отладчику и обратно, а по Wi-Fi это накапливается. Несколько сообщений о десятисекундных зависаниях в исходной задаче оказались именно этим. Подключите кабель, прежде чем заводить баг.

**Сборки release в CI, которые жалуются на `customLLDBInitFile`.** Миграция схемы выполняется только для сборок debug и profile, но неправильно настроенная схема всё равно может проявиться в релизных пайплайнах. Если ваш CI падает из-за init file на релизной сборке, проблема в схеме, а не в этом падении: в релизной сборке нет JIT и LLDB не нужен.

**У флейворов свои схемы.** Flutter мигрирует ту схему, которая разрешается для собираемого флейвора. Если у вас есть схемы `dev`, `staging` и `prod`, а локально вы запускаете только `dev`, две остальные останутся немигрированными до первой сборки, и каждая упадёт по одному разу.

**Всё, что упоминает `mprotect` на Android, относится к другой проблеме.** Сбои сборки под Android вокруг страниц памяти почти всегда связаны с требованием страниц по 16 КБ, а это вопрос упаковки и выравнивания, а не JIT. У него [собственное решение с NDK r28 и zipalign](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Связанные материалы

Если приложение вообще не доходит до запуска, сбой произошёл раньше VM: [Failed to build iOS app с Xcode 16 и Flutter 3.x](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) и [CocoaPods не находит совместимых версий для пода](/ru/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) покрывают два сбоя, на которые приходится большая часть остального. Поскольку это падение воспроизводится только на железе, полезно иметь [рабочий процесс с реальным устройством для отладки Flutter iOS из Windows](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/), чтобы Mac не был обязательным условием для воспроизведения. А если обновление до 3.35 или новее тянет за собой много другой поломки, [чек-лист null safety для Flutter 3.x](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) задаёт порядок, которым я пользуюсь на старых кодовых базах.

## Источники

- [Debug mode and hot reload fail on iOS 26 due to JIT restriction `error: mprotect failed: 13 (Permission denied)`](https://github.com/flutter/flutter/issues/163984), отслеживающая задача уровня P1, за исходный дамп падения и хронологию исправления.
- [Add lldb init file](https://github.com/flutter/flutter/pull/164344) (flutter/flutter#164344, влит 2025-03-06), вошедший в [заметки о выпуске Flutter 3.32.0](https://docs.flutter.dev/release/release-notes/release-notes-3.32.0).
- [Заметки о выпуске Flutter 3.38.0](https://docs.flutter.dev/release/release-notes/release-notes-3.38.0), за переход на LLDB и `devicectl` как основной путь запуска на iOS 17+ с Xcode 26+.
- [Integrate a Flutter app into your iOS project](https://docs.flutter.dev/add-to-app/ios/project-setup), за пути к LLDB Init File в сценарии add-to-app.
- Коммиты Dart SDK `939699a9` (`[vm] Add NOTIFY_DEBUGGER_ABOUT_RX_PAGES hook`), `d194fcec` (`[vm] Use dual mapping of code pages on certain OS versions`), `dc0567c0` и `c111f693`, происхождение по тегам сверено с релизными тегами `3.8.1` и `3.9.0`.
- Код процитирован из локальной установки Flutter 3.44.2 stable: `packages/flutter_tools/lib/src/features.dart`, `lib/src/ios/lldb.dart`, `lib/src/xcode_project.dart`, `lib/src/migrations/lldb_init_migration.dart` и `lib/src/build_system/targets/ios.dart`.
