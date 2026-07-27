---
title: "Как опубликовать приложение .NET 11 как образ контейнера с помощью dotnet publish /t:PublishContainer"
description: "Полное руководство по сборке образов контейнеров из приложения .NET 11 без Dockerfile: цель PublishContainer, ContainerRepository и ContainerImageTags, выбор базового образа через ContainerBaseImage и ContainerFamily, отправка в реестр и как разрешается аутентификация, мультиархитектурные индексы образов OCI, пользователь без прав root по умолчанию, управление entrypoint, вывод в tarball для сканеров и случаи, когда Dockerfile всё же нужен."
pubDate: 2026-07-27
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "containers"
  - "docker"
  - "devops"
  - "msbuild"
lang: "ru"
translationOf: "2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer"
translatedBy: "claude"
translationDate: 2026-07-27
---

Чтобы превратить приложение .NET 11 в образ контейнера без написания Dockerfile, выполните `dotnet publish --os linux --arch x64 /t:PublishContainer` в каталоге проекта. SDK скачивает подходящий базовый образ Microsoft, укладывает поверх результат публикации и отправляет итог в локальный демон Docker или Podman. Добавьте `-p ContainerRegistry=ghcr.io`, чтобы отправить образ в настоящий реестр, или `-p ContainerArchiveOutputPath=./images/app.tar.gz`, чтобы получить tarball и вообще не трогать демон. Всё, что выражал бы Dockerfile (базовый образ, теги, порты, переменные окружения, метки, пользователь, entrypoint), задаётся свойством или элементом MSBuild. Статья ориентирована на .NET 11 (на момент написания preview 6, финальный выпуск в ноябре 2026 года) с C# 14 и SDK 11.0.1xx. Почти всё работает без изменений и на SDK .NET 8, 9 и 10, а минимальные версии я отмечаю там, где они важны.

## Что SDK делает вместо Dockerfile

Ментальная модель, с которой обычно приходят, ошибочна, но полезным образом. `PublishContainer` не является обёрткой над `docker build`. Никакой Dockerfile за кулисами не генерируется, и Docker вообще не участвует в создании образа.

На самом деле цели `Microsoft.NET.Build.Containers`, поставляемые внутри SDK, напрямую общаются с HTTP-API реестра:

1. Приложение публикуется обычным образом в `bin/Release/net11.0/<rid>/publish/`.
2. SDK разрешает базовый образ (по умолчанию один из репозиториев `mcr.microsoft.com/dotnet/*`) и загружает его манифест и конфигурацию из MCR. Блобы слоёв, которые не нужны, он не скачивает.
3. Папка публикации упаковывается в один новый слой tar.
4. Собираются новая конфигурация и новый манифест образа: базовые слои плюс ваш слой, а также entrypoint, рабочий каталог, открытые порты, переменные окружения, метки и пользователь.
5. Результат куда-то отправляется. По умолчанию в локальный демон, в удалённый реестр, если задано `ContainerRegistry`, или в `tar.gz` на диске, если задано `ContainerArchiveOutputPath`.

Отсюда сразу следуют два вывода. Во-первых, среда выполнения контейнеров не нужна, чтобы *собрать* образ, она нужна только чтобы *запустить* его локально, а значит подход применим на агентах CI без сокета Docker. Во-вторых, шага `RUN` нет, потому что во время сборки не запускается никакой контейнер. Если образу нужен `apt-get install`, это запекается в собственный базовый образ, на который указывает `ContainerBaseImage`.

`/t:PublishContainer` это цель MSBuild, а не опция `dotnet publish`, поэтому и синтаксис соответствующий. Старая форма `-p PublishProfile=DefaultContainer` по-прежнему работает и делает то же самое. Если разница между `dotnet build` и `dotnet publish` размыта, стоит потратить пять минут на [разницу между dotnet build и dotnet publish](/ru/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/), потому что всё описанное здесь опирается на результат публикации.

## Шаги публикации приложения .NET 11 как образа контейнера

1. Убедитесь, что установлен SDK .NET 11 (`dotnet --info`). Публикация контейнеров работает начиная с SDK .NET 7, но описанные здесь значения по умолчанию относятся к SDK .NET 8 и новее.
2. Задайте `ContainerRepository` в файле проекта, если имя сборки не является допустимым именем образа (обычно мешают заглавные буквы).
3. Выполните `dotnet publish --os linux --arch x64 /t:PublishContainer`, чтобы собрать образ и загрузить его в локальный демон.
4. Проверьте через `docker images` и запустите: `docker run --rm -p 8080:8080 my-app:latest`.
5. Добавьте `-p ContainerRegistry=<registry>`, когда локальный образ уже корректен, предварительно выполнив `docker login <registry>`.
6. Перенесите нужные настройки в `.csproj` на постоянной основе, чтобы CI и локальные запуски совпадали.

Это весь цикл. Остальная часть статьи о том, что делает каждая ручка и где острые углы.

## Именование: реестр, репозиторий, тег

Имя образа, которое создаёт SDK, собирается из отдельных свойств, соответствующих частям полной ссылки на образ:

```text
REGISTRY[:PORT]/REPOSITORY[:TAG]
```

- `ContainerRegistry` по умолчанию указывает на локальный демон. Задайте `ghcr.io`, `myorg.azurecr.io`, `docker.io`, `quay.io` или приватный `registry.mycorp.com:5000`.
- `ContainerRepository` по умолчанию берёт `AssemblyName` проекта. Имена образов должны состоять из строчных букв и цифр плюс точки, подчёркивания, дефисы и слэши, и начинаться с буквы или цифры. Сборка с именем `DotNet.ContainerImage` не является допустимым именем репозитория, поэтому в руководстве Microsoft это свойство задаётся явно.
- `ContainerImageTag` по умолчанию равен `latest` в SDK .NET 8 и новее. До этого по умолчанию использовалось значение `Version` проекта.

```xml
<!-- .csproj, .NET 11 SDK 11.0.1xx -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <ContainerRegistry>ghcr.io</ContainerRegistry>
  <ContainerRepository>marius-bughiu/orders-api</ContainerRepository>
  <ContainerImageTags>1.4.2;latest</ContainerImageTags>
</PropertyGroup>
```

`ContainerImageTags` (во множественном числе, через точку с запятой) создаёт по одному образу на тег, что соответствует обычной схеме "версия плюс подвижный latest". Длина тега ограничена 127 символами, и начинаться он должен с буквы, цифры или подчёркивания.

Форма множественного числа это настоящая ловушка в командной строке, потому что точка с запятой является разделителем списков MSBuild, и как PowerShell, так и Bash хотят её истолковать по-своему. Экранирование различается в зависимости от оболочки:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  /p:ContainerImageTags='"1.4.2;latest"'
```

```powershell
dotnet publish --os linux --arch x64 /t:PublishContainer /p:ContainerImageTags=`"1.4.2`;latest`"
```

Если эта борьба не стоит того в скрипте CI, задайте вместо этого переменную окружения `ContainerImageTags`. MSBuild читает переменные окружения как свойства, а оболочка при этом вообще не видит точку с запятой.

Учтите также, что отправка в Docker Hub требует имени пользователя в репозитории (`myuser/orders-api`), а не только голого имени образа.

## Выбор базового образа без строки FROM

По умолчанию SDK выводит базовый образ из формы проекта:

- Проекты ASP.NET Core получают `mcr.microsoft.com/dotnet/aspnet`.
- Self-contained проекты получают `mcr.microsoft.com/dotnet/runtime-deps`, потому что среда выполнения находится внутри результата публикации.
- Всё остальное получает `mcr.microsoft.com/dotnet/runtime`.

Тег берётся из числовой части `TargetFramework`, поэтому `net11.0` разрешается в тег `11.0`. Начиная с SDK 8.0.200 вывод также реагирует на способ публикации: RID `linux-musl-x64` или `linux-musl-arm64` выбирает варианты Alpine, а `PublishAot=true` выбирает вариант chiseled AOT образа `runtime-deps`.

Чтобы выбрать другую *разновидность* образа Microsoft, а не совсем другой образ, используйте `ContainerFamily`. Значение дописывается к выведенному тегу:

```xml
<PropertyGroup>
  <ContainerFamily>alpine</ContainerFamily>
</PropertyGroup>
```

Это превращает тег базового образа в `11.0-alpine`. Поле произвольное и просто конкатенируется, поэтому проверьте, что запрашиваемый тег действительно существует в репозитории `mcr.microsoft.com/dotnet/aspnet` (или `runtime`), прежде чем на него полагаться. `ContainerFamily` полностью игнорируется, когда задано `ContainerBaseImage`.

Для полного контроля задайте `ContainerBaseImage` полным именем вместе с тегом:

```xml
<PropertyGroup>
  <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:11.0-alpine</ContainerBaseImage>
</PropertyGroup>
```

Это же и обходной путь при отсутствии поддержки `RUN`: один раз соберите базовый образ через Dockerfile, который ставит нужный нативный пакет, отправьте его в реестр и укажите на него все сервисы.

Контейнеры Windows требуют того же подхода. Начиная с .NET 8 списки манифестов Microsoft больше не включают варианты Windows, поэтому для Nano Server тег нужно называть явно, например `mcr.microsoft.com/dotnet/aspnet:11.0-nanoserver-ltsc2022`.

Если вы сочетаете это с Native AOT ради действительно маленького образа, компромиссы из статьи [во что на самом деле обходится Native AOT](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/) внутри контейнера остаются теми же, а экономия на слоях обычно меньше, чем цена ограничений рефлексии для совместимости библиотек.

## Отправка в реестр и как разрешается аутентификация

Задайте `ContainerRegistry`, и SDK отправит образ по Docker Registry HTTP API V2 вместо загрузки в локальный демон:

```bash
# .NET 11 SDK
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerRegistry=ghcr.io \
  -p ContainerRepository=marius-bughiu/orders-api
```

Учётные данные разрешаются через собственную конфигурацию Docker в следующем порядке полезности:

1. `~/.docker/config.json` или каталог, указанный переменной окружения `DOCKER_CONFIG`. Раздел `auths` (то, что записывает `docker login`) читается напрямую.
2. Записи `credHelpers`, сопоставляющие реестр с исполняемым файлом `docker-credential-<name>` в `PATH`. Именно так ACR, ECR и Google Artifact Registry выдают короткоживущие токены.
3. `credsStore`, помощник связки ключей операционной системы.

Если ничего из этого недоступно, например внутри контейнера с SDK, куда не примонтирована конфигурация Docker, есть две переменные окружения как крайнее средство:

```bash
export DOTNET_CONTAINER_REGISTRY_UNAME='<token>'
export DOTNET_CONTAINER_REGISTRY_PWORD="$GITHUB_TOKEN"
```

О них надо знать две вещи. Префикс изменился с `SDK_CONTAINER_*` на `DOTNET_CONTAINER_*` в SDK 8.0.400, и устаревшие статьи всё ещё показывают старые имена. И они применяются к *обоим* реестрам, исходному (MCR, откуда берётся базовый образ) и целевому, что делает их непригодными, когда для них нужны разные учётные данные. Предпочитайте `docker login`.

Для реестра по обычному HTTP во внутренней сети SDK 9.0.1xx и новее принимает список разрешённых адресов через запятую:

```bash
export DOTNET_CONTAINER_INSECURE_REGISTRIES=localhost:5000,registry.mycorp.com
```

**Новое в .NET 11:** SDK теперь проверяет `realm` bearer-токена, который реестр возвращает в запросе аутентификации, прежде чем следовать за ним ([dotnet/sdk#54225](https://github.com/dotnet/sdk/pull/54225)). Realm должен быть абсолютным URI, должен использовать HTTPS, если реестр не отмечен явно как небезопасный, и не должен разрешаться в IP-литерал из loopback, приватного, link-local или неопределённого диапазона. Хосты реестра и аутентификации по-прежнему могут различаться, это нормальный шаблон OCI. Это ломающее изменение в том смысле, что неправильно настроенный или вредоносный реестр, который раньше "работал", теперь приведёт к раннему сбою публикации. Если ранее исправно работавший внутренний реестр начал падать на .NET 11, эту проверку стоит смотреть первой.

## Мультиархитектурные образы и индекс образов OCI

Начиная с SDK 8.0.405, 9.0.102 и 9.0.2xx `PublishContainer` умеет создавать настоящий мультиархитектурный образ. Правило зависит от того, какие свойства RID заданы:

- Единственный `RuntimeIdentifier` или `ContainerRuntimeIdentifier` даёт одноархитектурный образ, как и раньше.
- Если единственного RID нет, но заданы несколько `RuntimeIdentifiers` или `ContainerRuntimeIdentifiers`, SDK публикует по разу на каждый RID и объединяет результаты в [OCI Image Index](https://specs.opencontainers.org/image-spec/image-index/), чтобы все архитектуры делили одно имя.

```xml
<!-- .NET 11, SDK 11.0.1xx -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

```bash
# Note: no --arch, and no -r. Passing either collapses it back to one architecture.
dotnet publish --os linux /t:PublishContainer
```

`ContainerRuntimeIdentifiers` должен быть подмножеством `RuntimeIdentifiers`, иначе части конвейера сборки падают запутанным образом. Мультиархитектурные образы всегда выпускаются в формате OCI независимо от значения `ContainerImageFormat`, потому что в схеме манифеста Docker v2 нет аналога индекса образов.

Две эксплуатационные заметки. Проекты Blazor WebAssembly могут столкнуться с состояниями гонки при параллельной публикации RID; `ContainerPublishInParallel=false` сериализует их ценой общего времени (SDK 8.0.408, 9.0.300, 10.0 и новее). А .NET 11 preview 6 добавил мультиархитектурную поддержку, когда локальным движком является Podman ([dotnet/sdk#54575](https://github.com/dotnet/sdk/pull/54575)); раньше для этого требовался Docker.

`ContainerImageFormat`, добавленный в .NET 10, позволяет принудительно выбрать `Docker` или `OCI` для одноархитектурного случая. Значение по умолчанию выводится из базового образа, а образы Microsoft по-прежнему используют media type манифеста Docker. Установите `OCI`, если на этом настаивает инструмент дальше по конвейеру.

## Порты, переменные окружения, метки и пользователь

Это элементы, а не свойства, поэтому они попадают в `ItemGroup`:

```xml
<ItemGroup>
  <ContainerPort Include="8080" Type="tcp" />
  <ContainerEnvironmentVariable Include="ASPNETCORE_FORWARDEDHEADERS_ENABLED" Value="true" />
  <ContainerLabel Include="org.contoso.businessunit" Value="orders" />
</ItemGroup>
```

`ContainerPort` в .NET 8 и новее выводится из `ASPNETCORE_URLS`, `ASPNETCORE_HTTP_PORTS` или `ASPNETCORE_HTTPS_PORTS`, прочитанных либо из базового образа, либо из ваших собственных элементов `ContainerEnvironmentVariable`. Поскольку образы ASP.NET Core задают `ASPNETCORE_HTTP_PORTS=8080`, обычному веб-API настройка портов обычно не нужна вовсе.

У `ContainerEnvironmentVariable` есть реальное ограничение, которое стоит учитывать: сейчас его нельзя задать из CLI, только из файла проекта ([dotnet/sdk-container-builds#451](https://github.com/dotnet/sdk-container-builds/issues/451)). Всё, что зависит от окружения, поэтому относится к конфигурации оркестратора, а не запекается в образ, где ему в любом случае не место.

Метки почти полностью проставляются сами. SDK записывает стандартные аннотации OCI (`org.opencontainers.image.created`, `.version`, `.title`, `.source`, `.revision`, `.base.name`, `.base.digest` и другие) из существующих свойств MSBuild. `.source` и `.revision` появляются только при `PublishRepositoryUrl` равном `true` и наличии SourceLink в сборке. Отключить весь набор можно через `ContainerGenerateLabels=false`, а отдельную метку через её флаг `ContainerGenerateLabelsImage*`.

Значение пользователя по умолчанию удивляет приятным образом. При нацеливании на .NET 8 и новее с образами среды выполнения Microsoft контейнер работает от пользователя `app` без прав root в Linux (по UID через переменную окружения `APP_UID`) и от `ContainerUser` в Windows. Это правильное значение, и его лучше не трогать. Но оно означает, что приложение не может писать в произвольные пути, не может слушать порты ниже 1024 и не может читать файлы, права которых предполагают root. Если root действительно нужен, есть `ContainerUser=root`, и SDK не проверяет, существует ли названный вами пользователь в образе.

`ContainerWorkingDirectory` по умолчанию равен `/app`.

## Управление entrypoint

Для большинства приложений entrypoint это сгенерированный бинарник apphost, и делать ничего не нужно. Когда нужно, чтобы образ запускал инструмент, а не ваше приложение, используйте `ContainerAppCommand` вместе с `ContainerAppCommandArgs`, а также `ContainerDefaultArgs` для аргументов, которые вызывающая сторона должна иметь возможность переопределить:

```xml
<ItemGroup>
  <!-- Semicolons split tokens: this is dotnet ef database update -->
  <ContainerAppCommand Include="dotnet;ef" />
  <ContainerAppCommandArgs Include="database;update" />
</ItemGroup>
```

`ContainerAppCommandInstruction` решает, как это сочетается с `ENTRYPOINT` базового образа, и принимает значения `Entrypoint`, `DefaultArgs` или `None`. `DefaultArgs` используется по умолчанию и является самым тонким: когда элементов `ContainerEntrypoint` нет, он пропускает entrypoint базового образа, жёстко заданный как `dotnet` или `/usr/bin/dotnet`, чтобы контроль остался полностью за вами. `ContainerEntrypoint` и `ContainerEntrypointArgs` устарели начиная с .NET 8; используйте вместо них элементы app command.

## Вывод в tarball для конвейеров сканирования

Конвейеры с упором на безопасность часто хотят просканировать образ до того, как он попадёт в реестр. `ContainerArchiveOutputPath` пишет образ в `tar.gz` и не требует демона:

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerArchiveOutputPath=./images/orders-api.tar.gz
```

```bash
docker load -i ./images/orders-api.tar.gz
```

Podman использует `podman load -i` с тем же файлом. Если указать каталог вместо имени файла, архив будет назван `$(ContainerRepository).tar.gz`. Все `ContainerImageTags` окажутся внутри одного архива, а не породят несколько файлов.

## Встраивание в GitHub Actions

Всё сводится к трём шагам, потому что нет ни Buildx, ни QEMU, ни Dockerfile, который надо держать в синхронизации с проектом:

```yaml
# .github/workflows/publish.yml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '11.0.x'

- name: Log in to GHCR
  run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

- name: Publish container
  run: >
    dotnet publish src/Orders.Api/Orders.Api.csproj
    --os linux /t:PublishContainer
    -p ContainerRegistry=ghcr.io
    -p ContainerRepository=${{ github.repository_owner }}/orders-api
    -p ContainerImageTag=${{ github.sha }}
```

`docker login` нужен только чтобы заполнить `~/.docker/config.json`; сама отправка выполняется SDK по HTTPS. На раннере, где Docker нет вовсе, замените этот шаг экспортом `DOTNET_CONTAINER_REGISTRY_UNAME` и `DOTNET_CONTAINER_REGISTRY_PWORD`.

## Когда Dockerfile всё же нужен

Стоит честно очертить границы. Берите Dockerfile, когда нужны шаги `RUN`, когда многоэтапная сборка должна компилировать не относящиеся к .NET артефакты (фронтенд на Node, нативные зависимости) в том же файле, или когда нужен тонкий контроль порядка слоёв ради эффективности кеша по множеству образов.

Всё остальное, а на практике это большинство сервисов ASP.NET Core и worker service, лучше живёт с `PublishContainer`. Конфигурация образа лежит в том же файле, что и остальная сборка, она не может разойтись с TFM, и нет строки `COPY --from=build /app/publish .`, в которой можно ошибиться. Если приложение уже работает под [.NET Aspire](/ru/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), это же и механизм, который AppHost использует, упаковывая ресурс проекта в контейнер для развёртывания.

Последняя заметка о версиях для консольных приложений: в SDK .NET 10 и новее консольный проект публикует контейнер без дополнительной настройки. В SDK .NET 9 и старее требовалось `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` в файле проекта, и это свойство по-прежнему задают для типов проектов, которые SDK не включает автоматически.

## Похожие статьи

- [В чём разница между dotnet build и dotnet publish?](/ru/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) о том, что на самом деле оказывается в папке, ставшей слоем вашего образа.
- [Что такое Native AOT и чего он вам стоит?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/) прежде чем гнаться за меньшим образом с помощью `PublishAot`.
- [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) о цифрах старта и размера за этим решением.
- [Как добавить .NET Aspire в существующее решение ASP.NET Core](/ru/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) если тем же проектам нужна и локальная оркестрация.
- [Что такое код, безопасный для trimming, и как его писать?](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) поскольку trimming это вторая половина уменьшения образа контейнера.

## Источники

- [Containerize an app with dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/containers/sdk-publish) на Microsoft Learn.
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration), полный список свойств и элементов.
- [Authenticating to container registries](https://github.com/dotnet/sdk-container-builds/blob/main/docs/RegistryAuthentication.md) в репозитории dotnet/sdk-container-builds.
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk) о `ContainerImageFormat` и поддержке консольных приложений.
- [.NET SDK in .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) о проверке realm для bearer-токена.
- [.NET SDK in .NET 11 Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) о мультиархитектурной поддержке с Podman.
