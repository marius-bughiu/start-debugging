---
title: "Разверните .NET-приложение с Podman + systemd: стабильные перезапуски, настоящие логи, без магии"
description: "Развёртывание сервисов .NET 9 и .NET 10 на Linux-VM с помощью Podman и systemd. Стабильные перезапуски, настоящие логи через journald и контейнеризированное приложение, управляемое как полноценный сервис -- без Kubernetes."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "ru"
translationOf: "2026/01/deploy-a-net-app-with-podman-systemd-stable-restarts-real-logs-no-magic"
translatedBy: "claude"
translationDate: 2026-04-30
---
Сегодня всплыло в r/dotnet: люди по-прежнему ищут историю про "скучный деплой" для .NET-сервисов, который не Kubernetes и не хрупкий скрипт `nohup`. Если вы на Linux-VM, Podman вместе с systemd -- это надёжная середина: контейнеризированное приложение, управляемое как настоящий сервис.

Исходное обсуждение: [https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/](https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/)

## Почему это хорошо подходит для сервисов .NET 9 и .NET 10

-   **Перезапусками владеет systemd**: если процесс падает, он перезапускается, и вы получаете внятную причину.
-   **Журналами владеет journald**: больше не нужно гоняться за ротированными файлами на диске.
-   **Podman без демона**: systemd запускает ровно то, что нужно.

## Соберите и запустите контейнер

Вот минимальный `Containerfile` для приложения на .NET 9 (для .NET 10 работает так же, нужно только сменить базовый тег):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM base
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

Затем:

```bash
podman build -t myapp:1 .
podman run -d --name myapp -p 8080:8080 myapp:1
```

## Отдайте всё systemd (полезная часть)

Podman может сгенерировать unit-файл, понятный systemd. Замечание: `podman generate systemd` объявлен устаревшим в Podman 4.4+ в пользу [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), но генерируемый вывод по-прежнему работает и наглядно показывает идею:

```bash
podman generate systemd --new --name myapp --files
```

Получается что-то вроде `container-myapp.service`. Переложите на место:

```bash
sudo mv container-myapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-myapp.service
```

Теперь у вас аккуратные команды эксплуатации:

```bash
sudo systemctl status container-myapp.service
sudo journalctl -u container-myapp.service -f
sudo systemctl restart container-myapp.service
```

## Две детали, которые спасают потом

### Сделайте конфигурацию явной

Используйте переменные окружения и подмонтированный каталог конфигурации вместо запекания секретов в образ. С systemd вы можете задать переопределения в drop-in файле и спокойно перезапускаться.

### Подберите политику перезапуска под реальность

Если приложение падает быстро из-за отсутствующей конфигурации, бесконечные перезапуски -- это шум. Возьмите политику перезапуска, которая не молотит машину. systemd позволяет управлять задержками и пределами всплесков.

Если хочется одного теста "правильно ли я всё делаю?": перезагрузите VM и посмотрите, поднимется ли ваш .NET-сервис без вашего входа по SSH. Это и есть планка.

Дополнительно: [https://docs.podman.io/](https://docs.podman.io/)
