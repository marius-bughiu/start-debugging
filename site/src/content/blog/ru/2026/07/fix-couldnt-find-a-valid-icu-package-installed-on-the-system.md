---
title: "Решение: Couldn't find a valid ICU package installed on the system в контейнере .NET"
description: "В базовом образе нет ICU. Установите icu-libs и icu-data-full, перейдите на вариант образа -extra или включите InvariantGlobalization=true и примите порядковое поведение строк."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "globalization"
  - "alpine"
lang: "ru"
translationOf: "2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system"
translatedBy: "claude"
translationDate: 2026-07-29
---

Базовый образ вашего контейнера не содержит ICU, и .NET отказывается запускаться без него. Выберите один из двух ответов. Если приложение форматирует даты, сравнивает строки лингвистически или обращается к любой культуре, кроме инвариантной, установите ICU: `RUN apk add --no-cache icu-libs icu-data-full` в Alpine либо перейдите на вариант образа `-extra`, где ICU уже есть. Если приложению действительно никогда не нужны данные культур, укажите `<InvariantGlobalization>true</InvariantGlobalization>` в файле проекта и оставьте маленький образ. Не полагайтесь на одну лишь переменную окружения: это самый слабый из трёх переключателей.

```text
Process terminated. Couldn't find a valid ICU package installed on the system.
Please install libicu (or icu-libs) using your package manager and try again.
Alternatively you can set the configuration flag System.Globalization.Invariant
to true if you want to run with no globalization support. Please see
https://aka.ms/dotnet-missing-libicu for more information.
```

Всё, что описано ниже, проверено на .NET 10 (`10.0`, выпуск 2025-11-11) и предварительных версиях .NET 11. Механизм не менялся с .NET 5, поэтому те же решения без изменений подходят для образов `net8.0` и `net9.0`. Меняются только имена пакетов и теги образов.

## Почему среда выполнения убивает процесс, а не деградирует

Стек глобализации .NET в Unix представляет собой тонкую прослойку над ICU (International Components for Unicode). Данные культур, лингвистическое сравнение строк, правила регистра за пределами ASCII, форматирование календарей, обработка IDN: всё это приходит из `libicuuc` и `libicui18n`, которые не входят в состав .NET. Это нативная зависимость, которую должен предоставить базовый образ.

При запуске статический конструктор `GlobalizationMode` проходит по фиксированному списку решений:

1. Включён ли режим инвариантной глобализации? Если да, ICU полностью пропускается и используются встроенные инвариантные данные.
2. Настроен ли ICU, локальный для приложения? Если да, загружаются `libicuuc.so.<version>` и `libicui18n.so.<version>` из каталога приложения.
3. Задана ли `DOTNET_ICU_VERSION_OVERRIDE`? Если да, делается попытка загрузить именно эту версию.
4. Иначе загружается самая старшая версия ICU, установленная в системе.

Если шаг 4 ничего не находит, среда выполнения вызывает `Environment.FailFast`. Именно эта деталь сбивает людей с толку: это не исключение. Никакой `try`/`catch` вас не спасёт, никакой обработчик `AppDomain.UnhandledException`, никакого аккуратного отката в инвариантный режим. Процесс завершается ещё до того, как `Main` реально начнёт работу, что в Linux проявляется как SIGABRT и код выхода контейнера 134. Это сделано намеренно: молчаливый откат к порядковому сравнению строк изменил бы сортировку, регистр и разбор дат так, что вместо громкой ошибки вы получили бы неверные данные.

Чаще всего с этим сталкиваются как раз те образы, которые вы выбрали именно за компактность. Alpine, Azure Linux distroless и Ubuntu chiseled не содержат ICU и tzdata, и документация по контейнерам .NET прямо говорит, что эти образы работают только с приложениями, настроенными на режим инвариантной глобализации. Полные образы Debian и Ubuntu уже содержат ICU, поэтому приложение работало на вашей машине и в образе `sdk` и умерло в момент попадания в стадию runtime.

## Минимальное воспроизведение

Две стадии, обычная сборка через SDK, Alpine в качестве среды выполнения. Достаточно такого Dockerfile:

```dockerfile
# .NET 10. Fails at startup with the ICU error.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

Само приложение не обязано делать ничего экзотического. Сбой происходит во время инициализации среды выполнения, до запуска вашего кода, поэтому падает даже такое:

```csharp
// .NET 10, C# 14. Never reaches the WriteLine.
Console.WriteLine("hello");
```

Это стоит усвоить, потому что первый инстинкт таков: искать вызов `CultureInfo`, который всё сломал. Его нет. Инициализация глобализации выполняется заранее.

## Решение 1: установить ICU в образ

Это правильное решение для большинства приложений и именно то, что описано в примерах контейнеров .NET. В Alpine:

```dockerfile
# .NET 10 on Alpine 3.22. Adds ICU and disables invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
RUN apk add --no-cache icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`icu-data-full` не является опциональным балластом. Начиная с Alpine 3.16 пакет данных ICU разделили, и `icu-libs` сам по себе содержит только локаль `en`, что порождает куда более запутанный сбой, чем исходный: среда выполнения стартует нормально, а затем все культуры, кроме английской, молча форматируются как английская. Тесты, проверяющие форматы дат `fr-FR`, начинают падать вообще без сообщения об ошибке. Ставьте оба пакета.

Строка `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` важна только в том случае, если что-то выше по цепочке установило значение `true`, а так поступают несколько базовых образов и шаблонов CI. Задать её явно ничего не стоит, зато убирает целый класс ошибок с унаследованным окружением.

Эквивалент для образов на базе Debian или Ubuntu, который понадобится только для собранного вами образа `runtime-deps`:

```dockerfile
# .NET 10 on Ubuntu 24.04 (noble).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu74 tzdata \
    && rm -rf /var/lib/apt/lists/*
```

Закрепите имя пакета `libicu` за тем, которое реально есть в вашем выпуске дистрибутива (`libicu74` в Ubuntu 24.04, `libicu72` в Debian bookworm). Если следить за этим не хочется, `apt-get install -y libicu-dev` транзитивно подтянет нужную библиотеку ценой более крупного слоя.

## Решение 2: перейти на вариант образа `-extra`

Microsoft публикует оптимизированные по размеру образы в трёх вариантах, и суффикс `-extra` означает ровно "маленький образ плюс ICU, tzdata и `libstdc++`". Если вы на chiseled или Azure Linux, это одна строка вместо установки пакетов:

```dockerfile
# .NET 10, Ubuntu chiseled with globalization support.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

Есть асимметрия доступности, о которой стоит знать заранее. Для Ubuntu chiseled и Azure Linux `-extra` существует в репозиториях `runtime-deps`, `runtime` и `aspnet`. Для Alpine `-extra` публикуется только в `runtime-deps`, а значит, использовать его можно лишь с самодостаточной (self-contained) публикацией или Native AOT. Приложению на Alpine, зависящему от фреймворка, придётся ставить пакеты вручную, как в решении 1.

Если вы собираете образы встроенными средствами SDK, а не Dockerfile, выбирайте вариант через `ContainerFamily`, а не через строку `FROM`:

```xml
<!-- .NET 10 SDK. Applies to dotnet publish /t:PublishContainer. -->
<PropertyGroup>
  <ContainerFamily>noble-chiseled-extra</ContainerFamily>
</PropertyGroup>
```

Это встраивается в тот же процесс, который описан в статье про [публикацию приложения .NET как образа контейнера с PublishContainer](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/), и оставляет выбор базового образа в файле проекта, где живёт остальная конфигурация публикации.

## Решение 3: осознанно включить инвариантную глобализацию

Если приложение действительно не зависит от культуры (классический случай: внутренний API, обменивающийся метками времени ISO-8601 и числами в инвариантном формате), то инвариантный режим является не костылём, а правильной конфигурацией. Он полностью снимает зависимость и даёт меньший образ и более быстрый старт.

```xml
<!-- .NET 10, C# 14. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Задавайте это в файле проекта, а не в Dockerfile. Согласно проектному документу среды выполнения о режиме инвариантной глобализации, значения из файла проекта и `runtimeconfig.json` имеют приоритет над `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT`, поэтому свойство MSBuild всегда выигрывает, а переменная окружения молча проигрывает. Файл проекта к тому же путешествует вместе с приложением: никто не сможет переложить ваш контейнер в другой оркестратор, забыть блок переменных окружения и воскресить сбой.

Понимайте, на что вы соглашаетесь. В инвариантном режиме:

- `ToUpper` и `ToLower` преобразуют только диапазон ASCII. Турецкие правила для I с точкой и без точки исчезают.
- `String.Compare`, `IndexOf` и `LastIndexOf` выполняют порядковое сравнение независимо от переданных `CompareOptions` или `StringComparison`. Лингвистическая сортировка молча превращается в побайтовую.
- `String.Normalize` возвращает строку без изменений.
- Отображаемые имена часовых поясов в Linux откатываются к стандартному имени вместо локализованного имени из ICU.
- `TimeZoneInfo.TryConvertIanaIdToWindowsId` и обратный метод завершаются неудачей, поскольку опираются на ICU.
- Перечисление культур возвращает ровно одну культуру, а все LCID схлопываются в `0x1000`.

На практике сильнее всего бьёт по рукам создание культур. Начиная с .NET 6 в инвариантном режиме `PredefinedCulturesOnly` по умолчанию равно `true`, поэтому `new CultureInfo("fr-FR")` выбрасывает:

```text
System.Globalization.CultureNotFoundException: Only the invariant culture is supported
in globalization-invariant mode.
```

Если создание должно проходить успешно (middleware локализации запросов, разбирающая `Accept-Language`, делает это даже тогда, когда результат вам не нужен), правило можно ослабить:

```xml
<!-- .NET 10. Cultures can be created, but all behave as invariant. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
  <PredefinedCulturesOnly>false</PredefinedCulturesOnly>
</PropertyGroup>
```

Исключение прекратится. Культурно-зависимое поведение при этом не вернётся: каждая созданная культура ведёт себя ровно как инвариантная. `1234.56m.ToString("C", new CultureInfo("de-DE"))` по-прежнему вернёт инвариантную денежную форму с обобщённым знаком валюты, а не сумму в евро в немецком формате. Если считать эту пару настроек "решением" для по-настоящему локализованного приложения, вы гарантированно выпустите приложение, вывод которого неверен везде, кроме en-US.

## Решение 4: везти ICU с собой (app-local ICU)

Нишевый, но законный вариант: зафиксировать конкретную версию ICU и поставлять её вместе с приложением, чтобы поведение было побайтово одинаковым на любом хосте. Смена версии ICU меняет данные CLDR, а данные CLDR меняют порядок сортировки и форматирование, так что приложение с эталонными тестами по форматированному выводу можно дестабилизировать обновлением базового образа, о котором оно не просило.

```xml
<!-- .NET 10. Ships ICU 72.1 with the app instead of using the system copy. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Globalization.AppLocalIcu" Value="72.1" />
  <PackageReference Include="Microsoft.ICU.ICU4C.Runtime" Version="72.1.0.3" />
</ItemGroup>
```

С включённым переключателем .NET загружает `libicuuc.so.72.1` и `libicui18n.so.72.1` из нативных путей поиска приложения и никогда не смотрит на системную копию. Соответствующая переменная окружения называется `DOTNET_SYSTEM_GLOBALIZATION_APPLOCALICU`, а формат значения имеет вид `<version>` или `<suffix>:<version>`, где суффикс соответствует пользовательской сборке ICU. Если библиотек нет, вы получите другой, более конкретный сбой: `Failed to load app-local ICU: <library name>`. Согласуйте версию в `PackageReference` со значением переключателя, иначе увидите именно это.

## Ловушки, ведущие к неправильному решению

**`ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` в Dockerfile ничего не дал.** Проверьте файл проекта. Если `<InvariantGlobalization>true</InvariantGlobalization>` задано там или в `runtimeconfig.json`, приоритет за ним, а ваша переменная окружения бесполезна. Пройдитесь grep по всему решению, включая `Directory.Build.props`, где часто живёт благонамеренная оптимизация размера.

**`Failed to load system ICU: libicuuc.so.<n>` вместо приведённого выше сообщения.** Это другая ветка. Она означает, что ICU нашёлся при переборе версий, но конкретный soname не удалось загрузить, обычно из-за неполной установки или несовпадения архитектур (слой `amd64` под эмуляцией `arm64`). Проверьте командой `ldconfig -p | grep icu` внутри контейнера.

**Ошибка появляется только в публикациях Native AOT или с обрезкой.** Тогда дело, скорее всего, вовсе не в образе. `PublishAot` и `PublishTrimmed` взаимодействуют с переключателями возможностей, и `InvariantGlobalization` входит в число тех, что часто включают ради размера в шаблонах AOT. Тот же класс проблем "SDK переключил флаг за вашей спиной" разобран в статье о том, [почему отключается сериализация на основе рефлексии](/ru/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/), и в более широком разборе [trim-safe кода](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**Даты форматируются правильно, а часовые пояса не разрешаются.** ICU и tzdata поставляются разными пакетами. `TimeZoneInfo.FindSystemTimeZoneById` читает `/usr/share/zoneinfo`, который оптимизированные по размеру образы тоже опускают. Установите `tzdata` рядом с `icu-libs` либо используйте вариант `-extra`, включающий оба.

**Работает всё, кроме культурно-зависимых тестов.** Вы установили `icu-libs` без `icu-data-full` в Alpine. Присутствуют только данные `en`.

**Образ SDK работает, а образ runtime нет.** Так и должно быть. Образы `sdk` по умолчанию основаны на Debian и несут ICU; зависимость нужна вашей финальной стадии `aspnet` или `runtime`. Диагностируйте внутри реального слоя выполнения, а не слоя сборки.

Чтобы подтвердить, в каком режиме вы оказались, не гадая:

```csharp
// .NET 10, C# 14. Prints 1 in invariant mode, several hundred with ICU loaded.
using System.Globalization;

Console.WriteLine(CultureInfo.GetCultures(CultureTypes.AllCultures).Length);
Console.WriteLine(AppContext.TryGetSwitch("System.Globalization.Invariant", out bool inv) && inv);
```

## Связанные материалы

- [Как опубликовать приложение .NET 11 как образ контейнера с помощью dotnet publish /t:PublishContainer](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [Что такое Native AOT и чего он вам стоит?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [Что такое trim-safe код и как его писать?](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Как сократить время холодного старта AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Источники

- [Режим инвариантной глобализации .NET](https://github.com/dotnet/runtime/blob/main/docs/design/features/globalization-invariant-mode.md), про список изменений поведения и приоритет настроек - dotnet/runtime
- [`GlobalizationMode.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Globalization/GlobalizationMode.Unix.cs), про порядок загрузки и `FailFast` при отсутствии ICU - dotnet/runtime
- [Параметры конфигурации глобализации](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/globalization) - MS Learn
- [Глобализация .NET и ICU](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu), про app-local ICU и последовательность поиска в Linux - MS Learn
- [Включение глобализации в образах контейнеров .NET](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) - dotnet/dotnet-docker
- [Варианты образов .NET](https://github.com/dotnet/dotnet-docker/blob/main/documentation/image-variants.md), про то, какие репозитории публикуют `-extra` - dotnet/dotnet-docker
- [Образы контейнеров .NET](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) - MS Learn
- [Установка .NET в Alpine](https://learn.microsoft.com/en-us/dotnet/core/install/linux-alpine), про список зависимостей, включая `icu-data-full` - MS Learn
- [Alpine 3.16 icu-libs теперь содержит только en](https://github.com/dotnet/dotnet-docker/issues/3844) - dotnet/dotnet-docker
- [Создание культур и сопоставление регистра в режиме инвариантной глобализации](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode) - MS Learn
