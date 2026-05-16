---
title: "Fix: Unable to find a valid iOS Simulator runtime при сборке MAUI"
description: "В Xcode 15+ среды выполнения симулятора iOS не входят в комплект. MAUI ломает сборку, когда для SupportedOSPlatformVersion нет подходящей установленной среды. Установите её через xcodebuild -downloadPlatform iOS или через Settings Xcode, и проверьте через xcrun simctl list runtimes."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "simulator"
lang: "ru"
translationOf: "2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build"
translatedBy: "claude"
translationDate: 2026-05-16
---

Решение: начиная с Xcode 15 среда выполнения симулятора iOS больше не входит в комплект самого Xcode, а начиная с Xcode 26 среда выполнения предыдущего Xcode тоже не переносится автоматически. Цепочка инструментов MAUI iOS читает `SupportedOSPlatformVersion` из вашего csproj, запрашивает у Xcode симулятор этой версии или выше и завершается с `Unable to find a valid iOS Simulator runtime`, когда ничего не подходит. Запустите `xcrun simctl list runtimes`, чтобы подтвердить, что установлено фактически, а затем либо скачайте среду в Xcode через Settings, Platforms, кнопку плюс, либо сделайте это без интерфейса через `xcodebuild -downloadPlatform iOS`. Если `SupportedOSPlatformVersion` в вашем csproj выше всех установленных сред, опустите её до версии, которая у вас есть, или установите подходящую среду.

```text
/usr/local/share/dotnet/packs/Microsoft.iOS.Sdk/18.2.9270/targets/Xamarin.Shared.Sdk.targets(1245,3):
error : Unable to find a valid iOS Simulator runtime. Please install one from Xcode > Settings > Platforms.

xcodebuild: error: Unable to find a destination matching the provided destination specifier:
        { platform:iOS Simulator, OS:18.2, name:iPhone 16 Pro }

Could not find the simulator runtime 'com.apple.CoreSimulator.SimRuntime.iOS-18-2'.
```

Это руководство написано для .NET 11 preview 4, MAUI 11 preview 4, Xcode 26.0 и `Microsoft.iOS.Sdk` 18.2.9270. Поведение появилось в момент, когда Apple вынесла среды выполнения симулятора из установщика Xcode в Xcode 15, и стало гораздо заметнее в Xcode 26, потому что Apple перестала тихо импортировать кеш сред предыдущего Xcode при первом запуске. Если вы недавно обновились и ваш конвейер сборки начал падать без видимой причины, причина почти наверняка в этом.

## Почему Xcode 15 сломал сборки MAUI iOS

Большую часть истории Xcode установщик нёс среду выполнения симулятора iOS в том же `.xip`, который вы скачивали с портала разработчика, и отчасти поэтому Xcode весил 7+ ГБ. С Xcode 15 Apple вынесла среды в отдельную модель загрузки: приложение Xcode поставляется с цепочкой инструментов (компиляторы, SDK, заголовочные файлы) и самим приложением симулятора iOS, но каждый конкретный образ среды (`iOS 17.4`, `iOS 18.2` и так далее) — это отдельная загрузка, которую вы выбираете. Установщик усыхает примерно до 3 ГБ, и вы тянете только нужные платформы.

Это отлично для использования диска и ужасно для первых сборок. Проект MAUI, нацеленный на `net11.0-ios`, разрешает целевой SDK через `Microsoft.iOS.Sdk`, передаёт `xcodebuild` строку назначения с версией среды, и затем `xcrun simctl create` или `xcrun simctl boot` пытается найти подходящую среду в `~/Library/Developer/CoreSimulator/Profiles/Runtimes` и `/Library/Developer/CoreSimulator/Profiles/Runtimes`. Когда не установлено ничего, ни один из этих вызовов не срабатывает, и вы получаете ошибку выше.

В Xcode 26 добавилась ещё одна тонкость. Теперь Apple обрабатывает среды как полностью независимые от бандла Xcode, а новый фреймворк `CoreSimulator` хранит матрицу совместимости для каждого Xcode. Если у вас был Xcode 16 с установленной средой симулятора iOS 18.2, а потом вы обновились до Xcode 26 и ваш csproj нацелен на `iOS 19.0`, среда 18.2 всё ещё на диске, но это не то, что просит MAUI. Формулировка ошибки не меняется, отсюда путаница при обновлении.

## Что именно просит MAUI

Когда вы запускаете `dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-19-0,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"`, цели MAUI iOS в `Microsoft.iOS.Sdk` делают несколько вещей:

1. Разрешают `SupportedOSPlatformVersion` и `_MtouchTargetiOSVersion` из вашего проекта.
2. Вызывают `xcrun simctl list runtimes -j`, чтобы узнать, что установлено локально.
3. Выбирают первую среду, чья версия больше или равна вашей цели и которая соответствует платформе (`iOS-Simulator`).
4. Если ничего не подходит, задача MSBuild бросает ошибку `Unable to find a valid iOS Simulator runtime` ещё до вызова `xcrun simctl boot`.

Это реализовано в задаче `_DetectSimulator` в `Xamarin.Shared.Sdk.targets`. Вывод: ошибка означает, что ваш список установленных сред для платформы пуст или что у каждой установленной среды версия ниже цели csproj.

## Проверьте, что действительно установлено

Прежде чем менять что-то в csproj, выведите список сред:

```bash
# macOS, any shell
xcrun simctl list runtimes --json | jq '.runtimes[] | {name, version, identifier, isAvailable}'
```

Здоровая машина печатает что-то вроде:

```json
{
  "name": "iOS 19.0",
  "version": "19.0",
  "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  "isAvailable": true
}
```

Сломанная машина после обновления Xcode печатает либо пустой массив `runtimes`, либо среды с пометкой `"isAvailable": false` и строкой `availabilityError`, поясняющей, что среда «несовместима с этой версией Xcode». Среда, помеченная как недоступная, лежит на диске, но Xcode отказывается её использовать, поэтому MAUI считает её отсутствующей.

Ту же информацию можно увидеть и в самом Xcode в **Settings, Platforms**. Список показывает установленные среды с галочкой и позволяет установить или удалить каждую.

## Установка среды из командной строки

Если вы работаете без интерфейса или в CI, не кликайте по UI Xcode. В Xcode 15 появился флаг `-downloadPlatform` для `xcodebuild`:

```bash
# Xcode 15+, downloads the latest iOS simulator runtime
# compatible with this Xcode version
xcodebuild -downloadPlatform iOS

# Xcode 16+, pin to a specific build of the runtime
xcodebuild -downloadPlatform iOS -buildVersion 18.2
```

Команда работает в активном режиме, печатает процент прогресса и пишет среду в `~/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime`. Это примерно 8 ГБ на среду, так что в CI планируйте соответственно. Apple документирует это в [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

Для более старых версий Xcode (только Xcode 15) старая форма — `xcodebuild -downloadAllPlatforms`, которая скачивает среду каждой совместимой платформы. Она гораздо тяжелее, чем `-downloadPlatform iOS`, и в CI почти никогда не нужна.

Если нужна среда, не входящая в набор совместимости текущего Xcode, например iOS 17.4 для воспроизведения клиентского бага в Xcode 26, установите её из скачанного `.dmg` или `.simruntime`:

```bash
# Manually install a simruntime image from disk
xcrun simctl runtime add "/path/to/iOS 17.4.simruntime"
```

Подкоманда `xcrun simctl runtime` существует начиная с Xcode 16+ и является поддерживаемым способом зарегистрировать среду, скачанную отдельно. Зарегистрированные образы сред можно вывести через `xcrun simctl runtime list`.

## Согласуйте SupportedOSPlatformVersion с тем, что у вас есть

Если вы установили `iOS 18.2`, а ваш csproj нацелен на `iOS 19.0`, ошибка повторится. Откройте iOS-специфичный раздел csproj и либо опустите цель, либо смиритесь с тем, что нужна более новая среда:

```xml
<!-- .NET 11, MAUI 11, Microsoft.iOS.Sdk 18.2.9270 -->
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

`SupportedOSPlatformVersion` — это **минимальная** версия iOS, которую ваше приложение поддерживает во время выполнения. Среда симулятора, которую вы загружаете, должна быть больше или равна этому числу. По умолчанию MAUI запускает симулятор с самой высокой версией среди установленных сред, а не минимальную, поэтому если установлен iOS 19.0, ваше приложение всё равно запустится на iOS 19.0, хотя нижняя граница проекта — 15.0.

Не поднимайте `SupportedOSPlatformVersion`, чтобы заглушить ошибку, это не та ручка. Правильный ход — установить среду, а минимум проекта оставить там, где он реально должен быть для вашей аудитории.

## Закрепите конкретный симулятор из dotnet build

Когда установлено несколько сред и нужна конкретная, передайте `_DeviceName` в цель Run iOS MAUI. Это та же строка, которую внутри использует `xcrun simctl`:

```bash
# .NET 11 preview 4, MAUI 11 preview 4
dotnet build -t:Run -f net11.0-ios \
  -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-18-2,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
```

Префикс `:v2:` обязателен, MAUI парсит его как селектор устройства нового формата. Идентификатор среды совпадает с тем, что `xcrun simctl list runtimes` печатает под `identifier`. Идентификатор типа устройства совпадает с тем, что выводит `xcrun simctl list devicetypes`.

Если опустить `_DeviceName`, MAUI выбирает самый последний установленный симулятор iPhone на самой высокой установленной среде, что нормально для локальной разработки и удивительно хрупко в CI, когда выходит новая точечная версия Xcode.

## Решение конкретно для CI

На свежем раннере `macos-15` или `macos-26` GitHub Actions Xcode предустановлен, но среды симулятора iOS, совпадающей с вашим `SupportedOSPlatformVersion`, может не быть. В хостируемых образах Apple зашиты одна-две среды; у агентов сборки других провайдеров всё иначе. Безопасный шаблон — устанавливать явно до запуска `dotnet build`:

```yaml
# .github/workflows/maui-ios.yml
- name: Select Xcode
  run: sudo xcode-select -s /Applications/Xcode_26.0.app

- name: Install iOS 18.2 simulator runtime
  run: xcodebuild -downloadPlatform iOS -buildVersion 18.2

- name: Verify runtime is registered
  run: xcrun simctl list runtimes

- name: Build MAUI iOS
  run: dotnet build src/App/App.csproj -c Release -f net11.0-ios
```

Две вещи кусают людей здесь. Во-первых, раннер кеширует между джобами только если вы явно подключите кеш, иначе каждый джоб заново скачивает 8 ГБ, если не подключить [`actions/cache`](https://github.com/actions/cache) с ключом по версии среды. Во-вторых, `xcodebuild -downloadPlatform` не падает, если среда уже установлена, но всё равно перечитывает метаданные. С тёплым кешем команда завершается за секунды.

Если ваш CI работает на более старом Xcode (Xcode 14 или старше), `-downloadPlatform` не существует. Либо обновите Xcode, либо используйте сторонний инструмент вроде `xcodes` (`brew install xcodes`) и `sudo xcodes runtimes install "iOS 18.2"`. Поддерживаемый сообществом `xcodes` был единственным хорошим ответом до Xcode 15 и всё ещё полезен, когда нужны старые среды, которые Apple больше не хостит на портале разработчика.

## Сервис CoreSimulator застрял после обновления

Иногда среда установлена, `xcrun simctl list runtimes` показывает её как доступную, а MAUI всё равно падает. Причина обычно — несвежий `CoreSimulatorService`, который закешировал список сред Xcode до обновления. Убейте его:

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

Сервис перезапустится при следующем вызове `xcrun simctl` и перечитает каталог сред. Это документировано в нескольких issue `dotnet/macios`, включая [dotnet/macios#22243](https://github.com/dotnet/macios/issues/22243), и чаще всего вылезает после `softwareupdate -ai`, который обновляет CoreSimulator без перезагрузки.

Если убийство сервиса не помогает, очистите ещё `~/Library/Developer/CoreSimulator/Caches` и перезагрузитесь. У `CoreSimulator` есть кеш производных данных, который иногда указывает на удалённый путь к среде.

## Когда выбран неправильный Xcode

Другой распространённый ложный сигнал: `xcode-select -p` указывает на другой Xcode, чем тот, в который вы установили среду. Среды технически зарегистрированы относительно активного Xcode через `CoreSimulator`, и переключение между Xcode может оставить новый активный Xcode без видимых сред, хотя файлы существуют:

```bash
# Show the active Xcode
xcode-select -p
# /Applications/Xcode_26.0.app/Contents/Developer

# Switch to a specific Xcode
sudo xcode-select -s /Applications/Xcode_26.0.app
```

MAUI также учитывает `DEVELOPER_DIR`. Если её экспортирует шаг CI, она перебивает `xcode-select`. Расхождение между `xcode-select` и `DEVELOPER_DIR` — один из тех багов, что вылезает только при втором запуске конвейера, когда закешированная переменная окружения конфликтует с дефолтом свежего раннера. [Руководство по диагностике MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0) описывает приоритет выбора Xcode: `DEVELOPER_DIR`, затем устаревшие plist-файлы, затем `xcode-select -p`, затем `/Applications/Xcode.app`.

## Подводные камни после исправления

Несколько вещей всё ещё ловят людей после установки среды:

1. **Слайсы симулятора Apple Silicon vs Intel**. Среды симулятора для iOS 17.0+ поставляются только со слайсом arm64. Если вы работаете на Intel-Mac под Rosetta, загрузить их не получится. Используйте более старую среду или обновите агент сборки.
2. **Путаница с Mac Catalyst**. `net11.0-maccatalyst` не требует среды симулятора, он работает нативно на macOS. Если сборка Mac Catalyst падает с этой ошибкой, почти наверняка в том же проекте есть лишний таргет `net11.0-ios`, и его подцепила IDE.
3. **Несовпадения `-buildVersion`**. `xcodebuild -downloadPlatform iOS -buildVersion 18.2` принимает маркетинговые версии вроде `18.2`, а не внутренние номера сборок вроде `22C150`. Передача номера сборки тихо скачивает последнюю версию.
4. **Аплоады в App Store Connect продолжают работать без симулятора**. Сборки для устройства (`-p:RuntimeIdentifier=ios-arm64`) среды симулятора вообще не требуют. Если ваш CI заливает только в TestFlight, установку можно полностью пропустить и настроить только подпись.

Если в том же проекте вы воюете с ошибками сборки на стороне Android, тот же паттерн (цепочка инструментов ждёт компонент, который установщик больше не кладёт) встречается и там: см. разбор [падения Gradle на этапе сборки APK в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/). Для похожих по виду ошибок iOS, не связанных с симуляторами, путь описан в [исправлении расхождения устройства профиля подготовки](/ru/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/). Если хочется вообще уйти от кроссплатформенной мобилки в этом проекте, пост о [MAUI только под Windows и macOS](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) разбирает целевые фреймворки только для десктопа. Для контекста волны релиза MAUI 11 пост о [дефолте CoreCLR в MAUI в .NET 11 preview 4](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) объясняет, что изменилось под капотом.

Самое короткое решение почти всегда — `xcodebuild -downloadPlatform iOS`, а затем `dotnet build`. Более длинное решение — записать эту одну строчку в скрипт CI, чтобы следующий агент, который присоединится к команде, не потерял на этом целый день.

## Источники

- [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Troubleshoot known issues - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [dotnet/macios#22243 - Can't find simulator when a particular iOS SDK version doesn't contain a simulator](https://github.com/dotnet/macios/issues/22243)
- [dotnet/maui#23352 - iOS build failed with iossimulator-x64 RuntimeIdentifier](https://github.com/dotnet/maui/issues/23352)
- [Build with a specific version of Xcode](https://learn.microsoft.com/en-us/dotnet/ios/cli)
