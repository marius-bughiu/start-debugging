---
title: "Исправление: WebSocket горячей перезагрузки Blazor в dotnet watch не работает на собственном локальном домене (403)"
description: "Начиная с сентябрьских SDK .NET 2026 года (10.0.112, 10.0.401, 11 RC1) dotnet watch отклоняет WebSocket-подключения browser-refresh с неизвестных источников. Задайте DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS равным имени вашего хоста."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-10"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain"
translatedBy: "claude"
translationDate: 2026-09-29
---

Задайте `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` равным имени вашего хоста (только хост, например `myapp.localhost`, без схемы и без порта) в оболочке, из которой запускается `dotnet watch`, и перезапустите его. SDK от 8 сентября 2026 года (10.0.112, 10.0.401, 9.0.121, 9.0.318, 8.0.131, 8.0.425 и 11.0.100-rc.1) исправили CVE-2026-58649. С тех пор WebSocket browser-refresh принимает только `Origin` со значением `localhost`, `127.0.0.1`, `[::1]` или хост, указанный в этой переменной. Всё остальное получает 403. Всё описанное ниже я измерял на macOS с SDK 10.0.302 (до исправления) и 10.0.401 (после) на стандартном шаблоне `dotnet new blazor`.

## Ошибка в контексте

Вы открываете приложение по имени вроде `http://myapp.localhost:5080`, `https://shop.test` или по алиасу из файла hosts, а не по обычному `localhost`. Страница отображается, собственный канал (circuit) Blazor подключается, но в консоли браузера появляется следующее:

```
Failed to load resource: the server responded with a status of 403 (Forbidden)
WebSocket connection to 'ws://localhost:5599/' failed:
WebSocket failed to connect.
WebSocket connection to 'wss://localhost:63038/' failed:
WebSocket failed to connect.
Unable to establish a connection to the browser refresh server.
```

Последние три строки являются выводом `console.debug` из `aspnetcore-browser-refresh.js`, поэтому вы увидите их только при включённом уровне "Verbose" в DevTools Chrome или Edge. Номера портов случайны, если вы их не зафиксировали. При этом терминал `dotnet watch` выглядит абсолютно здоровым:

```
dotnet watch ⌚ Files updated: ./Components/Pages/Home.razor
dotnet watch 🔥 C# and Razor changes applied in 109ms.
```

Терминал говорит, что изменение применено, а браузер с этим не согласен. Именно это расхождение и делает проблему такой запутанной. Многие, кто с ней столкнулся, при этом ничего не меняли в проекте: SDK обновился сам через Visual Studio, Homebrew или `global.json` с `rollForward: latestPatch`. Именно это описано в [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291): горячая перезагрузка сломалась на `bug.dev.localhost` с SDK 10.0.401, а закрепление версии 10.0.400 вернуло работоспособность.

## Почему сокет browser-refresh теперь возвращает 403

Под `dotnet watch` в веб-приложения внедряется небольшой скрипт `_framework/aspnetcore-browser-refresh.js`. Он открывает WebSocket к серверу, размещённому внутри процесса `dotnet watch`. Сервер слушает `127.0.0.1` на случайном порту, а также порт WSS, если доступен сертификат разработчика. По этому сокету передаются перезагрузки страниц, обновления CSS, дельты Blazor WebAssembly и диагностика. Внедряемый URL всегда указывает на `localhost`, независимо от того, по какому имени хоста была загружена сама страница:

```js
// injected by dotnet watch, SDK 10.0.401
const webSocketUrls = 'ws://localhost:5599,wss://localhost:63038'.split(',');
```

Поэтому страница на `http://myapp.localhost:5080` делает кросс-доменный запрос WebSocket к `ws://localhost:5599`, и браузер отправляет с ним `Origin: http://myapp.localhost:5080`. До сентября 2026 года сервер обновления полностью игнорировал заголовок `Origin`. Любая страница, открытая в вашем браузере, на любом сайте, могла к нему подключиться, а сокет передаёт полезную нагрузку обновлений IL и PDB. Это [CVE-2026-58649](https://github.com/dotnet/sdk/issues/56166), классифицированная как CWE-346 (Origin Validation Error), CVSS 6.5.

Исправление ([dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) в `release/11.0.1xx`, перенесённое в `main` как [#56246](https://github.com/dotnet/sdk/pull/56246)) добавляет такую проверку перед принятием WebSocket:

```csharp
// src/Dotnet.Watch/HotReloadClient/Web/BrowserRefreshServer.cs (SDK fix for CVE-2026-58649)
if (!Uri.TryCreate(context.Request.Headers.Origin.FirstOrDefault(), UriKind.Absolute, out var originUri) ||
    !webSocketConfig.GetAllowedOriginDomains().Contains(originUri.Host, StringComparer.OrdinalIgnoreCase))
{
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return;
}
```

`GetAllowedOriginDomains()` возвращает `localhost`, `127.0.0.1`, `[::1]`, каждую запись из `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` и значение `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME`, если оно задано. Сравнение выполняется как точное совпадение без учёта регистра с `Uri.Host`. Подстановочных знаков, сопоставления по суффиксу и особого случая для `*.localhost` нет. Запрос вообще без заголовка `Origin` тоже отклоняется.

## Минимальное воспроизведение

```bash
# .NET SDK 10.0.401, macOS 26 (any OS behaves the same)
dotnet new blazor -o BlazorRepro
cd BlazorRepro
DOTNET_WATCH_AUTO_RELOAD_WS_PORT=5599 dotnet watch run --urls http://localhost:5080
```

Фиксация порта через `DOTNET_WATCH_AUTO_RELOAD_WS_PORT` лишь упрощает проверку сокета. Браузеры на Chromium разрешают любое имя `*.localhost` в loopback без записи в файле hosts, так что откройте `http://myapp.localhost:5080/`, и вы получите вывод консоли, показанный выше. Браузер даже не нужен. Сырое рукопожатие WebSocket через `curl` напрямую показывает принятое решение:

```bash
# .NET SDK 10.0.401, while dotnet watch is running
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://myapp.test:5000' \
  http://127.0.0.1:5599/
```

Я выполнил это рукопожатие на обоих SDK с разными значениями новой переменной:

| Заголовок `Origin` | 10.0.302 | 10.0.401 | 10.0.401 + `ORIGINS=myapp.test;bug.dev.localhost` |
|---|---|---|---|
| `http://localhost:5000` | 101 | 101 | 101 |
| `http://myapp.test:5000` | 101 | 403 | 101 |
| `https://myapp.test` | 101 | 403 | 101 |
| `http://bug.dev.localhost:5000` | 101 | 403 | 101 |
| `https://evil.example` | 101 | 403 | 403 |
| (без `Origin`) | 101 | 403 | 403 |

На 10.0.302 ответ 101 (Switching Protocols) для `https://evil.example` и есть сама уязвимость. На 10.0.401 любое пользовательское имя отклоняется, пока вы не внесёте его в список.

## Решение: разрешите имя своего хоста

`dotnet watch` читает переменную из окружения **собственного** процесса при запуске. Задайте её в оболочке, в системе запуска задач или в контейнере, который запускает `dotnet watch`, а затем перезапустите наблюдатель. Уже работающий наблюдатель её не подхватит.

```bash
# bash / zsh, .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.localhost"
dotnet watch run --urls http://localhost:5080
```

```powershell
# PowerShell, .NET SDK 10.0.401+
$env:DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS = "myapp.localhost"
dotnet watch run
```

Для нескольких имён разделяйте их символами `;` или `,`. Пробелы вокруг каждой записи отбрасываются:

```bash
# .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="shop.test;admin.shop.test,api.shop.test"
```

Если вы запускаете наблюдатель из VS Code, поместите переменную в задачу, а не в `launch.json`. Значение `env` конфигурации запуска `coreclr` передаётся приложению, а проверку выполняет не приложение:

```json
// .vscode/tasks.json, .NET SDK 10.0.401+
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "watch",
      "type": "process",
      "command": "dotnet",
      "args": ["watch", "run", "--project", "BlazorRepro/BlazorRepro.csproj"],
      "options": { "env": { "DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS": "myapp.localhost" } },
      "isBackground": true
    }
  ]
}
```

При установленной `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS=myapp.localhost` та же страница на `http://myapp.localhost:5080` подключилась, и правки доходили до браузера без ручного обновления. Изменение текста в статической SSR-странице `Home.razor` и изменение цвета в `wwwroot/app.css` оба отобразились в открытой вкладке.

## Что именно ломается и почему некоторые правки всё же работают

Симптом зависит от того, где отрисовывается компонент, из-за чего ошибка выглядит плавающей. На 10.0.401 без переменной, при странице, открытой на `myapp.localhost`:

- **Компоненты Interactive Server** (`Counter.razor` из шаблона с `@rendermode InteractiveServer`): правки Razor и C# **всё равно отображались**. Дельта применяется внутри серверного процесса, а Blazor заново отрисовывает компонент по собственному каналу SignalR (`ws://myapp.localhost:5080/_blazor`), который принадлежит тому же источнику и никогда не обращается к серверу обновления.
- **Статические SSR-страницы** (`Home.razor` из шаблона): правки Razor **не отображались**. `dotnet watch` выводил "C# and Razor changes applied", но новый HTML показало бы только обновление браузера, отправленное через сокет обновления.
- **CSS в `wwwroot`**: изменения **не отображались** ни на одной странице, хотя терминал выводил "Static asset changes applied". Обновления CSS доставляются через сокет обновления.
- **Blazor WebAssembly** (автономный или проект `.Client`): сами дельты передаются по сокету обновления, поэтому горячая перезагрузка C# и Razor для компонентов WebAssembly тоже перестаёт работать (этот случай я не измерял, но путь доставки тот же сокет).

Так что "горячая перезагрузка работает на странице счётчика, но не на главной" является той же самой ошибкой, а не двумя разными. Если вы не уверены, к какой группе относится компонент, см. [как Blazor решает, какой режим отрисовки запускает компонент](/ru/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).

## Подводные камни и похожие проблемы

**Значение является именем хоста, а не origin.** Проверка сравнивает `Uri.Host`, поэтому `http://myapp.test` и `myapp.test:5000` никогда ничему не соответствуют. В моих запусках `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.test:5000,*.localhost"` и `"http://myapp.test"` по-прежнему возвращали 403 для любого пользовательского origin. Перечисляйте каждый поддомен явно.

**`launchSettings.json` не работает.** `environmentVariables` профиля передаются процессу приложения. К тому моменту `dotnet watch` уже построил свой список разрешённых значений. Я добавил переменную в оба профиля `launchSettings.json` из шаблона и всё равно получил 403 для `myapp.test`. То же исправление также изменило способ, которым переменные профиля запуска попадают в приложение: теперь они передаются по RPC агенту горячей перезагрузки, а не аргументами `-e` ([CVE-2026-69806](https://github.com/dotnet/sdk/issues/56167), тот же PR). Но на собственные настройки наблюдателя это никак не влияет. Если нужно привязать это к репозиторию, подходят скрипт в стиле `.env` или определение задачи выше.

**`DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` это другая настройка.** Её хост тоже добавляется в список разрешённых (при `HOSTNAME=myapp.test` origin `myapp.test` в моём тесте возвращали 101), но она делает больше. Она меняет хост, к которому привязывается сервер обновления, и URL, к которому подключается внедряемый скрипт. Kestrel трактует имя хоста, не являющееся IP-адресом, как "слушать на всех интерфейсах", поэтому сокет становится доступен из вашей сети. Используйте `HOSTNAME` только тогда, когда браузер действительно не может достучаться до `localhost`, например когда `dotnet watch` работает внутри контейнера или на удалённой машине разработки. Когда отличается только имя страницы, используйте `ORIGINS`.

**Закрепление старого SDK "исправляет" проблему, возвращая уязвимость.** `global.json`, закрепляющий 10.0.400 или 10.0.302, убирает 403, потому что эти SDK принимают любой origin, включая `https://evil.example`. Считайте это диагностическим шагом, а не решением.

**Таблица бюллетеня и примечания к выпуску расходятся в номерах версий.** Бюллетень указывает 10.0.111 и 10.0.400 как "исправленные". [Метаданные выпуска](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json) относят CVE-2026-58649 к выпуску от 8 сентября (среда выполнения 10.0.12, SDK 10.0.112 и 10.0.401). Измерения и автор отчёта согласны с метаданными выпуска: 10.0.400 принимает любой origin, а 10.0.401 применяет проверку. Публичные теги `v10.0.400` и `v10.0.401` указывают на один и тот же коммит, потому что исправления безопасности собираются из внутреннего репозитория, так что сравнивать теги не стоит.

**403 на самой странице означает другое.** Если весь документ возвращает 403, проверьте, что на самом деле слушает этот порт. В macOS порт 5000 принадлежит AirPlay Receiver в Пункте управления, который отвечает 403 на любой путь. Браузеры могут разрешать `*.localhost` в `::1` раньше, чем в `127.0.0.1`, поэтому Kestrel, привязанный только к `127.0.0.1:5000`, проигрывает это соединение AirPlay. Именно с этим я столкнулся при создании воспроизведения, поэтому команды выше используют `--urls http://localhost:5080`.

**Нет пользовательского домена, а обновления всё равно нет?** Если вы открываете `localhost`, а сокет всё равно не работает, причина в другом: HTTPS-страница пытается использовать `wss://` без доверенного сертификата разработчика, в окружении остался `DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1` или промежуточное ПО переписывает ответ так, что скрипт не внедряется. [Что dotnet watch добавляет к dotnet run](/ru/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) разбирает внедрение и переменные окружения, которые он задаёт.

**Со временем это исчезнет.** В ветке `main` SDK [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118) (влит 2026-09-21) направляет WebSocket инструментов браузера через собственный origin приложения и пересылает его провайдеру, доступному только по loopback. В такой схеме страница и сокет делят один origin, а комментарий в коде гласит, что `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` "no longer applies to this hop". На момент написания это изменение не вошло ни в один SDK, поэтому на 10.0.401 и 11 RC1 переменная по-прежнему нужна.

## Связанные материалы

Это уже второй случай, когда обновление SDK незаметно ломает приложение Blazor без единого изменения в проекте. Первым была [ошибка 404 для blazor.server.js после установки SDK .NET 10](/ru/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/). О том, что `dotnet watch` получил в последнее время помимо сокета браузера, см. [dotnet watch в .NET 11 Preview 3 с хостами Aspire и восстановлением после сбоев](/ru/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/). Если вы используете Visual Studio вместо CLI, [автоперезапуск Hot Reload в Visual Studio 2026](/ru/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) описывает, как IDE обрабатывает правки, которые не может применить. Собственное подключение Visual Studio к браузеру я для этой статьи не проверял.

## Источники

- [Бюллетень CVE-2026-58649, dotnet/sdk#56166](https://github.com/dotnet/sdk/issues/56166) и [анонс, dotnet/announcements#441](https://github.com/dotnet/announcements/issues/441).
- [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198), исправление, в котором `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` описана как запасной вариант для пользовательских доменов, и его порт в `main` [#56246](https://github.com/dotnet/sdk/pull/56246).
- [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291), отчёт о регрессии на `*.dev.localhost` с SDK 10.0.401 и обходной путь от мейнтейнера.
- [`EnvironmentVariables.cs` в dotnet/sdk](https://github.com/dotnet/sdk/blob/main/src/Dotnet.Watch/Watch/Context/EnvironmentVariables.cs) для имён переменных, разделителей и значений по умолчанию.
- [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118), переработка инструментов браузера на единый origin в `main`.
- [Метаданные выпуска .NET 10](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), чтобы узнать, какие сборки SDK содержат исправление.
