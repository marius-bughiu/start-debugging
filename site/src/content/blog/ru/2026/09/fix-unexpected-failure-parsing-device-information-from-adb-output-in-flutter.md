---
title: "Исправление: Unexpected failure parsing device information from adb output во Flutter"
description: "Flutter 3.47.0 не может разобрать строки adb с серийным номером из 22 и более символов, поэтому беспроводные и некоторые USB-устройства Android пропадают. Обновитесь до 3.47.1 или новее либо подключайтесь через adb connect по IP."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "adb"
  - "flutter-tools"
lang: "ru"
translationOf: "2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-16
---

Это ошибка парсера во Flutter 3.47.0, и сообщать о ней повторно не нужно. `adb devices -l` дополняет столбец серийного номера до 22 символов и затем добавляет один пробел, поэтому за любым серийным номером длиной 22 символа и более (все имена беспроводной отладки вида `adb-...._adb-tls-connect._tcp`, а также некоторые серийные номера USB) следует ровно один пробел. Парсер 3.47.0 требует в этом месте два пробела или табуляцию, отклоняет строку и не включает устройство в список. Выполните `flutter upgrade`, чтобы получить 3.47.1 или новее (текущая стабильная версия 3.47.4). Если нужно остаться на 3.47.0, подключайте беспроводные устройства через `adb connect <ip>:<port>`: короткий серийный номер в виде IP по-прежнему разбирается.

Всё описанное ниже воспроизведено на macOS с Flutter 3.44.8, 3.47.0 и 3.47.4 (Dart 3.13.0 и 3.13.3). Каждую версию я направлял на тестовый Android SDK, в котором `platform-tools/adb` является поддельным скриптом, и подавал ей одни и те же девять строк устройств.

## Ошибка в контексте

`flutter devices` показывает десктопные и веб-цели, но не телефон, который `adb devices` явно видит:

```text
Found 2 connected devices:
  macOS (desktop) • macos  • darwin-arm64   • macOS 26.6.1 25G76 darwin-arm64
  Chrome (web)    • chrome • web-javascript • Google Chrome 151.0.7922.140

No wireless devices were found.

Unexpected failure parsing device information from adb output:
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:1
Please report a bug at https://github.com/flutter/flutter/issues.
```

В `flutter doctor` её легко пропустить, потому что раздел "Connected device" всё равно получает зелёную галочку, а предупреждение находится под ним:

```text
[✓] Connected device (2 available)
    ! Unexpected failure parsing device information from adb output:
      9b01005930533036340043eb2a5c2c device usb:17907712X product:serenity_p_in model:25028PC03I device:serenity transport_id:1
      Please report a bug at https://github.com/flutter/flutter/issues.
```

Во втором случае это USB-телефон, а не беспроводной, поэтому совет "это бывает только при беспроводной отладке", который встречается в некоторых обсуждениях, неполон. Android Studio и VS Code получают список устройств из того же кода обнаружения, так что устройства нет и в селекторе IDE, а `flutter run -d <serial>` не с чем сопоставить.

Сообщения об ошибке: [flutter/flutter#191167](https://github.com/flutter/flutter/issues/191167) (USB, Flutter 3.47.0 на macOS), [#191119](https://github.com/flutter/flutter/issues/191119) (сопряжение по Wi-Fi на Fedora), [#191343](https://github.com/flutter/flutter/issues/191343) (Ubuntu), а также исходные [#189430](https://github.com/flutter/flutter/issues/189430) и [#189972](https://github.com/flutter/flutter/issues/189972).

## Почему Flutter 3.47.0 отклоняет корректную строку adb

adb формирует каждую строку подробного списка в `append_transport` в `transport.cpp`:

```cpp
// adb (platform/packages/modules/adb), transport.cpp
android::base::StringAppendF(result, "%-22s %s", serial.c_str(),
                             to_string(t->GetConnectionState()).c_str());
```

`%-22s` задаёт минимальную ширину, а не столбец. Серийный номер из 10 символов, например `ZN52278M76`, получает 12 пробелов дополнения плюс литеральный пробел, то есть всего 13 пробелов. Серийный номер из 21 символа получает два. Серийный номер из 22 символов и более получает ровно один. Серийные номера беспроводной отладки представляют собой имя службы mDNS, и один только суффикс `._adb-tls-connect._tcp` занимает 22 символа. Многие серийные номера USB тоже длинные: 30-символьный номер из #191167 как раз такой пример.

Flutter 3.44.x разбирал строки выражением `^(\S+)\s+(\S+)(.*)`: первый токен, любые пробельные символы, второй токен. Один пробел оно обрабатывает без проблем, но ломается, когда сам серийный номер содержит пробел. Если быстро переключать беспроводную отладку, mDNS добавляет суффикс конфликта, и серийный номер превращается в `adb-26151FDF60083B-9tP4nl (2)._adb-tls-connect._tcp`. Flutter 3.44.8 тогда обрезает серийный номер на первом пробеле. Мой поддельный adb записал полученный вызов как `adb -s adb-26151FDF60083B-9tP4nl shell getprop`, а настоящий сервер adb такой обрезанный серийный номер не знает.

Чтобы это исправить, в цикле 3.47 понадобилось три попытки:

1. [#187943](https://github.com/flutter/flutter/pull/187943) перешёл на ленивое сопоставление серийного номера, `^(.*?)\s+(no permissions|\S+)...`, которое вошло в 3.47.0-0.1.pre. Это сломало строки, содержащие devpath без префикса `key:`.
2. [#189369](https://github.com/flutter/flutter/pull/189369) исправил это, явно перечислив известные состояния adb и потребовав `(?:\s{2,}|\t+)` перед состоянием. Изменение перенесли через cherry-pick в бету, и оно вошло в 3.47.0. Именно это правило двух пробелов и есть ошибка, которой посвящена статья.
3. [#189973](https://github.com/flutter/flutter/pull/189973) перешёл на жадный захват серийного номера, привязанный к известным словам состояний, после чего обрезает дополнение. Его перенесли через cherry-pick в стабильную ветку как [#191296](https://github.com/flutter/flutter/pull/191296), и он вошёл в 3.47.1 19 августа 2026 года.

Вот регулярное выражение 3.47.0 из `packages/flutter_tools/lib/src/android/android_device_discovery.dart`:

```dart
// Flutter 3.47.0, android_device_discovery.dart
static final _kDeviceRegex = RegExp(
  r'^(.*?)(?:\s{2,}|\t+)'
  r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)'
  r'(?:\s+(.*)|$)',
);
```

Единственное изменение в 3.47.1 касается первой строки, которая стала `r'^(.*)\s+'`, плюс `trimRight()` для захваченного серийного номера. Файл не меняется с 3.47.1 по 3.47.4 и в бете 3.48.0-0.5.pre.

## Минимальное воспроизведение с поддельным adb

Телефон для этого не нужен. Flutter ищет `adb` по пути `$ANDROID_HOME/platform-tools/adb`, поэтому скрипт оболочки по этому пути может выводить любые строки. Он использует тот же формат `%-22s %s`, что и adb:

```bash
#!/bin/bash
# Fake adb for Flutter 3.44.8 / 3.47.0 / 3.47.4 repros: $SDK/platform-tools/adb
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  printf '%-22s %s\n' "adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" \
    "device product:oriole model:Pixel_6 device:oriole transport_id:2"
  echo
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf '[ro.build.characteristics]: [phone]\n[ro.build.version.release]: [16]\n'
  printf '[ro.build.version.sdk]: [36]\n[ro.product.cpu.abi]: [arm64-v8a]\n'
  exit 0
fi
exit 0
```

```bash
# Flutter 3.47.0 vs 3.47.4, same fake SDK
chmod +x sdk/platform-tools/adb
ANDROID_HOME=$PWD/sdk XDG_CONFIG_HOME=$PWD/xdg flutter devices
```

`XDG_CONFIG_HOME` не даёт пути, когда-то сохранённому через `flutter config --android-sdk`, переопределить `ANDROID_HOME`. Я прогнал девять строк через каждую версию. В таблице показано, что вывел `flutter devices`:

| Строка adb | 3.44.8 | 3.47.0 | 3.47.4 |
|---|---|---|---|
| USB, серийный номер из 10 символов `ZN52278M76` | в списке | в списке | в списке |
| USB, серийный номер из 21 символа | в списке | в списке | в списке |
| USB, серийный номер из 22 символов | в списке | ошибка разбора | в списке |
| USB, серийный номер из 30 символов | в списке | ошибка разбора | в списке |
| Беспроводное mDNS `adb-...._adb-tls-connect._tcp` | в списке | ошибка разбора | в списке |
| Беспроводное mDNS с суффиксом `(2)` | в списке с обрезанным серийным номером | ошибка разбора | в списке |
| Беспроводное `192.168.1.3:36809` | в списке | в списке | в списке |
| Беспроводное mDNS, `unauthorized` | подсказка "is not authorized" | ошибка разбора | подсказка "is not authorized" |
| USB, `detached` | в списке как обычное устройство | ошибка разбора | ошибка разбора |

Граница между 21 и 22 символами объясняет всё. Последняя строка относится к отдельной проблеме, о ней в подводных камнях ниже.

## Исправление 1: обновите Flutter до 3.47.1 или новее

Сначала проверьте, какая у вас версия:

```bash
# Flutter 3.47.x
flutter --version
```

Если в первой строке написано `Flutter 3.47.0`, обновитесь на стабильном канале:

```bash
# moves 3.47.0 to the latest 3.47.x hotfix (3.47.4 as of 2026-09-16)
flutter upgrade
flutter devices
```

Исправление указано в [записи CHANGELOG для 3.47.1](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md) как "Fix ADB device list parsing for long wireless mDNS serials separated from state by a single space". В формулировке упоминаются беспроводные серийные номера, но, как видно из таблицы, исправление охватывает и длинные серийные номера USB. Если вы закрепляете версии через FVM или матрицу CI, поднимите закреплённую версию до `3.47.4` вместо запуска `flutter upgrade`. Каждая закреплённая ветка матрицы хранит собственный снимок инструмента, поэтому ветка с 3.47.0 продолжит падать сама по себе. То же самое относится к случаю, когда вы [нацеливаетесь на несколько версий Flutter из одного конвейера](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

Удалять `bin/cache/flutter_tools.snapshot` вручную не нужно. `flutter upgrade` пересобирает инструмент. Если же вы переключаетесь на тег через git, следующая команда `flutter` заметит новую ревизию и тоже пересоберёт снимок.

## Исправление 2: останьтесь на 3.47.0 и подключайте беспроводные устройства по IP

Если обновиться прямо сейчас нельзя, например потому что релизная ветка закреплена на 3.47.0, сделайте серийный номер коротким. `adb connect` с IP и портом создаёт транспорт с серийным номером вида `192.168.1.3:36809`. Это 17 символов, они дополняются до двух и более пробелов и разбираются в 3.47.0:

```bash
# Android 11+ wireless debugging, Flutter 3.47.0
# IP address & Port from Settings > Developer options > Wireless debugging
adb connect 192.168.1.3:36809
adb devices -l
flutter devices
```

Используйте порт подключения, показанный на экране Wireless debugging, а не одноразовый порт из диалога "Pair device with pairing code". В issue #191343 виден результат на реальном устройстве: строки mDNS по-прежнему выводят предупреждение, а устройство появляется в списке под серийным номером в виде IP.

Чтобы adb вообще не подключал транспорт mDNS автоматически и предупреждение тоже исчезло, задайте `ADB_MDNS_AUTO_CONNECT=0` до запуска сервера adb. В `adb_mdns.cpp` из исходников adb значение `0` очищает список разрешённых для автоподключения служб, в котором по умолчанию есть только `adb-tls-connect`. Переменную читает серверный процесс, поэтому перезапустите сервер:

```bash
# adb (platform-tools), macOS/Linux shell
adb kill-server
ADB_MDNS_AUTO_CONNECT=0 adb start-server
adb connect 192.168.1.3:36809
```

В Windows выполните `set ADB_MDNS_AUTO_CONNECT=0` в cmd или `$env:ADB_MDNS_AUTO_CONNECT = "0"` в PowerShell перед `adb start-server`. Android Studio запускает собственный сервер adb, если никакой не запущен, поэтому запустите свой первым.

Для USB-устройств с длинными серийными номерами аналогичного приёма нет, потому что аппаратный серийный номер укоротить нельзя. Для них исправлением служит обновление. Если обновиться действительно невозможно, подключайте такое устройство по беспроводной сети через IP, как описано выше.

## Проверьте свой вывод adb обоими парсерами

Если вы не уверены, затрагивает ли эта ошибка ваши строки, этот скрипт на Dart прогоняет регулярные выражения 3.47.0 и 3.47.1, скопированные из инструмента без изменений, по тому, что выводит `adb devices -l`:

```dart
// Dart 3.13 (Flutter 3.47). Run: adb devices -l | dart run check_adb_rows.dart
import 'dart:convert';
import 'dart:io';

const states =
    r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)';

final flutter3470 = RegExp(r'^(.*?)(?:\s{2,}|\t+)' + states + r'(?:\s+(.*)|$)');
final flutter3471 = RegExp(r'^(.*)\s+' + states + r'(?:\s+(.*)|$)');

Future<void> main() async {
  final lines = await stdin.transform(utf8.decoder).transform(const LineSplitter()).toList();
  for (final raw in lines) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('List of devices') || line.startsWith('* daemon ')) {
      continue;
    }
    final old = flutter3470.firstMatch(line);
    final fixed = flutter3471.firstMatch(line);
    print(line);
    print('  3.47.0:  ${old == null ? 'PARSE FAILURE' : 'serial="${old[1]}" state=${old[2]}'}');
    print('  3.47.1+: ${fixed == null ? 'PARSE FAILURE' : 'serial="${fixed[1]!.trimRight()}" state=${fixed[2]}'}');
  }
}
```

На моих девяти тестовых строках он во всех случаях совпал с настоящим инструментом. Для беспроводной строки он выводит:

```text
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:2
  3.47.0:  PARSE FAILURE
  3.47.1+: serial="adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" state=device
```

## Подводные камни и похожие ошибки

**Устройство в состоянии `detached` по-прежнему не разбирается в версиях с 3.47.1 по 3.47.4.** В свежих platform-tools есть `adb detach` и `adb attach`, которые освобождают USB-устройство, чтобы им мог воспользоваться другой процесс. В adb это состояние подключения называется `detached` (см. `to_string(ConnectionState)` в `adb.cpp`), а этого слова нет в списке состояний Flutter, поэтому даже исправленный парсер сообщает для него "Unexpected failure parsing device information". Flutter 3.44.8 показывал ту же строку как обычное устройство. Выполните `adb -s <serial> attach`, и строка вернётся в состояние `device`. В бете 3.48.0-0.5.pre тот же список состояний, так что эта проблема пока не исправлена.

**После обновления вместо ошибки может появиться "is not authorized".** В 3.47.0 устройство с длинным серийным номером, ожидающее подтверждения отладки по USB, тоже выглядит как ошибка разбора, что скрывает настоящую проблему. Как только 3.47.1+ разбирает строку, вы получаете "Device ... is not authorized. You might need to check your device for an authorization dialog." Разблокируйте телефон и примите запрос RSA-ключа.

**Суффикс `(2)` означает настоящий, другой серийный номер.** Если `adb devices -l` показывает и `adb-XXXX._adb-tls-connect._tcp`, и `adb-XXXX (2)._adb-tls-connect._tcp`, значит после конфликта имён mDNS у adb два транспорта к одному телефону. Flutter 3.47.1+ разбирает каждую строку отдельно, поэтому оба появляются как отдельные записи. Выберите любую через `-d` или ещё раз переключите беспроводную отладку на телефоне, чтобы вернуться к одной записи. В 3.44.x запись с суффиксом показывается под обрезанным серийным номером, который команды adb затем не находят; именно это и должен был исправить #187943.

**"No supported devices connected" при корректной строке adb это другая проблема.** Если строка разбирается, а устройство всё равно не появляется, проверяйте ABI и уровень API, а не парсер. Аналог этой проблемы для MAUI разобран в статье [doesn't support required ABI](/ru/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/). Если не находится сам `adb`, дело в поиске SDK, и [статья про cmdline-tools component is missing](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) подробно описывает порядок, в котором Flutter ищет SDK.

**`adb server version doesn't match this client` не является ошибкой разбора.** Flutter сообщает об этой строке отдельной диагностикой. Обычно это значит, что конфликтуют две установки platform-tools, чаще всего из Homebrew и из Android Studio. Поставьте одну из них первой в `PATH` и выполните `adb kill-server`.

## Связанные материалы

- [Исправление: flutter doctor --android-licenses fails with cmdline-tools 23](/ru/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) описывает ещё одну ошибку Android-инструментов, настоящим исправлением которой является хотфикс 3.47.x.
- [Что ещё вошло в хотфикс Flutter 3.47.1](/ru/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/), включая изменение проверки plugin registrant.
- Если вы подключаетесь к приложению, установленному через `adb install`, см. [как сохранить appFlavor после hot restart с flutter attach](/ru/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- [Could not create Dart VM instance после flutter upgrade](/ru/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) это случай, когда исправление состоит в переходе с конкретного сломанного релиза.
- Про отладку на реальном устройстве со стороны iOS см. [отладку Flutter на физическом iPhone из Windows](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/).

## Источники

- [flutter/flutter#189972](https://github.com/flutter/flutter/issues/189972) и [#189430](https://github.com/flutter/flutter/issues/189430), исходные issue, а также сообщения пользователей [#191167](https://github.com/flutter/flutter/issues/191167), [#191119](https://github.com/flutter/flutter/issues/191119) и [#191343](https://github.com/flutter/flutter/issues/191343).
- [flutter/flutter#189973](https://github.com/flutter/flutter/pull/189973), исправление, и [#191296](https://github.com/flutter/flutter/pull/191296), его cherry-pick в стабильную ветку.
- [flutter/flutter#189369](https://github.com/flutter/flutter/pull/189369) и [#187943](https://github.com/flutter/flutter/pull/187943), более ранние изменения парсера.
- [`android_device_discovery.dart` в 3.47.0](https://github.com/flutter/flutter/blob/3.47.0/packages/flutter_tools/lib/src/android/android_device_discovery.dart) и [в 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/android/android_device_discovery.dart).
- [CHANGELOG Flutter в 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md).
- Исходники adb: [`transport.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp) (`append_transport`), [`adb.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb.cpp) (имена состояний подключения) и [`adb_mdns.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_mdns.cpp) (`ADB_MDNS_AUTO_CONNECT`).
- [Документация Android Debug Bridge](https://developer.android.com/tools/adb), включая беспроводную отладку на Android 11+.
