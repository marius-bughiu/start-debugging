---
title: "Решение: Google Play отклоняет приложение на Flutter или .NET MAUI из-за отсутствия поддержки страниц памяти 16 КБ"
description: "Play отклоняет бандл, потому что у 64-битной .so сегменты ELF выровнены по 4 КБ. Найдите библиотеку, пересоберите с NDK r28+ и проверьте через zipalign -P 16."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "maui"
  - "dotnet"
  - "dotnet-10"
  - "android"
  - "gradle"
lang: "ru"
translationOf: "2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size"
translatedBy: "claude"
translationDate: 2026-08-14
---

Отклонение почти никогда не связано с вашим кодом. Google Play сканирует 64-битные нативные библиотеки в app bundle и блокирует публикацию, если у какой-либо из них сегменты `LOAD` в ELF выровнены по 4 КБ (`0x1000`), а не по 16 КБ (`0x4000`). И движок Flutter, и рантайм .NET для Android уже давно поставляют бинарники с выравниванием 16 КБ, поэтому виновником почти всегда оказывается сторонний плагин или библиотека-биндинг, собранная старым NDK. Найдите её, обновите или пересоберите, а затем подтвердите командой `zipalign -c -P 16 -v 4`.

## Ошибка в контексте

При загрузке бандла в Play Console появляется сообщение, блокирующее публикацию, примерно такого вида:

```
Your app's native libraries are not aligned to 16 KB.
Recompile your app with 16 KB native library alignment.

lib/arm64-v8a/libsomething.so
lib/arm64-v8a/libsomething_jni.so
```

Текущая формулировка в собственной документации Google не оставляет неясностей ни по охвату, ни по дате:

> все приложения, нацеленные на Android 15 (API уровня 35) и выше, должны поддерживать страницы памяти 16 КБ на 64-битных устройствах в Google Play. Начиная с 2027-02-01 вы не сможете публиковать обновления приложения, если они не поддерживают страницы памяти 16 КБ.

Историю стоит знать, потому что многие до сих пор циркулирующие советы ссылаются на устаревшие даты: требование изначально вступило в силу 2025-11-01 для новых приложений и обновлений, нацеленных на Android 15+, можно было запросить отсрочку до 2026-05-31, а окончательная блокировка несоответствующих обновлений теперь назначена на 2027-02-01 согласно [руководству Android по размерам страниц](https://developer.android.com/guide/practices/page-sizes).

## Почему библиотека с выравниванием 4 КБ ломается на устройстве с 16 КБ?

Android исторически исходил из страницы памяти размером 4 КБ. Устройства, выходящие с Android 15 и выше, могут использовать страницу 16 КБ, что снижает нагрузку на таблицу страниц и заметно ускоряет запуск приложения. Динамический компоновщик отображает каждый сегмент `PT_LOAD` разделяемой библиотеки по адресу, выровненному по странице. Если `p_align` сегмента равен 4096, а размер страницы ядра составляет 16384, загрузчик не может соблюсти границы сегмента, и `dlopen` завершается ошибкой. Пользователь видит сбой установки либо запуск, который сразу же падает в `System.loadLibrary`.

На самом деле требований к выравниванию два, и именно их смешение чаще всего вызывает путаницу:

- **Выравнивание сегментов ELF.** У каждого сегмента `PT_LOAD` внутри каждой `.so` значение `p_align` должно быть не меньше 16384. Это свойство того, как библиотека была скомпилирована и скомпонована.
- **Выравнивание записей zip.** Когда нативные библиотеки хранятся в APK без сжатия (`extractNativeLibs="false"`, значение по умолчанию в современных сборках), компоновщик отображает их напрямую из APK. Поэтому сами записи zip должны начинаться на границе 16 КБ. Это свойство того, как был собран пакет.

Библиотека может пройти одну проверку и не пройти другую. Play проверяет обе, и только для 64-битных ABI.

## Какие версии Flutter и .NET MAUI уже соответствуют требованию?

Обе цепочки инструментов в порядке уже некоторое время, поэтому проблемный файл обычно приходит из зависимости.

**Flutter.** В стабильном SDK Flutter 3.44.2 на диске (ревизия фреймворка `c9a6c48`, движок `77e2e94`) файл `packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt` фиксирует NDK, в который разрешается `flutter.ndkVersion`:

```kotlin
// Flutter 3.44.2 stable, FlutterExtension.kt
val ndkVersion: String = "28.2.13676358"
```

Это NDK r28, который по умолчанию выдаёт сегменты с выравниванием 16 КБ. Файл `DependencyVersionChecker.kt` того же SDK жёстко прерывает сборку ниже AGP 8.6.0 и предупреждает ниже AGP 8.11.1, а `gradle_utils.dart` создаёт новые проекты с AGP 9.0.1 и Gradle 9.1.0. Всё это с запасом превышает AGP 8.5.1, который Google называет минимумом для корректного выравнивания несжатых библиотек. Приложение на Flutter 3.44 соответствует требованию по построению, если только плагин не притащит устаревший `.so`.

**.NET MAUI.** SDK .NET для Android задаёт выравнивание пакета явно. Из `Microsoft.Android.Sdk.DefaultProperties.targets` в `Microsoft.Android.Sdk.Windows` 36.1.53, версии из workload .NET 10:

```xml
<!-- Microsoft.Android.Sdk 36.1.53 (.NET 10) -->
<AndroidZipAlignment Condition=" '$(AndroidZipAlignment)' == '' ">16</AndroidZipAlignment>
```

В соседнем комментарии сказано, что поддерживаются только значения `4` и `16`. Таким образом, zip-половина требования закрыта по умолчанию, и устанавливать это свойство вручную вам не понадобится. Если вам достался проект с зафиксированным `<AndroidZipAlignment>4</AndroidZipAlignment>`, удалите эту строку.

Для ELF-половины я прогнал проверку выравнивания по нативным библиотекам из пакетов рантайма .NET 10 для Android на этой машине (`Microsoft.Android.Runtime.*.36.1.53` и `Microsoft.NETCore.App.Runtime.Mono.android-arm64`). Все 64-битные библиотеки рантайма сообщают `p_align`, равный `0x4000`: `libmonosgen-2.0.so`, `libmono-android.release.so`, `libnet-android.release.so`, `libSystem.Native.so`, `libSystem.Security.Cryptography.Native.Android.so`, `libxamarin-native-tracing.so` и библиотеки компонентов Mono. И вариант Mono, и вариант CoreCLR чисты.

## Как проверить APK или AAB на выравнивание 16 КБ?

Скрипт Google `check_elf_alignment.sh` написан на bash, что неудобно при сборке под Windows. Проверка на уровне zip поставляется вместе с Android build tools и работает везде:

```powershell
# Windows, Android build-tools 35.0.0 or newer
& "$env:LOCALAPPDATA\Android\sdk\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 app-release.apk
```

Для app bundle настроенное выравнивание показывает `bundletool`:

```bash
bundletool dump config --bundle=app-release.aab
```

Однако ни то, ни другое не заглядывает в заголовки ELF. Для проверки самих сегментов в NDK есть `llvm-objdump`:

```bash
# ANDROID_NDK points at an r28 or newer installation
$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump -p libfoo.so | grep LOAD
```

Соответствующая требованию библиотека печатает `align 2**14`. Всё, что показывает `2**12` или `2**13`, проверку не проходит.

Если вы предпочитаете не зависеть от установленного NDK, заголовки программы разбираются напрямую без труда. Вот скрипт, которым я проверял пакеты рантайма .NET выше; он работает везде, где работает Python:

```python
# check_align.py - Python 3.9+, no dependencies
import glob, os, struct, sys

PT_LOAD = 1

def load_aligns(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF":
        return None
    is64 = data[4] == 2
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
        e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
    aligns = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_LOAD:
            continue
        fmt, delta = ("<Q", 0x30) if is64 else ("<I", 0x1C)
        aligns.append(struct.unpack_from(fmt, data, off + delta)[0])
    return is64, aligns

for pattern in sys.argv[1:]:
    for path in sorted(glob.glob(pattern, recursive=True)):
        result = load_aligns(path)
        if result is None:
            continue
        is64, aligns = result
        if not is64:
            continue  # Play only checks 64-bit ABIs
        worst = min(aligns) if aligns else 0
        status = "ALIGNED  " if worst >= 16384 else "UNALIGNED"
        print(f"{status} p_align={hex(worst)} {os.path.basename(path)}")
```

Распакуйте AAB или APK и укажите скрипту каталог 64-битной ABI:

```bash
unzip -q app-release.aab -d extracted
python check_align.py "extracted/**/lib/arm64-v8a/*.so"
```

Библиотеки, выведенные как `UNALIGNED`, ровно те, которые перечислит Play.

## Как починить невыровненное приложение на Flutter?

Начните с того, чтобы определить, какому плагину принадлежит файл. Поищите в кеше pub и в собранном APK, а затем сопоставьте `.so` с пакетом:

```bash
flutter build apk --release
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep "lib/arm64-v8a"
```

Когда виновник известен, действуйте в таком порядке:

1. **Обновите плагин.** Самое частое решение с большим отрывом. Большинство поддерживаемых пакетов пересобрали свои бинарники в течение 2025 года. Выполните `flutter pub outdated`, поднимите проблемную зависимость, пересоберите и проверьте снова.
2. **Обновите SDK Flutter и цепочку инструментов Android.** Убедитесь, что у вас Flutter 3.32 или новее, AGP 8.5.1 или новее в `settings.gradle.kts`, и что используется `android { ndkVersion = flutter.ndkVersion }`, а не жёстко прописанная старая строка NDK. Явный устаревший `ndkVersion = "25.1.8937393"` в `android/app/build.gradle.kts` молча сводит на нет всё остальное.
3. **Пересоберите нативный код сами**, если плагин собирается из исходников и застрял на NDK r27 или старше. Добавьте опции компоновщика в его `CMakeLists.txt`:

   ```cmake
   target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
       "-Wl,-z,max-page-size=16384"
       "-Wl,-z,common-page-size=16384")
   ```

4. **Откажитесь от зависимости**, если она заброшена. Неподдерживаемый пакет с предсобранной `.so` на 4 КБ и без исходников это непреодолимая блокировка, и никакой флаг сборки с вашей стороны её не исправит. Форкните или замените.

## Как починить невыровненное приложение на .NET MAUI?

Рантайм .NET 10 уже соответствует требованию, поэтому смотрите на пакеты NuGet, и особенно на библиотеки-биндинги Android, которые встраивают предсобранные `.aar` или `.so`. Рекламные SDK, аналитика, платёжные SDK и рантаймы машинного обучения это обычные подозреваемые.

```bash
# .NET 10, MAUI
dotnet publish -f net10.0-android -c Release
```

Затем распакуйте полученный `.aab` из `bin/Release/net10.0-android/publish/` и прогоните проверку по `base/lib/arm64-v8a/`. Если виновата библиотека-биндинг, решение состоит в обновлении пакета NuGet до версии, у которой исходный `.aar` пересобран с NDK r28. Если такой версии нет, остаётся переупаковать `.aar` самостоятельно с пересобранной нативной библиотекой либо отказаться от зависимости.

Заодно стоит подтвердить две вещи на уровне проекта. Убедитесь, что вы не отключили хранение нативных библиотек без сжатия, потому что весь механизм выравнивания zip держится на этом, и что вы не продолжаете нацеливаться на более старый SDK так, что локально проблема маскируется, а в Play нет. Ни то, ни другое не является частой ошибкой конфигурации, но обе дают запутанные результаты, когда присутствуют.

## Как быть с libc.so и 32-битными библиотеками, которые помечает проверка?

Два ложных срабатывания, которые уведут вас не туда, если проверять не тот каталог. Оба проявились сразу при сканировании пакетов рантайма .NET 10.

**Библиотеки-заглушки не поставляются.** Пакеты рантайма Android содержат `libc.so`, `libdl.so`, `liblog.so`, `libm.so` и `libz.so` со значением `p_align = 0x1000`. Это заглушки DSO для этапа компоновки, реальные реализации приходят с устройства. В ваш APK они не попадают, поэтому их выравнивание не имеет значения. Именно поэтому проверять нужно собранный пакет, а не папку `obj/` или кеш NuGet.

**32-битные библиотеки не подпадают под требование.** Все библиотеки в пакете рантайма `android-arm` (armeabi-v7a) сообщают `0x1000`, и это правильно и навсегда: у 32-битного процесса нет режима страниц 16 КБ, который нужно было бы поддерживать. Play проверяет только 64-битные ABI, и то же самое делает собственная проверка SDK .NET для Android на этапе сборки, диагностическая строка которой звучит как `Not a 64-bit ELF image.  Ignored.` Ограничьте сканирование каталогами `arm64-v8a` и `x86_64`, ровно как это делает скрипт выше.

Если вы хотите доказать исправление от начала до конца, а не полагаться на сканирование, создайте AVD из системного образа "Google APIs Experimental 16 KB Page Size" в SDK Manager, а затем перед установкой убедитесь, что эмулятор действительно работает со страницами 16 КБ:

```bash
adb shell getconf PAGE_SIZE
```

Команда должна вывести `16384`. Приложение, которое там установится и запустится, пройдёт проверку Play.

## Похожие материалы

Если сборка вообще не доходит до бандла, исходный сбой обычно находится в другом месте цепочки Gradle: [задача Gradle assembleDebug падает с кодом выхода 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) и [Gradle build failed to produce an .apk file в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) разбирают, как вытащить настоящую ошибку из обёрнутого лога. Отсутствующий NDK или компонент SDK проявляется как [flutter doctor сообщает об отсутствии компонента cmdline-tools](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), а нативные конфликты на уровне зависимостей часто всплывают сначала как [конфликт AndroidX при сборке Flutter под Android](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/). Команды, всё ещё сидящие на старом стеке, столкнутся со всем этим разом при [переходе с Xamarin.Forms на MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Источники

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) (Android Developers), про само требование, дату 2027-02-01, проверки через `zipalign` и `llvm-objdump`, а также флаги компоновщика для NDK r27 и старше.
- [Prepare your apps for Google Play's 16 KB page size compatibility requirement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) (Android Developers Blog), про первоначальное объявление от 2025-11-01.
- [Preparing your .NET MAUI apps for Google Play's 16 KB page size requirement](https://devblogs.microsoft.com/dotnet/maui-google-play-16-kb-page-size-support/) (.NET Blog), про рекомендации со стороны .NET и заявленные улучшения запуска и энергопотребления.
- Данные о версиях и выравнивании измерены локально на Flutter 3.44.2 stable и workload .NET 10 для Android (`Microsoft.Android.Sdk.Windows` и `Microsoft.Android.Runtime.*` 36.1.53).
