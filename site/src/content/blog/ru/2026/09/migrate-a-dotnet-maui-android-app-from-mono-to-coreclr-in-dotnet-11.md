---
title: "Перевод Android-приложения на .NET MAUI с Mono на CoreCLR в .NET 11"
description: "Пошаговый перевод .NET MAUI под Android с Mono на CoreCLR: нижняя граница API 24, свойства MSBuild из мира Mono, которые теперь ломают сборку, почему вырос APK, как профилировать регрессию запуска через dotnet-dsrouter и dotnet-trace, и как на самом деле выглядит откат теперь, когда путь Mono исчез."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "dotnet-11"
  - "maui"
  - "android"
  - "coreclr"
  - "mono"
lang: "ru"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-03
---

Для небольшого приложения эта миграция сводится к смене `TargetFramework`, смене `android:minSdkVersion` и одному дню измерений. Для крупного закладывайте неделю, и вся неделя уйдёт на две вещи: на удаление свойств MSBuild эпохи Mono, которые теперь либо ничего не делают, либо активно ломают сборку, и на поиск регрессии запуска, которая не имеет отношения к вашему коду. Выгода реальна (единая диагностика, многоуровневый JIT, динамический PGO, правдоподобный путь к Native AOT под Android), но честная формулировка такова: это не опция. Начиная с [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), Microsoft больше не предоставляет отдельный путь Mono для Android, iOS и Mac Catalyst. Это руководство ориентировано на .NET 11 Preview 7 (`11.0.100-preview.7`, выпущен 2026-08-11) с .NET MAUI `11.0.0-preview.7` и переход с .NET 10 на Mono. Финальный выпуск .NET 11 запланирован на 2026-11-10.

## Зачем это нужно, помимо "у вас нет выбора"

- **Профилировщик наконец работает.** `dotnet-trace` и `dotnet-counters` теперь подключаются к работающему Android-приложению так же, как к процессу ASP.NET Core, через `dotnet-dsrouter`. Отдельный диалект трассировки Mono больше не нужен.
- **Многоуровневая компиляция и динамический PGO приходят на телефон.** Mono AOT компилировал один раз во время сборки, и на этом история оптимизации заканчивалась. CoreCLR инструментирует код на Tier 0 и перекомпилирует горячие методы на Tier 1 по реальным данным профиля, поэтому пропускная способность долгоживущего приложения в установившемся режиме растёт без каких-либо ваших правок.
- **ReadyToRun заменяет Mono AOT как механизм запуска.** Под Android MAUI по умолчанию использует *составной частичный* R2R для сборок Release на CoreCLR, опираясь на профили `.mibc`, которые поставляются в составе workload. Предкомпилируются только те методы, которые профиль считает важными, и именно это удерживает накладные расходы по размеру от катастрофы.
- **Одна среда выполнения, один багтрекер.** Ошибка в `System.Text.Json` или `HttpClient` под Android теперь та же самая, что и на сервере, и исправляется в том же месте.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Минимальный API Android | Поднят с 21 (Android 5.0) до 24 (Android 7.0) | высокая |
| ABI Android | Android x86 (32 бита) не поддерживается на CoreCLR | высокая |
| Свойства Mono AOT | `RunAOTCompilation`, `AndroidAotMode`, `UseInterpreter` относятся только к Mono; `RunAOTCompilation=true` всё ещё может запустить `MonoAOTCompiler` и сломать сборку | высокая |
| Время запуска | Крупные приложения сообщают о регрессиях в несколько секунд и об ANR | высокая (ситуативно) |
| Размер APK | Образы R2R лежат внутри ваших файлов `.dll`, поэтому сборки растут | средняя |
| Пакеты NuGet | `NU1703`, когда пакет разрешается в ресурсы `MonoAndroid` вместо `net6.0-android` или новее | средняя |
| Устаревшие ресурсы | `XA0149` для устаревших ресурсов Xamarin.Android внутри зависимости | низкая |
| `Microsoft.Maui.Controls.Compatibility` | Пакет удалён в Preview 6 | средняя (только при явной ссылке) |
| Ошибки HTTP | Сбои транспорта `AndroidMessageHandler` выбрасывают `HttpRequestException` вместо `WebException` | низкая |
| Встраивание среды выполнения | API встраивания Android не переносятся на CoreCLR | высокая (если вы их используете) |

Нижняя граница уровня API -- это то изменение, которое дойдёт до ваших пользователей. Согласно [уведомлению о критическом изменении](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), приложения, собранные на .NET 11, невозможно установить и запустить на API 21, 22 и 23. Проверьте распределение по версиям в Play Console до начала работ, потому что это решение о пользователях, а не настройка сборки.

## Проверки перед стартом

- SDK .NET 11 `11.0.100-preview.7` или новее с установленным workload `maui-android`.
- Переменная `$ANDROID_HOME` указывает на корректный путь к Android SDK. `dotnet-dsrouter` берёт оттуда `adb` для настройки проброса портов и иначе надёжно его не найдёт.
- Средства диагностики установлены глобально: `dotnet tool install --global dotnet-dsrouter`, `dotnet-trace`, `dotnet-counters`.
- **Числовая базовая линия, снятая на .NET 10 с Mono, до любых изменений.** Именно этот шаг все пропускают, а потом жалеют, потому что "стало как-то медленнее" нельзя разложить по коммитам.
- Реальное устройство, а не только эмулятор. Все сообщённые регрессии -- это регрессии запуска, а замеры запуска на эмуляторе непоказательны.

## Шаги миграции

1. **Снимите базовую линию на Mono.** На текущей сборке Release для .NET 10 установите APK и измерьте холодный запуск через менеджер активностей Android, который выводит `TotalTime` в миллисекундах:

   ```console
   # .NET 10, Mono, Release
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Запустите пять раз, отбросьте первый прогон и запишите медиану. Запишите также размер APK или AAB в Release. **Проверка:** у вас есть два числа, записанные не в истории терминала.

2. **Меняйте target framework и границу API одновременно.** Оба изменения в одном коммите, потому что CoreCLR под Android требует API 24:

   ```xml
   <!-- .NET 11 Preview 7, MAUI 11.0.0-preview.7 -->
   <PropertyGroup>
     <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Если вы задаёте `android:minSdkVersion` вручную в `Platforms/Android/AndroidManifest.xml`, поднимите значение до `24`, чтобы манифест и проект совпадали. **Проверка:** `dotnet build -f net11.0-android -c Release` проходит, а в сгенерированном манифесте стоит `minSdkVersion="24"`.

3. **Удалите или обусловьте каждое свойство MSBuild, специфичное для Mono.** Пройдитесь grep по `.csproj`, `Directory.Build.props` и по всем свойствам, которые подставляет CI, в поисках `RunAOTCompilation`, `AndroidAotMode`, `AndroidEnableProfiledAot`, `UseInterpreter` и `UseMonoRuntime`. Оставленное в `Directory.Build.props` значение `RunAOTCompilation=true` -- известная поломка сборки: target `MonoAOTCompiler` продолжает выполняться, хотя приложение работает на CoreCLR ([dotnet/android#11068](https://github.com/dotnet/android/issues/11068)). Удалите их совсем или, если вы всё ещё собираете старый TFM параллельно, обусловьте:

   ```xml
   <PropertyGroup Condition="'$(UseMonoRuntime)' == 'true'">
     <RunAOTCompilation>true</RunAOTCompilation>
     <AndroidEnableProfiledAot>true</AndroidEnableProfiledAot>
   </PropertyGroup>
   ```

   **Проверка:** выполните `dotnet build -f net11.0-android -c Release -bl`, затем поищите `MonoAOTCompiler` в бинарном журнале. Ноль совпадений -- условие прохождения.

4. **Приведите в порядок список ABI и предупреждения пакетов.** Уберите `x86` из `RuntimeIdentifiers`, если он ещё там, поскольку CoreCLR эту архитектуру не поставляет:

   ```xml
   <RuntimeIdentifiers>android-arm64;android-x64</RuntimeIdentifiers>
   ```

   Затем разберитесь с `NU1703`. Предупреждение появилось в Preview 5 и срабатывает, когда пакет разрешается в ресурсы устаревшей папки `MonoAndroid`: "Package 'PackageName' 1.0.0 uses the deprecated MonoAndroid framework instead of 'net6.0-android' or later." Обновите пакет, если существует современная версия. Если её нет, вы нашли зависимость эпохи Xamarin, время которой уходит, и подавление предупреждения -- это решение нести этот риск, а не исправление. **Проверка:** `dotnet restore` проходит чисто, либо каждое оставшееся `NU1703` относится к пакету, который вы осознанно разобрали.

5. **Пересоберите в Release и заново измерьте относительно шага 1.** То же устройство, та же процедура, то же число прогонов:

   ```console
   # .NET 11 Preview 7, CoreCLR, Release
   dotnet publish -f net11.0-android -c Release
   adb install -r bin/Release/net11.0-android/publish/com.example.myapp-Signed.apk
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Позиция самой Microsoft: для базового шаблонного приложения Android укладывается "в пределах 10 процентов от Mono по запуску и размеру приложения". **Проверка:** если вы внутри этого коридора, работа над производительностью завершена. Если разница в 2 раза или хуже, переходите к шагу 6, а не начинайте наугад переключать свойства MSBuild.

6. **Профилируйте регрессию, а не гадайте.** Положите рядом с `.csproj` файл `app.env` с содержимым `DOTNET_DiagnosticPorts=127.0.0.1:9000,suspend` и подключите его по условию:

   ```xml
   <ItemGroup Condition="'$(AndroidEnableProfiler)'=='true'">
     <AndroidEnvironment Include="app.env" />
   </ItemGroup>
   ```

   Запустите маршрутизатор, соберите с включённым профилировщиком, запустите приложение и подключитесь:

   ```console
   dotnet-dsrouter server-server -ipcs ~/mylocalport -tcps 127.0.0.1:9000 --forward-port Android &
   dotnet build -f net11.0-android -c Release -t:Run /p:AndroidEnableProfiler=true
   dotnet-trace collect --diagnostic-port ~/mylocalport,connect
   ```

   Поскольку порт настроен с `suspend`, среда выполнения блокируется при запуске, пока не подключится `dotnet-trace`, а это именно то, что нужно, чтобы увидеть путь запуска, а не всё, что происходит после него. В Windows используйте `mylocalport` вместо `~/mylocalport`, поскольку канал IPC там -- именованный канал. **Проверка:** у вас есть файл `.nettrace` с заполненным окном запуска, и вы можете назвать три самых дорогих метода по включающему времени.

7. **Крутите только то, что оправдано трассировкой.** Если проблема в размере сборок, R2R -- первая ручка, потому что образы R2R упакованы внутрь файлов `.dll`, и именно поэтому ваши сборки выросли:

   ```xml
   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
     <PublishReadyToRun>false</PublishReadyToRun>  <!-- smaller APK, slower startup -->
     <TrimMode>full</TrimMode>                     <!-- default is partial -->
   </PropertyGroup>
   ```

   Эти два параметра тянут в разные стороны: отключение R2R меняет запуск на размер, а `TrimMode=full` возвращает размер, но начинает обрезать ваш собственный код и ваши ссылки на NuGet, поэтому требует полного регрессионного прогона. Меняйте по одному и повторяйте шаг 5 между изменениями. **Проверка:** каждая ручка оправдана измеренной разницей, которую вы можете назвать, а не постом в блоге.

8. **Выкатывайте поэтапно.** Сначала опубликуйте во внутренний трек и следите именно за долей ANR, а не только за долей падений. Сообщённый режим отказа CoreCLR на крупных приложениях -- запуск, который длится достаточно долго, чтобы Android убил процесс, и это проявляется как ANR, а не как исключение. **Проверка:** доля ANR в Play Console после недели внутреннего тестирования не отличается от вашей сборки на Mono.

## Контрольный список проверки

- `dotnet build -f net11.0-android -c Release` не вызывает `MonoAOTCompiler` в бинарном журнале.
- Медиана холодного запуска на реальном устройстве укладывается в принятый вами коридор относительно базовой линии .NET 10.
- Разница в размере APK/AAB зафиксирована и принята.
- Полный набор тестов проходит, включая тесты, затрагивающие рефлексию, пути ошибок `HttpClient` и сериализацию.
- Hot Reload работает. На CoreCLR это идёт через Edit and Continue, а не через интерпретатор Mono, то есть это действительно другой путь исполнения по сравнению с тем, что вы тестировали в прошлом релизе.
- В вашей активной базе установок нет устройств с API 21-23, либо вы уже сообщили о прекращении поддержки.

## План отката

Скажем это прямо: **отката на уровне среды выполнения больше нет.** `<UseMonoRuntime>true</UseMonoRuntime>` был задокументирован как аварийный выход, когда CoreCLR стал значением по умолчанию в Preview 4, и тогда его прямо описывали как временную разблокировку на время, пока вы заводите issue о регрессии. Preview 6 удалил отдельный путь Mono для Android, iOS и Mac Catalyst. Считайте это свойство исчезнувшим и не стройте на нём план релиза.

Ваш настоящий откат -- это target framework: держите сборку `net10.0-android` зелёной в отдельной ветке, пока сборка на .NET 11 не переживёт настоящую выкатку в продакшен. Это гораздо более тяжёлый откат, чем переключение одного свойства, и именно поэтому существуют шаги 1 и 5.

## Ловушки, которые стоят реального времени

**Регрессия запуска реальна и распределена неравномерно.** Два issue документируют режим отказа: [dotnet/android#10588](https://github.com/dotnet/android/issues/10588) сообщает, что "an app that takes 1s to launch on mono can take 6s on coreclr", с ANR в `ControlCatalog.Android` от Avalonia, а [dotnet/android#10914](https://github.com/dotnet/android/issues/10914) сообщает о примерно 1.0 с против 6.0 с холодного запуска и о росте APK с 21 МБ до 38 МБ на `11.0.100-preview.2`. Оба случая относятся к Avalonia, а не к MAUI, и оба предшествуют работам над составным частичным R2R и профилями MIBC, которые появились позже в цикле preview, поэтому не читайте их как ваш ожидаемый результат. Читайте их как причину, по которой шаг 1 обязателен.

**Больнее всего путям запуска, перегруженным XAML.** Общее место во всех сообщениях -- рефлексия и разбор XAML во время инициализации, то есть ровно та работа, которую частичный R2R не может предкомпилировать, если поставляемый профиль `.mibc` не покрывает форму вашего приложения. Если ваше приложение строит большое визуальное дерево до первого кадра, смотреть надо туда.

**`UseInterpreter` тихо перестаёт что-либо значить.** На Mono в Debug он был `true` по умолчанию, и именно он обеспечивал работу Hot Reload той эпохи. На CoreCLR он инертен. Если вы включали его по какой-то причине (динамический путь кода, который Mono AOT не вытягивал), эта причина никуда не делась, она просто сместилась: CoreCLR под Android в Debug выполняет настоящий JIT, так что код заработает, но перепроверьте это осознанно, а не по умолчанию.

**Содержимое вашего APK меняет форму.** На Mono вы поставляли `libmonosgen-2.0.so` плюс образы `libaot-*.dll.so`. На CoreCLR вы поставляете `libcoreclr.so`, `libclrjit.so`, `libmonodroid.so` (связующий код Android сохраняет имя из эпохи Mono) и единственный `libassemblies.arm64-v8a.so` со сжатым MSIL и образами R2R. Если у вас есть скрипты сборки, бюджеты размера или конфигурация ProGuard/R8, где эти файлы названы поимённо, их нужно обновить.

**Размер на самом деле в обрезке.** MAUI по-прежнему использует `TrimMode=partial` по умолчанию: обрезаются сборки фреймворка, а ваш код и ваши ссылки на NuGet остаются нетронутыми. Большинство жалоб на размер превращаются в жалобы на обрезку, как только вы посмотрите на разбивку по сборкам.

## Похожие материалы

- Сама смена среды выполнения была объявлена, когда [MAUI сделал CoreCLR значением по умолчанию на Android, iOS и Mac Catalyst в Preview 4](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), откуда и взялось свойство отказа.
- Аварийный выход закрылся два месяца спустя, когда [MAUI на мобильных стал работать только на CoreCLR в Preview 6](/ru/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/).
- Если вы всё ещё на старом стеке, предшествующая миграция -- это [Xamarin.Forms на MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/), а не эта.
- Компромисс между R2R и Mono AOT из шага 7 подробно разобран в [Native AOT против ReadyToRun против JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), а конечная цель, которую CoreCLR открывает на Android, описана в [во что на самом деле обходится Native AOT](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/).
- Если `TrimMode=full` из шага 7 ломает вашу сериализацию, отказ выглядит как [reflection-based serialization has been disabled for this application](/ru/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/).
- Изменение списка поставляемых ABI на шаге 4 может привести к [ошибке установки "doesn't support required ABI"](/ru/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) на устройствах, которые вы раньше обслуживали.

## Источники

- [.NET MAUI Moves to CoreCLR in .NET 11](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), блог .NET
- [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), блог .NET
- [Runtimes and compilation in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/deployment/runtimes-compilation), Microsoft Learn
- [Breaking change: Minimum Android API level raised to 24](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), Microsoft Learn
- [Breaking change: NU1703 warning for packages that use deprecated MonoAndroid framework assets](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/nu1703-deprecated-monoandroid-framework), Microsoft Learn
- [dotnet-dsrouter](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter), Microsoft Learn
- [dotnet/maui#33386, отслеживающий epic по CoreCLR на Android](https://github.com/dotnet/maui/issues/33386)
- [dotnet/android#10588, ANR while running large app](https://github.com/dotnet/android/issues/10588)
- [dotnet/android#11068, RunAOTCompilation runs MonoAOTCompiler under CoreCLR](https://github.com/dotnet/android/issues/11068)
