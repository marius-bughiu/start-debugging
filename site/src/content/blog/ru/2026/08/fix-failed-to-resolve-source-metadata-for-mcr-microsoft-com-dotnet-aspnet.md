---
title: "Решение: failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet"
description: "BuildKit не может прочитать манифест базового образа. Проверьте существование тега, почините credential helper Docker, откройте обе конечные точки MCR и заранее скачайте образы для офлайн-сборок."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "buildkit"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/08/fix-failed-to-resolve-source-metadata-for-mcr-microsoft-com-dotnet-aspnet"
translatedBy: "claude"
translationDate: 2026-08-29
---

Это BuildKit, который не смог прочитать манифест образа из строки `FROM`, и происходит это до того, как выполнится хотя бы одна инструкция вашего Dockerfile. Четыре причины покрывают почти все случаи, в таком порядке: тег не существует (`11.0` не является настоящим тегом, пока .NET 11 находится в статусе preview), сломанный credential helper в `~/.docker/config.json`, прокси или межсетевой экран блокирует `mcr.microsoft.com` либо `*.data.mcr.microsoft.com`, или офлайн-сборка на билдере, который не видит локально скачанные образы. Сначала выполните `docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:10.0`. Если и это не работает, дело не в вашем Dockerfile.

```text
 => ERROR [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0
------
 > [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0:
------
failed to solve: failed to resolve source metadata for
mcr.microsoft.com/dotnet/aspnet:11.0: mcr.microsoft.com/dotnet/aspnet:11.0: not found
```

Всё изложенное ниже проверено на Docker Engine 29 (BuildKit v0.32.x, Buildx v0.32), .NET 10 (`10.0`, выпущен 2025-11-11) и превью .NET 11, которые в августе 2026 года находятся на стадии Preview 7, а GA запланирован на ноябрь 2026 года. Тот же механизм без изменений применим к Engine 27 и 28, а также к BuildKit-совместимому фронтенду Podman. Между версиями меняется только точная формулировка завершающей части сообщения.

## Что делает BuildKit, когда пишет "resolve source metadata"

BuildKit не выполняет Dockerfile сверху вниз, как это делал классический билдер. Сначала он строит граф зависимостей, а для этого ему нужно знать, чем на самом деле является каждая ссылка `FROM`. Это означает один запрос `HEAD https://mcr.microsoft.com/v2/dotnet/aspnet/manifests/<tag>` на каждый базовый образ и на каждую сборку, чтобы закрепить ссылку за конкретным content digest до того, как начнётся планирование. Этот запрос и есть шаг "load metadata" в выводе сборки, а полученное вами сообщение это тот самый шаг, завершившийся ошибкой.

Отсюда следуют три вещи, которые объясняют почти всю путаницу вокруг этой ошибки:

- **Она возникает, даже когда все слои уже в кеше.** Кешированные слои не отвечают на вопрос "указывает ли этот тег на тот же digest", поэтому BuildKit всё равно спрашивает. Именно поэтому офлайн-сборка падает на машине, которая собрала ровно тот же образ час назад.
- **Она возникает до `RUN`, `COPY` и `WORKDIR`.** Ни один build argument, влияющий на окружение сборки, здесь не поможет, потому что окружение сборки ещё не запущено. В частности, `--build-arg HTTP_PROXY=...` тут не делает ничего. Этот аргумент подставляется в шаги `RUN`; он не настраивает клиент реестра самого демона BuildKit.
- **Настоящая ошибка это то, что стоит после последнего двоеточия.** `not found` означает, что тега не существует. `dial tcp ...: i/o timeout` означает сеть. `error getting credentials` означает вашу конфигурацию Docker. Читайте эту часть первой и сразу переходите к соответствующему разделу ниже.

Всё остальное в сообщении это обёртка BuildKit. Падающее действие всегда одно и то же.

## Минимальное воспроизведение

Два этапа, образ сборки и образ выполнения, ровно та форма, которую генерируют шаблоны контейнеров .NET:

```dockerfile
# Docker Engine 29, BuildKit v0.32. Fails at "load metadata".
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`docker build .` падает сразу же с приведённой выше ошибкой и до `dotnet publish` не доходит. Обратите внимание, что код приложения здесь вообще не участвует. Пустой каталог с одним только этим Dockerfile воспроизводит проблему, и это самый быстрый способ доказать, что дело не в вашем проекте.

## Решение 1: проверьте, что тег действительно существует

Сегодня это самая частая причина, и виноват .NET 11. Microsoft не публикует плавающий тег мажорной версии, пока релиз не достиг GA. В период превью теги называются `11.0-preview` и зафиксированный `11.0.0-preview.7`, плюс варианты с указанием операционной системы, такие как `11.0-preview-resolute` и `11.0-preview-alpine`. Тега `11.0` нет. Он появится в ноябре 2026 года и не раньше, поэтому Dockerfile, скопированный из проекта на .NET 10 и вручную подкрученный до новой версии, падает на имени, которого никогда не существовало.

Спросите реестр напрямую, вместо того чтобы гадать:

```bash
# Works against any registry, prints the manifest list and its platforms.
docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:11.0-preview
```

MCR также отдаёт анонимный список тегов по спецификации OCI, что удобно, когда нужно увидеть, что опубликовано на самом деле:

```bash
curl -s https://mcr.microsoft.com/v2/dotnet/aspnet/tags/list | jq '.tags[] | select(startswith("11.0"))'
```

Ещё две ошибки в теге дают ровно то же сообщение. Первая это переименование репозитория: .NET Core 3.1 и более ранние версии жили в `mcr.microsoft.com/dotnet/core/aspnet`, а всё начиная с .NET 5 живёт в `mcr.microsoft.com/dotnet/aspnet`. Старый Dockerfile, перетащенный в новый проект, сохраняет сегмент `core/` и получает `not found` для любой современной версии. Вторая это выбор снятого с поддержки варианта операционной системы, например тега `bullseye-slim` для версии .NET, у которой база Debian уже сменилась. [Документация по тегам образов контейнеров .NET](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md) это авторитетный источник о том, какие варианты живы, и заглядывать туда при смене базового образа полезнее, чем доверять старой статье. Если вы выбираете между вариантами операционной системы, компромиссы, описанные в статье про [теги контейнеров resolute для .NET 10](/ru/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/), применимы и к превью .NET 11.

## Решение 2: почините credential helper Docker

Если завершающая часть выглядит так, значит с реестром всё в порядке, а сломана ваша локальная конфигурация Docker:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0:
error getting credentials - err: exit status 1, out: ``
```

CLI Docker читает `~/.docker/config.json`, видит запись `credsStore` или `credHelpers` и запускает бинарник `docker-credential-<имя>`, чтобы получить учётные данные для реестра. Когда этого бинарника нет в `PATH` или он не может добраться до хранилища ключей, CLI прерывается ещё до обращения к MCR. Классический триггер это `"credsStore": "desktop"` в файле конфигурации, общем с дистрибутивом WSL2, контейнером CI или удалённой сессией SSH, где `docker-credential-desktop` не существует.

MCR отдаёт свои публичные образы анонимно, так что учётные данные для него вообще не нужны. Удалите запись:

```json
{
  "auths": {},
  "credsStore": ""
}
```

Либо уберите ключ `credsStore` целиком. На macOS рабочее значение это `osxkeychain`, на Linux `pass` или `secretservice`, а если helper действительно установлен, убедитесь, что он отвечает:

```bash
echo '{"ServerURL":"https://index.docker.io/v1/"}' | docker-credential-desktop get
```

Родственный вариант проявляется как `401 Unauthorized` на HEAD-запросе к MCR. Это значит, что в анонимный реестр отправляются устаревшие учётные данные. Очистите их командой `docker logout mcr.microsoft.com` и соберите заново.

## Решение 3: откройте обе конечные точки MCR и настройте прокси для билдера

Microsoft Artifact Registry распределяет работу между двумя именами хостов, и правила межсетевого экрана, написанные только под первое, отказывают так, что это выглядит случайностью. `mcr.microsoft.com` отвечает за обнаружение контента, то есть за запросы манифестов и тегов. `*.data.mcr.microsoft.com` это CDN Azure Front Door, отдающая сами байты слоёв. [Правила межсетевого экрана для клиентов](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md) от Microsoft требуют оба адреса по HTTPS на порту 443 и прямо предостерегают от правил, привязанных к регионам, поскольку регионы конечной точки данных меняются из соображений производительности. Если разрешить только конечную точку реестра, разрешение метаданных пройдёт, а скачивание умрёт позже. Если не разрешить ни одну, вы получите ошибку из этой статьи.

Больше всего времени уходит на настройку прокси, потому что она зависит от используемого драйвера билдера, а эти два ведут себя по-разному:

- **Драйвер `docker` по умолчанию** запускает BuildKit внутри демона Docker и потому наследует его настройки прокси. В Docker Desktop это Settings, Resources, Proxies. На Linux это drop-in systemd в `/etc/systemd/system/docker.service.d/http-proxy.conf`, после чего нужно выполнить `systemctl daemon-reload && systemctl restart docker`.
- **Драйвер `docker-container`**, создаваемый командой `docker buildx create`, запускает BuildKit в отдельном контейнере, который не наследует ничего. Окружение нужно передать явно:

```bash
# Buildx v0.32. env.<key> sets variables inside the BuildKit container.
docker buildx create --name proxied \
  --driver docker-container \
  --driver-opt env.HTTP_PROXY=http://proxy.corp:8080 \
  --driver-opt env.HTTPS_PROXY=http://proxy.corp:8080 \
  --driver-opt env.NO_PROXY=localhost,127.0.0.1 \
  --use
```

Если ваш прокси разрывает TLS корпоративным удостоверяющим центром, завершающая часть будет `tls: failed to verify certificate: x509: certificate signed by unknown authority`. Решение на стороне демона это установить CA в хранилище доверенных сертификатов хоста и перезапустить Docker. Для билдера `docker-container` нужно доставить CA внутрь этого контейнера, либо смонтировав его через собственный `buildkitd.toml`, либо собирая на драйвере по умолчанию.

Чистые сбои DNS выглядят как `dial tcp: lookup mcr.microsoft.com: no such host`, что часто случается в WSL2 после смены VPN. Явные резолверы в `/etc/docker/daemon.json` со значением `"dns": ["1.1.1.1", "8.8.8.8"]` и перезапуск демона обычно решают проблему.

## Решение 4: заранее скачайте образы для офлайн-сборок и следите за драйвером билдера

Поскольку разрешению метаданных всегда нужен живой реестр, сборка в изолированной или нестабильной сети падает, даже когда слои лежат на диске. Решение в том, чтобы образ присутствовал в локальном хранилище образов, а не просто в кеше:

```bash
# Run these while you still have connectivity.
docker pull mcr.microsoft.com/dotnet/sdk:10.0
docker pull mcr.microsoft.com/dotnet/aspnet:10.0
```

С драйвером `docker` по умолчанию BuildKit затем разрешит ссылку из хранилища образов демона, и офлайн-сборка пройдёт. Добавление `--pull=false` делает намерение явным и запрещает BuildKit предпочитать удалённый поиск.

Подвох в том, что это работает только на драйвере по умолчанию. У билдера `docker-container` собственное хранилище контента, и образы демона Docker он не видит, [это давнее и регулярно переоткрываемое поведение](https://github.com/moby/moby/issues/49542). Если вы создали свой билдер ради мультиплатформенной сборки, а затем ушли в офлайн, предварительное скачивание вам ничего не даст. Для работы без сети вернитесь командой `docker buildx use default` или поднимите зеркало реестра, доступное билдеру.

То же различие бьёт и в CI. Раннеры GitHub Actions с `docker/setup-buildx-action` по умолчанию получают билдер `docker-container`, поэтому workflow, который локально работает после шага `docker pull`, на раннере всё равно пойдёт в реестр.

## Решение 5: приведите платформу в соответствие

Если тег существует, но образа под вашу целевую платформу в нём нет, сбой приходит на том же шаге с другой концовкой:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0-nanoserver-ltsc2022:
no match for platform in manifest: not found
```

Два типичных случая. Первый это тег только для Windows, такой как `nanoserver` или `windowsservercore`, запрошенный у демона, работающего с контейнерами Linux. Переключите Docker Desktop на контейнеры Windows или возьмите тег для Linux. Второй это явный `--platform linux/arm64` для тега, в котором опубликован только amd64; со сторонними sidecar-образами такое случается чаще, чем с образами Microsoft, поскольку образы среды выполнения .NET публикуются для amd64, arm64 и arm32v7. `docker buildx imagetools inspect` выводит все платформы из manifest list, поэтому загляните туда, прежде чем считать образ сломанным.

## Похожие ошибки, которые на самом деле другие

`failed to solve: process "/bin/sh -c dotnet restore" did not complete successfully` это совершенно другой сбой. Разрешение метаданных прошло успешно, и ваша сборка уже выполняется, так что проблема в NuGet, а не в реестре. Точно так же `NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json` внутри этапа сборки означает, что контейнер достаёт до MCR, но не до NuGet, и обычно это та же история с прокси уровнем ниже.

Если образ скачивается и стартует, но контейнер сразу завершается, вы уже прошли эту ошибку и оказались в области выполнения. Сбой глобализации, разобранный в статье про [отсутствующий пакет ICU](/ru/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/), самый частый на облегчённых базовых образах.

Наконец, если вы вообще воюете со строками `FROM`, подумайте, нужен ли вам Dockerfile. SDK умеет собирать образ OCI напрямую, и [публикация приложения .NET 11 через `/t:PublishContainer`](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) разрешает базовые образы логикой в стиле NuGet, которая падает с куда более конкретными сообщениями, чем BuildKit.

## Похожие статьи

- [Как опубликовать приложение .NET 11 как образ контейнера с помощью dotnet publish /t:PublishContainer](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [.NET 10 на Ubuntu 26.04: теги контейнеров resolute и Native AOT в архиве](/ru/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [Решение: Couldn't find a valid ICU package installed on the system в контейнере .NET](/ru/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)
- [SBOM для .NET в Docker: перестаньте заставлять один инструмент видеть всё](/ru/2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything/)
- [Aspire против Docker Compose для локальной разработки нескольких сервисов](/ru/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/)

## Источники

- [Правила межсетевого экрана для клиентов Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md)
- [Руководство по конечным точкам Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/mcr-endpoints-guidance.md)
- [dotnet/dotnet-docker: поддерживаемые теги среды выполнения ASP.NET Core](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md)
- [Документация Docker: параметры драйвера сборки docker-container](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Документация Docker: переменные сборки и аргументы прокси](https://docs.docker.com/build/building/variables/)
- [moby/moby#49542: BuildKit с драйвером docker-container отказывается использовать локальные образы](https://github.com/moby/moby/issues/49542)
- [dotnet/core#8268: docker-compose build не может скачать образы с mcr.microsoft.com](https://github.com/dotnet/core/issues/8268)
