---
title: "Fix: Doesn't support required ABI при установке приложения .NET MAUI для Android"
description: "В APK нет нативной библиотеки под процессор устройства. Начиная с .NET 9 значения RuntimeIdentifiers для Android по умолчанию только 64-битные, поэтому решение состоит в том, чтобы задать RuntimeIdentifiers явно. Разбираются ADB0020, XA0036, NETSDK1083, соответствие ABI и RID, формулировка в Play Console и почему фрагмент с четырьмя RID, который все копируют, ломается на .NET 11."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "maui"
  - "dotnet"
  - "android"
  - "dotnet-11"
  - "coreclr"
lang: "ru"
translationOf: "2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-08-29
---

В пакете приложения нет нативной библиотеки под процессор устройства, на которое вы устанавливаете. Android отказывает в установке, вместо того чтобы запускать неподходящий бинарник. Начиная с .NET 9 проект `net9.0-android` и новее собирает только `arm64-v8a` и `x86_64`, тогда как тот же проект на .NET 8 собирал четыре ABI, поэтому обычная причина это обновление, а не что-то изменённое вами. Исправляется заданием `$(RuntimeIdentifiers)` для целевой платформы Android. Правильный набор RID зависит от вашей версии .NET, потому что .NET 11 полностью убрал Android x86, из-за чего фрагмент с четырьмя RID из большинства результатов поиска теперь ломает сборку.

## Ошибка в контексте

Одна и та же первопричина проявляется тремя разными формулировками в зависимости от того, кто выполняет установку.

При развёртывании из Visual Studio или через `dotnet build -t:Run` вы получаете ошибку сборки .NET for Android:

```
error ADB0020: The package does not support the CPU architecture of this device.
```

Если установить APK самостоятельно через `adb` из Android SDK, он сообщит об исходной ошибке:

```
adb: failed to install com.company.app-Signed.apk:
Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]
```

ADB0020 это в точности перевод этого сообщения средствами .NET for Android, плюс более старое `INSTALL_FAILED_CPU_ABI_INCOMPATIBLE`. А Google Play Console говорит то же самое в терминах каталога устройств, откуда и берётся формулировка про "required ABI":

```
Doesn't support required ABI: arm64-v8a, x86_64
```

На телефоне пользователя то же состояние выглядит как "Ваше устройство несовместимо с этой версией" в Play Store или как короткое "Приложение не установлено" при установке APK вручную.

## Какой ABI на самом деле нужен устройству?

Спросите его. Любое устройство Android и любой эмулятор публикуют поддерживаемые ABI в порядке приоритета:

```bash
adb shell getprop ro.product.cpu.abilist
```

Современный телефон отвечает `arm64-v8a,armeabi-v7a`. Устройство только с 64-битной архитектурой отвечает `arm64-v8a`. Образ эмулятора на Mac с Apple Silicon отвечает `arm64-v8a`, а образ x86_64 от Google отвечает `x86_64,arm64-v8a` только при наличии трансляции ARM, на которую не стоит рассчитывать.

Затем спросите пакет, что внутри него. Нативные библиотеки лежат в APK по пути `lib/<abi>/`:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.apk | grep 'lib/'
```

```text
lib/arm64-v8a/libmonodroid.so
lib/arm64-v8a/libSystem.Native.so
lib/x86_64/libmonodroid.so
lib/x86_64/libSystem.Native.so
```

Для app bundle префикс другой, `base/lib/`:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.aab | grep 'base/lib/'
```

Пересечение этих двух списков пусто. В этом и состоит вся ошибка. Показанный выше набор устанавливается на эмулятор Apple Silicon и на современный телефон и не устанавливается ни на одно устройство, у которого в `abilist` только `armeabi-v7a`.

## Что изменилось в .NET 9

.NET 8 и более ранние версии по умолчанию собирали все четыре Android ABI. .NET 9 сузил значение `$(RuntimeIdentifiers)` по умолчанию для Android до пары 64-битных:

```text
net8.0-android    armeabi-v7a  arm64-v8a  x86  x86_64
net9.0-android                 arm64-v8a       x86_64
net10.0-android                arm64-v8a       x86_64
net11.0-android                arm64-v8a       x86_64
```

Обоснование в том, что .NET следует за вендорами мобильных платформ, а Google требует 64-битную сборку для публикации в Play с 2019 года. Во время сборки вас ничто не предупреждает, потому что с точки зрения сборки всё в порядке. Вы узнаёте об этом, когда тестировщик со старым телефоном не может установить приложение, или когда каталог устройств в Play Console молча убирает несколько тысяч моделей из вашего списка поддерживаемых.

Если ваше приложение это личный проект или нацелено на современное железо, новое значение по умолчанию правильное и его стоит оставить. Два 64-битных ABI вместо четырёх уменьшают APK для MAUI примерно вдвое.

## Решение

Задайте `$(RuntimeIdentifiers)` явно, с условием на целевую платформу Android, чтобы значение не протекло в сборки для iOS или Windows:

```xml
<!-- .NET 9 and .NET 10 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x86;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

В проекте с одной целевой платформой можно использовать более простое условие по строке TFM:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Этот второй набор и стоит брать по умолчанию. Он возвращает 32-битный ARM, единственный 32-битный ABI, за которым стоит реальное железо, и пропускает 32-битный x86, что на практике означает старые образы эмуляторов и небольшое число планшетов на Intel Atom.

После изменения пересоберите проект. Нативные библиотеки для каждого ABI складываются в `obj/`, и инкрементальная сборка спокойно переиспользует раскладку, созданную до появления этого свойства.

## Имена ABI это не runtime identifiers

Это самая частая неудачная первая попытка. `$(AndroidSupportedAbis)` принимало имена ABI, поэтому люди вставляют имена ABI в свойство, которое пришло ему на смену:

```xml
<!-- wrong -->
<RuntimeIdentifiers>armeabi-v7a;arm64-v8a;x86;x86_64</RuntimeIdentifiers>
```

```text
error NETSDK1083: The specified RuntimeIdentifier 'armeabi-v7a' is not recognized.
```

Два словаря соответствуют друг другу один к одному:

| Android ABI | Runtime identifier в .NET |
| --- | --- |
| `armeabi-v7a` | `android-arm` |
| `arm64-v8a` | `android-arm64` |
| `x86` | `android-x86` |
| `x86_64` | `android-x64` |

Обратите внимание, что `x86_64` соответствует `android-x64`, а не `android-x86_64`, и что `android-x86` это 32-битный вариант. Если перепутать эти два, получится успешная сборка и APK, который не установится ни на одно из ваших устройств.

## Страница ADB0020 советует свойство, которое больше не работает

Следование официальной странице ADB0020 приводит ко второй ошибке. Она предлагает:

```xml
<AndroidSupportedAbis>armeabi-v7a;x86;x86_64;arm64-v8a</AndroidSupportedAbis>
```

Этот совет старше .NET 6. Добавьте его в современный проект, и сборка вам об этом скажет:

```text
warning XA0036: The 'AndroidSupportedAbis' MSBuild property is no longer supported. Edit the project
file in a text editor, remove any uses of 'AndroidSupportedAbis', and use the 'RuntimeIdentifiers'
MSBuild property instead.
```

Поскольку XA0036 это предупреждение, а не ошибка, сборка проходит, свойство игнорируется, а APK по-прежнему содержит два ABI. Если вам достался проект, мигрированный с Xamarin.Forms, поищите забытый `AndroidSupportedAbis` в `Directory.Build.props` или в аргументах сборочного сервера, прежде чем делать вывод, что `RuntimeIdentifiers` не действует.

## .NET 11 снова меняет ответ

Не вставляйте фрагмент с четырьмя RID в проект `net11.0-android`. [MAUI перешёл на CoreCLR для Android, iOS и Mac Catalyst в .NET 11 Preview 4](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), и CoreCLR перенёс не все архитектуры, которые поддерживал Mono. Android x86 больше нет, и запрос на него ломает сборку, а не отбрасывается молча:

```text
error NETSDK1082: There was no runtime pack for Microsoft.Android.Runtime available for the specified
RuntimeIdentifier 'android-x86'.
```

С 32-битным ARM пришлось ждать дольше. Когда CoreCLR стал значением по умолчанию, поддержка числилась как рассматриваемая, и появилась она в Preview 7. Поскольку [Preview 6 полностью убрал путь через Mono для мобильных платформ](/ru/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/), запасного выхода через `$(UseMonoRuntime)` больше нет. Для проекта на .NET 11 рабочий набор такой:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Если у вас SDK уровня Preview 6 или раньше, уберите и `android-arm` и смиритесь с 64-битной сборкой, пока не сможете обновиться. .NET 11 выходит в GA в ноябре 2026 года.

Практическое следствие для эмуляторов: 32-битный системный образ x86 никогда не запустит приложение MAUI на .NET 11. Если ваш CI всё ещё поднимает такой, переведите его на `x86_64` или на `arm64-v8a` на раннерах с Apple Silicon.

## Держите цикл разработки быстрым

Собирать четыре ABI ради отладки на одном устройстве это потеря времени. `$(RuntimeIdentifier)` в единственном числе перекрывает форму множественного числа и собирает ровно один:

```bash
dotnet build -f net11.0-android -t:Run -p:RuntimeIdentifier=android-arm64
```

Привяжите это к конфигурации Debug, а полный набор оставьте для Release:

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Debug' and $(TargetFramework.Contains('-android'))">
  <RuntimeIdentifier>android-arm64</RuntimeIdentifier>
</PropertyGroup>
```

Одно предупреждение о передаче свойства во множественном числе через командную строку: MSBuild разбивает значения `-p:` по точкам с запятой, поэтому `-p:RuntimeIdentifiers=android-arm64;android-x64` даст вам ошибку разбора в оболочке или в MSBuild вместо двух RID. Экранируйте разделитель как `%3B`:

```bash
dotnet publish -f net11.0-android -c Release -p:RuntimeIdentifiers=android-arm64%3Bandroid-x64
```

## Чего на самом деле требует Google Play

Play требует 64-битный бинарник рядом с любым 32-битным с августа 2019 года. Самого 32-битного он не требовал никогда. Значит, значение по умолчанию из .NET 9 соответствует правилам, а возвращение `android-arm` это решение об охвате, а не исправление ради соответствия требованиям.

Проверьте реальную цифру, прежде чем тратить на это размер APK. В Play Console каталог устройств для релиза показывает, скольких поддерживаемых устройств достигает бандл, и разница между сборкой с двумя и с тремя ABI это доля телефонов, поддерживающих только `armeabi-v7a` и всё ещё используемых на ваших рынках. Для многих приложений в 2026 году эта цифра достаточно мала, чтобы ею пренебречь, а для приложений, распространяемых в регионах с длинным циклом замены устройств, нет.

Если вы публикуете app bundle, Play всё равно разделит его по ABI, так что каждый пользователь скачает одну архитектуру. Дополнительный ABI стоит вам времени сборки и размера загрузки, а не размера установки.

## Похожие материалы

- Нативные библиотеки это также причина, по которой [Google Play отклоняет приложение на Flutter или .NET MAUI из-за отсутствия поддержки страниц памяти по 16 КБ](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), и эта проверка работает по тем же записям `lib/<abi>/`, которые вы вывели выше.
- Смена рантайма, стоящая за изменениями архитектур в .NET 11, разобрана в [MAUI по умолчанию переходит на CoreCLR для Android, iOS и Mac Catalyst](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- Забытый `AndroidSupportedAbis` обычно приходит вместе с остальными устаревшими свойствами сборки, которые разобраны в [миграции с Xamarin.Forms на MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- Если сборка падает ещё до того, как появится устанавливаемый пакет, начните с [Gradle build failed to produce an APK file in MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).

## Источники

- [Ошибка ADB0020 в .NET for Android](https://learn.microsoft.com/ru-ru/dotnet/android/messages/adb0020), про соответствие `INSTALL_FAILED_NO_MATCHING_ABIS` ошибке сборки.
- [Предупреждение XA0036 в .NET for Android](https://learn.microsoft.com/ru-ru/dotnet/android/messages/xa0036), про текст об устаревании `AndroidSupportedAbis`.
- [Миграция проектов Xamarin.Android](https://learn.microsoft.com/ru-ru/dotnet/maui/migration/android-projects), где задокументирована замена ABI на `RuntimeIdentifiers`.
- [Каталог RID в .NET](https://learn.microsoft.com/ru-ru/dotnet/core/rid-catalog) для имён runtime identifiers для Android.
- [CoreCLR progress and the Mono timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), про удаление пути через Mono в Preview 6 и статус arm32.
- [dotnet/maui#27697](https://github.com/dotnet/maui/issues/27697), сообщение, которое выявило изменение значений по умолчанию в .NET 9 как регрессию совместимости в Play Store.
- [Поддержка 64-разрядных архитектур](https://developer.android.com/google-play/64-bit) в документации для разработчиков Google Play.
