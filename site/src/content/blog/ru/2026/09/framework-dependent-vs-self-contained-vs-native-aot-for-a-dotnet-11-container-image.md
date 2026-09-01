---
title: "Framework-dependent vs self-contained vs Native AOT для контейнерного образа .NET 11"
description: "Framework-dependent на chiseled-образе aspnet - правильный вариант по умолчанию для сервиса ASP.NET Core на .NET 11, потому что слой среды выполнения общий для всех сервисов, а CVE в среде выполнения закрывается сменой базового образа. Self-contained с trimming и Native AOT дают образ в 2-5 раз меньше и заметно более быстрый холодный старт, и стоят вам именно этого. Реальные опубликованные размеры, арифметика общих слоёв и ошибка вывода базового образа в .NET 11, ломающая путь AOT."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "containers"
  - "docker"
  - "native-aot"
  - "deployment"
lang: "ru"
translationOf: "2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image"
translatedBy: "claude"
translationDate: 2026-09-01
---

Для обычного долгоживущего сервиса ASP.NET Core на .NET 11 публикуйте **framework-dependent на chiseled-образе `aspnet`**. Это самое маленькое, что вы на самом деле поставляете (несколько мегабайт приложения поверх слоя среды выполнения, который ваши другие сервисы уже скачали), и CVE в среде выполнения закрывается пересборкой на новом теге базового образа, а не пересборкой, повторным тестированием и повторным развёртыванием приложения. Переходите на **self-contained плюс trimming**, когда приложение должно зафиксировать конкретный патч среды выполнения или работать на базовом образе, где .NET нет вообще. Берите **Native AOT** только тогда, когда холодный старт или память на под является доминирующим ограничением и `dotnet publish` не выдаёт ни одного предупреждения AOT по всему дереву зависимостей. Цифры размера, которые приводят для AOT, реальны, но для флота они измеряют не то: framework-dependent образы делят один слой среды выполнения между всеми сервисами на узле, а self-contained и AOT - нет.

Всё здесь нацелено на `<TargetFramework>net11.0</TargetFramework>`. На момент написания .NET 11 находится в Preview 7 (`11.0.100-preview.7.26381.103`, выпущен 2026-08-11), [финальная версия ожидается в ноябре 2026](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview). Теги предварительных образов несут квалификатор `-preview`, который финальная версия убирает, так что сегодняшний `11.0-preview-resolute-chiseled` в ноябре станет `11.0-resolute-chiseled`. Механика ниже стабильна с .NET 8, поэтому почти всё применимо без изменений к .NET 9 и .NET 10.

## Три режима как контейнерные образы

| Свойство | Framework-dependent | Self-contained + trimming | Native AOT |
| --- | --- | --- | --- |
| Репозиторий базового образа | `dotnet/aspnet` или `dotnet/runtime` | `dotnet/runtime-deps` | `dotnet/runtime-deps` |
| Среда выполнения находится в | слое базового образа | слое вашего приложения | скомпилирована внутрь бинарника |
| Слой среды выполнения общий для сервисов | Да | Нет | Нет |
| CVE в среде выполнения закрывается | скачиванием нового базового тега и пересборкой | новым SDK, пересборкой, повторным тестом, развёртыванием | новым SDK, пересборкой, повторным тестом, развёртыванием |
| Переходит на установленный патч | Да | Нет | Нет |
| Включается через | ничего (это значение по умолчанию) | `--self-contained -p:PublishTrimmed=true` | `-p:PublishAot=true` |
| Нужен RID | Нет | Да | Да |
| Сборочной машине нужен C-тулчейн | Нет | Нет | Да (clang, zlib1g-dev) |
| Рефлексия, `Reflection.Emit`, загрузка плагинов | Полностью | Предупреждения trimming, возможны сбои в рантайме | Ограничена или недоступна |
| Пример образа, в сжатом виде | 52.81 MB | 21.86 MB | 11.60 MB |

Последние три цифры взяты из [отчёта о размерах контейнерных образов .NET](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md) в `dotnet/dotnet-docker`, измерены на примере `releasesapi` для .NET 10.0 с базовыми образами `noble-chiseled`. Полные подробности через минуту, потому что именно эта строка вводит людей в заблуждение.

## Что каждый режим на самом деле кладёт в образ

Контейнерный тулинг SDK выводит базовый образ из вашего проекта, и правило короткое. [Согласно справочнику по контейнеризации](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), self-contained проект получает `mcr.microsoft.com/dotnet/runtime-deps`, проект ASP.NET Core получает `mcr.microsoft.com/dotnet/aspnet`, а всё остальное получает `mcr.microsoft.com/dotnet/runtime`. Тег - это числовая часть вашего TFM, с добавленным суффиксом `ContainerFamily`.

Этот вывод и есть вся история:

- **Framework-dependent** приземляется на `aspnet`, то есть `runtime-deps` плюс среда выполнения .NET плюс общий фреймворк ASP.NET Core. Ваш слой содержит IL-сборки и статические ресурсы, обычно единицы мегабайт.
- **Self-contained** приземляется на `runtime-deps`, где есть только нативные библиотеки, нужные .NET (libc, OpenSSL и компания), и никакого .NET. Ваш слой несёт всю среду выполнения и общий фреймворк, поэтому trimming здесь так важен.
- **Native AOT** тоже приземляется на `runtime-deps`, но ваш слой - это один нативный исполняемый файл без IL и без JIT. Обратите внимание: суффикса `-aot` у `runtime-deps` больше нет: он существовал для .NET 8, а в .NET 10 специфичные для AOT теги runtime-deps были влиты в обычные `-chiseled`. Суффикс `-aot` теперь живёт на образах **SDK** (`sdk:11.0-preview-aot`, `sdk:11.0-preview-resolute-aot`), которые несут тулчейн clang и zlib, нужный компилятору AOT во время сборки.

Все три наследуют одинаковое усиление защиты от образов Microsoft: непривилегированного пользователя `app` с UID 1654, доступного через `$APP_UID`, и порт 8080 вместо 80, оба [появились в .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers). Chiseled-образы вдобавок не содержат ни оболочки, ни менеджера пакетов, ни `curl`, поэтому отладка через `docker exec` и health-check на основе оболочки не работают ни в одном из трёх режимов, если вы выбрали chiseled-семейство.

## Как опубликовать каждый из трёх

Framework-dependent, RID не нужен, сразу на chiseled-базу ASP.NET Core:

```bash
# .NET 11 SDK 11.0.100-preview.7. Framework-dependent onto aspnet:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Self-contained с trimming. `PublishTrimmed` подразумевает `SelfContained`, но пропишите оба явно, чтобы будущему читателю не пришлось это помнить:

```bash
# .NET 11 SDK 11.0.100-preview.7. Self-contained + trimmed onto runtime-deps:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  --self-contained \
  -p PublishTrimmed=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Native AOT. `PublishAot` подразумевает self-contained и требует C-тулчейн платформы на сборочной машине:

```bash
# .NET 11 SDK 11.0.100-preview.7. Native AOT onto runtime-deps:11.0-preview-resolute-chiseled.
# Requires clang and zlib1g-dev locally, or build inside sdk:11.0-preview-aot.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Если вы предпочитаете делать это из CI, не устанавливая clang на агент, AOT-образ SDK и есть причина существования этих тегов:

```dockerfile
# .NET 11 preview. Multi-stage AOT build.
FROM mcr.microsoft.com/dotnet/sdk:11.0-preview-resolute-aot AS build
WORKDIR /src
COPY . .
RUN dotnet publish OrdersApi/OrdersApi.csproj -c Release -r linux-x64 -p:PublishAot=true -o /app

FROM mcr.microsoft.com/dotnet/runtime-deps:11.0-preview-resolute-chiseled
WORKDIR /app
COPY --from=build /app/OrdersApi .
USER $APP_UID
ENTRYPOINT ["./OrdersApi"]
```

Полный набор свойств `Container*`, управление тегами и аутентификацию в реестрах смотрите в разборе про [публикацию приложения .NET 11 как контейнерного образа без Dockerfile](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/).

## Опубликованные цифры размеров

Microsoft публикует измеренные размеры для примера минимального web API по всем вариантам базовых образов, так что гадать не нужно. Это сжатые размеры примера `releasesapi` на .NET 10.0:

| Базовый образ | Framework-dependent | Self-contained + trimming | Native AOT |
| --- | --- | --- | --- |
| Полный Ubuntu (`10.0`) | 92.48 MB | 61.53 MB | 51.27 MB |
| `10.0-noble-chiseled` | 52.81 MB | 21.86 MB | 11.60 MB |
| `10.0-noble-chiseled-extra` | 67.68 MB | 36.82 MB | 26.56 MB |
| `10.0-alpine` | 51.93 MB | 20.95 MB | 10.69 MB |
| `10.0-alpine-extra` | 66.50 MB | 35.52 MB | 25.25 MB |

Из этой таблицы сразу следуют две вещи. Во-первых, **семейство базового образа - рычаг больший, чем режим развёртывания**. Перевод framework-dependent приложения с полного образа Ubuntu на `noble-chiseled` экономит 39.67 MB, то есть больше, чем даёт перевод того же приложения с framework-dependent на Native AOT на полном образе (41.21 MB), и не требует никакой работы по совместимости. Если вы ещё не перешли на chiseled, сделайте это первым и перемерьте, прежде чем рассматривать что-то ещё.

Во-вторых, chiseled Native AOT действительно примерно в 4.5 раза меньше, чем chiseled framework-dependent. Это настоящий выигрыш, и для scale-to-zero функции или узла очень высокой плотности он решающий.

## Арифметика общих слоёв, переворачивающая аргумент про размер

Вот часть, которую отчёт о размерах показать не может, потому что он измеряет один образ изолированно.

Контейнерные образы - это слои, адресуемые по содержимому. Если десять ваших сервисов собираются `FROM mcr.microsoft.com/dotnet/aspnet:11.0-preview-resolute-chiseled`, каждый узел, который их запускает, скачивает и хранит этот слой среды выполнения ровно один раз. Предельная стоимость одиннадцатого сервиса - это его собственный слой приложения, для framework-dependent сервиса ASP.NET Core это несколько мегабайт IL.

Посчитайте для десяти сервисов на одном узле, по колонке chiseled выше:

- **Framework-dependent**: около 50 MB общих слоёв `aspnet` плюс 10 слоёв приложения примерно по 3 MB. Пусть будет 80 MB.
- **Self-contained с trimming**: общий слой `runtime-deps` на несколько мегабайт плюс 10 слоёв приложения, каждый со своей обрезанной копией среды выполнения. Примерно 10 x 20 MB, то есть около 200 MB.
- **Native AOT**: та же форма, 10 x 11 MB, то есть около 110 MB.

Self-contained оказывается худшим из трёх в масштабе флота, хотя на одном образе он выигрывает у framework-dependent в 2.4 раза, потому что trimming работает на уровне приложения и не может дедуплицировать между приложениями. Native AOT достаточно мал, чтобы остаться впереди, но его преимущество падает с 4.5 раз до заметно меньшего, чем двукратное. Хранилище реестра, межзональный трафик скачивания и давление на диск узла следуют этому второму расчёту, а не первому. Измерьте свой флот, прежде чем что-то мигрировать из соображений размера.

## Патчи: кто закрывает CVE в среде выполнения

Это аргумент, который для большинства команд и должен решать, и именно его прямо формулирует [обзор публикации](https://learn.microsoft.com/en-us/dotnet/core/deploying/). Framework-dependent приложение "автоматически переходит на последний патч безопасности .NET, доступный в окружении", тогда как self-contained развёртывание "не переходит", и "среду выполнения .NET можно обновить только выпуском новой версии приложения".

В терминах контейнеров:

- **Framework-dependent**: когда Microsoft выпускает внеплановое исправление среды выполнения, вы перетегируете, пересобираете и разворачиваете заново. Ваш код побайтово идентичен, поэтому изменение механически безопасно. Автоматизация обновления базового образа (Dependabot, Renovate) сделает это без человека, и одного PR на репозиторий достаточно.
- **Self-contained и Native AOT**: среда выполнения находится внутри слоя вашего приложения, поэтому исправление требует нового SDK на сборочном агенте, полной пересборки и полного прогона тестов, для каждого сервиса. Для AOT это вдобавок означает перекомпиляцию нативного кода, самую медленную сборку из тех, что у вас есть.

Если в вашей организации есть контроль "закрывать критические CVE за N дней", эта разница не сноска. Это причина оставаться на framework-dependent, пока что-нибудь не заставит уйти.

## Глобализация - скрытый переключатель между chiseled и chiseled-extra

Обычные `-chiseled`, `-alpine` и `-distroless` образы Azure Linux идут без ICU и tzdata, поэтому работают только с приложениями в инвариантном режиме глобализации. Варианты `-extra` возвращают ICU, tzdata и `libstdc++`, и именно из этого складываются те 15 MB разницы в таблице размеров.

Для self-contained и AOT публикаций SDK пытается помочь: если `InvariantGlobalization` равно false, он направляет вас на вариант `-extra`. Для framework-dependent публикаций семейство выбираете вы сами, поэтому выставить соответствующее свойство - ваша задача:

```xml
<!-- .NET 11, net11.0. Required if you target a plain -chiseled or -alpine base. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Ошибётесь здесь - и контейнер умрёт при старте с `Couldn't find a valid ICU package installed on the system`, у чего есть [отдельная статья с решением](/ru/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/). И инвариантный режим не бесплатен: сравнение строк с учётом культуры, `ToUpper` и `ToLower` для не-ASCII и поиск в `TimeZoneInfo` меняют поведение. Если вы что-то локализуете или форматируете валюту, заплатите 15 MB за `-extra`.

## Подвох .NET 11: вывод базового образа всё ещё говорит noble

Контейнерный тулинг вычисляет кодовое имя Ubuntu для выводимого тега из версии SDK, и в превью .NET 11 эта таблица знает только `jammy` (SDK ниже 8.0.300) и `noble` (8.0.300 и выше). Поскольку `11.0.100` удовлетворяет второму условию, она возвращает `noble`, но образы .NET 11 на MCR публикуются под `resolute` (Ubuntu 26.04). Результат, [заведённый как dotnet/sdk#53553](https://github.com/dotnet/sdk/issues/53553):

```console
error CONTAINER1015: Unable to access the repository 'dotnet/runtime-deps' at tag '11.0.0-preview.2-noble-chiseled-extra'
```

Радиус поражения - ровно те пути, о которых эта статья. Framework-dependent публикация проходит нормально, потому что не идёт по ветке вывода кодового имени. Self-contained с trimming и `PublishAot=true` попадают обе. Решение - перестать полагаться на вывод и назвать семейство явно, поэтому все команды выше его передают:

```bash
# .NET 11 SDK 11.0.100-preview.7. Explicit family, no codename inference.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled
```

Задать `ContainerBaseImage` полностью квалифицированным именем тоже работает и полностью обходит `ContainerFamily`. Явно фиксировать семейство - хорошая практика в любом случае: именно это не даёт будущему SDK молча перевести ваш флот на другой дистрибутив. [Ротация тегов Ubuntu 26.04](/ru/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) - тот же урок со стороны .NET 10.

## Ограничение, которое выбирает за вас

Большинство команд до взвешивания размеров вообще не доходит, потому что решает одно жёсткое ограничение:

- **Зависимости, активно использующие рефлексию.** Динамические прокси, сериализаторы на рефлексии, DI-контейнеры с генерацией кода в рантайме, загрузка плагинов. Native AOT отпадает, trimming рискован. Считайте сигналом "да или нет" предупреждения публикации, а не документацию. [Безопасный для trimming код](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) - предпосылка для обоих.
- **Комплаенс-срок на устранение CVE.** Framework-dependent, потому что обновление базового образа - механическое изменение, а пересборка нет.
- **Scale-to-zero или оплата за запрос.** Холодный старт определяет счёт. Native AOT стартует примерно в 3 раза быстрее обычного JIT и использует меньше половины рабочего набора, согласно измерениям в [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Один артефакт сборки для нескольких платформ.** Framework-dependent без RID - единственный режим, дающий один артефакт; два других привязаны к RID и требуют матрицы сборки.
- **Базовый образ без .NET, который вы не контролируете.** Self-contained, поскольку это единственный режим, работающий на произвольном образе дистрибутива с нужными нативными библиотеками и больше ничем.

## Рекомендация, ещё раз

По умолчанию - **framework-dependent на `aspnet:11.0-<family>-chiseled`**. Это самый дешёвый образ в масштабе флота, единственный режим, где CVE в среде выполнения закрывается обновлением базового образа, а не релизом, и единственный, дающий один артефакт, не привязанный к RID. Переходите на **Native AOT на `runtime-deps:11.0-<family>-chiseled`**, когда холодный старт или плотность по памяти становится связывающим ограничением, а дерево зависимостей публикуется чисто. Используйте **self-contained плюс trimming** как средний вариант, когда нужна фиксация версии среды выполнения или базовый образ без .NET, понимая, что для хранения в масштабе всего флота это худший из трёх. Что бы вы ни выбрали, задавайте `ContainerFamily` явно и переведите образ на chiseled прежде, чем оптимизировать что-либо ещё.

## Связанное

- [Как опубликовать приложение .NET 11 как контейнерный образ через dotnet publish /t:PublishContainer](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) описывает всю поверхность свойств `Container*`, на которую опираются эти команды.
- [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) - сравнение моделей компиляции, лежащее под этим сравнением упаковки, с измерениями старта и пропускной способности.
- [Что такое Native AOT и чего он вам стоит?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/) перечисляет ограничения API и библиотек до того, как вы примете решение.
- [Что такое безопасный для trimming код и как его писать?](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) - предпосылка и для self-contained с trimming, и для AOT.
- [В чём разница между dotnet build и dotnet publish?](/ru/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) объясняет, почему всё это происходит только во время публикации.

## Источники

- [Обзор публикации приложений .NET](https://learn.microsoft.com/en-us/dotnet/core/deploying/), MS Learn (компромиссы framework-dependent и self-contained, roll-forward, AOT).
- [Справочник по контейнеризации приложения .NET](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), MS Learn (вывод `ContainerBaseImage`, `ContainerFamily`, `ContainerUser`).
- [Контейнерные образы .NET](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images), MS Learn (репозитории, варианты chiseled и extra, глобализация).
- [Отчёт о размерах образов примера](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md), `dotnet/dotnet-docker` (измеренные размеры примера `releasesapi`).
- [Вывод базового образа использует неверное кодовое имя Ubuntu для .NET 11](https://github.com/dotnet/sdk/issues/53553), `dotnet/sdk` (CONTAINER1015, обходной путь через `ContainerFamily`).
- [Что нового в контейнерах для .NET 8](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers), MS Learn (непривилегированный пользователь `app`, `APP_UID`, порт 8080).
- [Что нового в .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), MS Learn (статус превью, срок финальной версии, изменения контейнеров SDK).
