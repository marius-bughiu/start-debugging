---
title: "Исправление: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate в Docker-образе Dart 3.13"
description: "Dart 3.13 убрал из VM встроенные резервные корневые сертификаты. Добавьте CA-бандл в образ времени выполнения: COPY /runtime/ из dart:stable или установите ca-certificates."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "docker"
  - "tls"
  - "dart-3-13"
lang: "ru"
translationOf: "2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image"
translatedBy: "claude"
translationDate: 2026-09-30
---

Ваш Dockerfile не менялся. Изменился Dart. Начиная с Dart 3.13.0 (SDK во Flutter 3.47.0 и тот, что стоит за тегом `dart:stable` с августа 2026 года, сейчас это 3.13.5), автономная VM больше не поставляется со вшитым набором резервных корневых сертификатов. Если в образе, в котором работает ваше приложение, нет CA-бандла по одному из стандартных путей Linux, каждый HTTPS-вызов теперь завершается ошибкой рукопожатия. Исправление: дайте финальному этапу хранилище доверенных сертификатов. Оставьте `COPY --from=build /runtime/ /` на этапе `FROM scratch` или выполните `apt-get install ca-certificates` в облегчённом базовом образе. Если изменить образ нельзя, укажите VM файл PEM через `DART_VM_OPTIONS=--root-certs-file=/path/to/cacert.pem`.

Всё ниже основано на исходном коде Dart SDK по тегам `3.12.2`, `3.13.0` и `3.13.5`, на Dockerfile `stable/trixie` в `dart-lang/dart-docker` и на обсуждении [dart-lang/sdk#64060](https://github.com/dart-lang/sdk/issues/64060), где команда Dart подтвердила, что такое поведение намеренное.

## Ошибка в контексте

Приложение собирается и запускается без проблем. Первое же исходящее TLS-соединение, идёт ли оно через `HttpClient`, `package:http`, `dio`, канал gRPC или драйвер базы данных, выбрасывает исключение:

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:320))

#0      _SecureFilterImpl._handshake (dart:io-patch/secure_socket_patch.dart:101)
#1      _SecureFilterImpl.handshake (dart:io-patch/secure_socket_patch.dart:146)
#2      _RawSecureSocket._secureHandshake (dart:io/secure_socket.dart:995)
#3      _RawSecureSocket._tryFilter (dart:io/secure_socket.dart:1127)
<asynchronous suspension>
```

Главный признак здесь момент появления. Тот же код, тот же Dockerfile и та же конечная точка работали на `dart:3.12.2`. Если вернуть этап сборки на `dart:3.12.2`, ошибка исчезает. Именно так поступил автор #64060, прежде чем нашёл причину. Конечные точки с абсолютно валидными публичными сертификатами (pub.dev, googleapis.com, ваш собственный API на Let's Encrypt) падают так же, как и с самоподписанными, потому что проблема не в цепочке сервера. Клиент просто не доверяет вообще ничему.

## Почему Dart 3.13 перестал доверять чему-либо в пустом образе

В Linux функция `SSLCertContext::TrustBuiltinRoots()` в `runtime/bin/security_context_linux.cc` ищет доверенные корневые сертификаты в фиксированном порядке:

1. Параметр `--root-certs-file` или `--root-certs-cache`, если вы его передали.
2. Первый существующий файл-бандл из `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/pki/tls/cacert.pem` и `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`.
3. Первый существующий каталог из `/etc/ssl/certs`, `/system/etc/security/cacerts`, `/usr/local/share/certs`, `/etc/pki/tls/certs` и `/etc/openssl/certs`.
4. В крайнем случае `AddCompiledInCerts()`, которая загружает корневой бандл Mozilla, вшитый в бинарные файлы `dart` и `dartaotruntime` (а значит, и в каждый результат `dart compile exe`).

Изменился именно шаг 4. В журнале изменений Dart 3.13.0 это сказано одной строкой в разделе "Dart Runtime": встроенные резервные корневые сертификаты "are no longer included". Коммит в SDK: [`7e5b075680`](https://github.com/dart-lang/sdk/commit/7e5b075680), "Reland [standalone] Remove the fallback root certificates", попал в код 2026-06-01 после первой попытки в мае, которую откатили. Функция в 3.13 всё ещё существует, но `runtime/bin/BUILD.gn` больше не подключает `third_party/fallback_root_certificates` и безусловно определяет `DART_IO_ROOT_CERTS_DISABLED`, поэтому `root_certificates_pem` равен null, и функция завершается, ничего не добавив.

Годами этот резерв молча выручал образы времени выполнения без CA-бандла. Этап `FROM scratch`, в который копировался только скомпилированный бинарный файл, работал, потому что бинарный файл нёс свои корневые сертификаты. База `debian:trixie-slim` без `ca-certificates` работала по той же причине. В 3.13 такие образы получают пустой `X509_STORE`, и BoringSSL сообщает, что у первого сертификата в любой цепочке неизвестный издатель.

Две детали делают ситуацию запутаннее, чем нужно:

- **Сам образ `dart:stable` в порядке.** Его Dockerfile устанавливает `ca-certificates`, а каталог `/runtime/`, который он готовит для многоэтапных сборок, включает `/etc/ssl/certs` и `/usr/share/ca-certificates`, скопированные с `--dereference`, чтобы символические ссылки сохранились. Если вы видите ошибку, то падающий процесс почти всегда работает в *другом* образе, не в том, в котором вы собирали. В #64060 сборка шла на `dart:3.13.0`, а под работал на пятилетнем образе `docker:19.03.15` / `ubuntu:xenial`.
- **Пустой каталог `/etc/ssl/certs` хуже отсутствующего.** Шаг 3 проверяет только существование каталога, а не наличие в нём чего-либо. Некоторые базовые образы поставляют каталог без сертификатов, и VM "загружает" из него ноль корневых сертификатов и остаётся довольна.

## Минимальный пример воспроизведения

Программа на Dart, выполняющая один HTTPS-запрос:

```dart
// Dart 3.13.5, bin/server.dart
import 'dart:io';

Future<void> main() async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('https://pub.dev/api/packages/http'));
    final response = await request.close();
    print('status: ${response.statusCode}');
    await response.drain<void>();
  } finally {
    client.close();
  }
}
```

И многоэтапный Dockerfile, который копирует в финальный этап только исполняемый файл. Такая схема часто встречается в самописных Dockerfile и в шаблонах CI, появившихся раньше официального:

```dockerfile
# Dart 3.13.5 (dart:stable, September 2026)
FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o bin/server

FROM debian:trixie-slim
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

При сборке на `dart:3.12.2` программа выводит `status: 200` благодаря вшитым корневым сертификатам. При сборке на `dart:3.13.0` или новее она выбрасывает `HandshakeException`, показанный выше, потому что в `debian:trixie-slim` нет пакета `ca-certificates`.

## Исправление подробно

Выберите первый подходящий для вашего образа вариант. Все они дают VM настоящее хранилище доверенных сертификатов, и ни один не отключает проверку.

### 1. Оставьте официальное копирование `/runtime/` на этапе `FROM scratch`

Эту схему рекомендует [документация официального образа `dart`](https://hub.docker.com/_/dart), и сертификаты в ней уже есть:

```dockerfile
# Dart 3.13.5 (dart:stable)
FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o bin/server

FROM scratch
COPY --from=build /runtime/ /
COPY --from=build /app/bin/server /app/bin/
CMD ["/app/bin/server"]
```

Если ваш финальный этап это `FROM scratch`, а единственный `COPY` копирует бинарный файл, добавьте строку с `/runtime/`. Помимо сертификатов она приносит загрузчик glibc, `libnss_dns` и `/etc/nsswitch.conf`, так что заодно исправит проблемы с разрешением DNS, с которыми вы, возможно, ещё не сталкивались.

### 2. Установите `ca-certificates` в облегчённый образ времени выполнения

Если вы работаете на `debian:*-slim` или `ubuntu:*`, установите пакет в финальном этапе:

```dockerfile
# Dart 3.13.5 AOT binary on debian:trixie-slim
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

Скрипт пакета после установки создаёт `/etc/ssl/certs/ca-certificates.crt`, и это первый путь, который проверяет VM. Отдельный вызов `update-ca-certificates` не нужен, если только вы не добавляете собственные сертификаты (см. ниже). В образах RHEL, UBI или Fedora эквивалентный пакет тоже называется `ca-certificates`, и он создаёт `/etc/pki/tls/certs/ca-bundle.crt`, который также есть в списке.

Distroless тоже подходит: `gcr.io/distroless/cc-debian12` содержит `/etc/ssl/certs/ca-certificates.crt` и glibc, нужную AOT-бинарному файлу Dart.

### 3. Обновите старый базовый образ

Если в образе времени выполнения есть `ca-certificates`, но он многолетней давности, бандл старше корневых сертификатов, к которым привязываются новые центры сертификации. Именно такая ситуация была в #64060. Исправление: перейти на актуальный базовый образ. Обновление пакета на месте (`apt-get update && apt-get install --only-upgrade ca-certificates`) работает лишь пока дистрибутив продолжает публиковать обновления.

### 4. Укажите VM бандл через `DART_VM_OPTIONS`

Когда трогать образ нельзя, но можно смонтировать файл или задать переменную окружения (спецификация пода Kubernetes, управляемая среда выполнения), используйте `--root-certs-file`. Для JIT (`dart run`, `dart bin/server.dart`) это обычная опция VM:

```bash
dart --root-certs-file=/certs/cacert.pem bin/server.dart
```

Бинарный файл `dart compile exe` игнорирует собственную командную строку для опций VM, поскольку все аргументы передаются в ваш `main`. Зато он читает `DART_VM_OPTIONS`, список через запятую, который разбирается в `main_impl.cc` только для исполняемых файлов с присоединённым снимком, и `--root-certs-file` входит в число принимаемых им опций:

```dockerfile
# Dart 3.13.5 AOT binary, CA bundle supplied explicitly
FROM debian:trixie-slim
COPY cacert.pem /certs/cacert.pem
COPY --from=build /app/bin/server /app/bin/server
ENV DART_VM_OPTIONS=--root-certs-file=/certs/cacert.pem
CMD ["/app/bin/server"]
```

`--root-certs-cache=<dir>` делает то же для каталога с хешированными файлами сертификатов в стиле `c_rehash`. Любая из этих опций полностью заменяет системный поиск: шаги 2 и 3 пропускаются, поэтому переданный вами файл и есть всё хранилище доверия. Используйте поддерживаемый бандл, например построенный на данных Mozilla [`cacert.pem`, публикуемый curl](https://curl.se/docs/caextract.html), и поддерживайте его в актуальном состоянии.

### 5. Загрузите бандл из кода

Если вы хотите сделать программу самодостаточной, добавьте корневые сертификаты в контекст по умолчанию при запуске. `SecurityContext.defaultContext` используют `HttpClient`, `IOClient` из `package:http` и большинство других клиентов, когда вы не передаёте контекст:

```dart
// Dart 3.13.5
import 'dart:io';

void main() {
  const bundle = '/certs/cacert.pem';
  if (File(bundle).existsSync()) {
    SecurityContext.defaultContext.setTrustedCertificates(bundle);
  }
  // ... start the server, create clients afterwards
}
```

Для полностью изолированной настройки создайте контекст, который доверяет только вашему бандлу, и передайте его клиенту:

```dart
// Dart 3.13.5, package:http 1.x
import 'dart:io';
import 'package:http/io_client.dart';

IOClient buildClient(List<int> pemBytes) {
  final context = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(pemBytes);
  return IOClient(HttpClient(context: context));
}
```

Это правильный инструмент для закрепления частного центра сертификации для одного сервиса. Как общее решение для публичных конечных точек он лишь воссоздаёт утраченный резервный бандл, только теперь за его обновление отвечаете вы, поэтому предпочитайте варианты 1 или 2.

## Как убедиться, что в образе нет хранилища доверия

В образах `FROM scratch` и distroless нет оболочки, поэтому `docker run ... ls` не сработает. Вместо этого скопируйте путь из остановленного контейнера:

```bash
docker create --name probe my-dart-app:latest
docker cp probe:/etc/ssl/certs/ca-certificates.crt - | tar -tv
docker rm probe
```

Если `docker cp` сообщает `Could not find the file`, проверьте остальные четыре пути бандлов из списка выше. Если ни одного нет, а `/etc/ssl/certs` отсутствует или пуст, причина найдена. Для образов с оболочкой достаточно `ls -la /etc/ssl/certs | head`.

## Подводные камни и похожие случаи

- **`SSL_CERT_FILE` и `SSL_CERT_DIR` ничего не делают.** Эти переменные окружения относятся к соглашениям OpenSSL. VM Dart использует BoringSSL и собственный жёстко заданный список путей, поэтому их экспорт не даёт эффекта. Используйте вместо них `DART_VM_OPTIONS=--root-certs-file=...`.
- **Корпоративная TLS-инспекция это другая проблема.** Если прокси переподписывает трафик внутренним центром сертификации, вы получаете то же сообщение на любой версии Dart, потому что резервный бандл Mozilla никогда не содержал этот центр. Добавьте его в системное хранилище (`COPY corp-root.crt /usr/local/share/ca-certificates/`, затем `update-ca-certificates`) или загрузите через `setTrustedCertificates`.
- **Самоподписанные и неполные цепочки дают то же сообщение.** Если падает только один хост, а `https://pub.dev` работает, вероятно, сервер не отправляет промежуточный сертификат. Исправьте сервер. Не добавляйте `badCertificateCallback: (_, _, _) => true`, потому что это отключает проверку для всего, с чем общается клиент.
- **`dart pub get` тоже падает** в собственном образе, который устанавливает zip-архив SDK на базу без `ca-certificates`. Тогда пакет нужен этапу сборки, и исправление то же.
- **Alpine не выход.** Результат `dart compile exe` линкуется с glibc, поэтому образ на musl падает ещё до TLS. Оставайтесь на базе с glibc.
- **Мобильные приложения Flutter не затронуты.** Android напрямую загружает `/system/etc/security/cacerts` и никогда не использовал резерв, а iOS оценивает доверие через фреймворк Security. Изменение касается автономной VM в Linux: серверов, CLI и бэкендов, скомпилированных с помощью `dart compile exe`.

## Связанные материалы

- Если тот же контейнеризованный CI ещё и печатает предупреждения pub, [ошибка декодирования advisories с pub.dev](/ru/2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev/) это отдельное, безвредное сообщение.
- Для бэкенда на Dart, который работает не в долгоживущем контейнере, [экспериментальная поддержка Dart в Firebase Cloud Functions](/ru/2026/05/dart-cloud-functions-firebase-experimental/) тоже в итоге превращается в скомпилированный бинарный файл Dart внутри контейнера Linux, поэтому проверьте её базовый образ так же.
- Компромиссы крошечного этапа времени выполнения очень похожи и на стороне .NET, см. [framework-dependent, self-contained и Native AOT для образа контейнера .NET 11](/ru/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).
- Если падает вызов gRPC, [ловушки gRPC в контейнерах](/ru/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) описывают проблемы TLS и HTTP/2, которые со стороны клиента выглядят похоже.

## Источники

- [dart-lang/sdk#64060: CERTIFICATE_VERIFY_FAILED on dart:3.13.0 (dart:stable) image](https://github.com/dart-lang/sdk/issues/64060)
- [Dart SDK CHANGELOG, 3.13.0 "Dart Runtime" section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Commit 7e5b075680: Reland "[standalone] Remove the fallback root certificates."](https://github.com/dart-lang/sdk/commit/7e5b075680)
- [`runtime/bin/security_context_linux.cc` at 3.13.5](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/security_context_linux.cc)
- [`runtime/bin/main_impl.cc` and `main_options.cc` at 3.13.5 (`DART_VM_OPTIONS` handling)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/main_options.cc)
- [dart-lang/dart-docker `stable/trixie/Dockerfile`](https://github.com/dart-lang/dart-docker/blob/main/stable/trixie/Dockerfile)
- [`SecurityContext` API reference](https://api.dart.dev/dart-io/SecurityContext-class.html)
