---
title: "API-ключи NuGet ограничат 30 днями с 17 августа, а все старые ключи истекут 1 ноября"
description: "NuGet.org убирает опцию 365-дневного API-ключа 2026-08-17, ограничивает новые ключи 30 днями и 1 ноября аннулирует все ключи, созданные до этой даты. Что сломается и как перевести workflow публикации на trusted publishing через OIDC."
pubDate: 2026-08-04
tags:
  - "dotnet"
  - "nuget"
  - "ci-cd"
  - "security"
  - "github-actions"
lang: "ru"
translationOf: "2026/08/nuget-api-keys-capped-at-30-days-from-august-17"
translatedBy: "claude"
translationDate: 2026-08-04
---

Команда .NET 2026-08-03 опубликовала статью [Strengthening NuGet Supply Chain Security: Reducing API Key Lifetime](https://devblogs.microsoft.com/dotnet/strengthening-nuget-supply-chain-security-reducing-api-key-lifetime/), и в ней две жёсткие даты, которые сломают пайплайны публикации, если их проигнорировать.

## Две даты

**2026-08-17**: новые API-ключи ограничиваются максимальным сроком в 30 дней. Опция на 365 дней исчезает из интерфейса создания ключей на nuget.org.

**2026-11-01**: все API-ключи, созданные до 17 августа, истекают. Не только годовые. Если ваш секрет `NUGET_API_KEY` был выпущен в июне, он перестанет работать 1 ноября независимо от даты истечения, показанной рядом с ним.

Именно вторая дата и бьёт больнее всего. Workflow релиза, запускаемый по тегу и не выполнявшийся с октября, упадёт на первом же push после 1 ноября с ошибкой 401, а сам сбой всплывёт в job, за которым никто не следит, пока не понадобится реально выпустить пакет.

## Почему 30-дневный ключ всё ещё неправильной формы

30-дневный ключ лучше 365-дневного, но это по-прежнему долгоживущий секрет в хранилище секретов репозитория, и теперь его придётся ротировать двенадцать раз в год вместо одного. Автоматизация ротации требует реальной работы: выпустить ключ на nuget.org с нужной областью действия для пакета, положить его в GitHub или Azure DevOps, убедиться, что старый отозван.

Альтернатива, к которой Microsoft подталкивает всех, это [trusted publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing), использующий OIDC. Ваша система CI выпускает подписанный токен с коротким сроком жизни, nuget.org проверяет его по зарегистрированной вами политике и возвращает временный API-ключ, действительный **один час**. Один токен даёт ровно один ключ. Ничего долговременного нигде не хранится.

Форма для GitHub Actions компактная:

```yaml
publish:
  environment: release
  permissions:
    id-token: write   # required for GitHub to mint the OIDC token
    contents: read
  steps:
    - name: NuGet login (OIDC to temp API key)
      uses: NuGet/login@v1
      id: login
      with:
        user: ${{ secrets.NUGET_USER }}   # nuget.org profile name, not your email
    - name: Push
      run: >
        dotnet nuget push artifacts/*.nupkg
        --api-key ${{ steps.login.outputs.NUGET_API_KEY }}
        --source https://api.nuget.org/v3/index.json
        --skip-duplicate
```

Разовая настройка сводится к одной политике на nuget.org в разделе Account, Trusted Publishing: владелец репозитория, репозиторий, имя файла workflow (`release.yml`, без префикса `.github/workflows/`) и, опционально, имя окружения. GitLab тоже поддерживается: claim из `id_tokens` обменивается через `POST https://www.nuget.org/api/v2/token`.

Один нюанс, который стоит знать до ноября: политика, созданная для приватного репозитория GitHub, стартует как **временно активная на 7 дней**. Если за это окно не произойдёт ни одной публикации, она станет неактивной, потому что nuget.org нужны ID репозитория и владельца из реального обмена токена, чтобы закрепить политику против атак воскрешения. Зарегистрируйте политику и сделайте пробный push, а не регистрируйте и уходите.

Если у вас уже настроен релиз нескольких пакетов, вся обвязка разобрана в статье [Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/). Иначе минимум на эту неделю таков: проверить, какие из ваших пайплайнов до сих пор публикуют со статическим ключом, и убедиться, что учётная запись nuget.org, получающая уведомления об истечении, действительно кем-то читается.
