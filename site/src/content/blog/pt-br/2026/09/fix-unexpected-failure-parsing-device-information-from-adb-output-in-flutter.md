---
title: "Correção: Unexpected failure parsing device information from adb output no Flutter"
description: "O Flutter 3.47.0 não consegue interpretar linhas do adb cujo serial tem 22 ou mais caracteres, então dispositivos Android sem fio e alguns USB somem. Atualize para o 3.47.1 ou posterior, ou use adb connect por IP."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "adb"
  - "flutter-tools"
lang: "pt-br"
translationOf: "2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-16
---

Isto é um bug de parser no Flutter 3.47.0, e você não precisa reportá-lo de novo. O `adb devices -l` preenche a coluna do serial até 22 caracteres e depois adiciona um espaço, então qualquer serial com 22 caracteres ou mais (todo nome de depuração sem fio `adb-...._adb-tls-connect._tcp`, além de alguns seriais USB) é seguido por um único espaço. O parser do 3.47.0 exige dois espaços ou um tab nessa posição, rejeita a linha e deixa o dispositivo de fora. Execute `flutter upgrade` para obter o 3.47.1 ou posterior (o 3.47.4 é o stable atual). Se você precisa ficar no 3.47.0, conecte os dispositivos sem fio com `adb connect <ip>:<port>`, já que o serial curto baseado no IP ainda é interpretado corretamente.

Reproduzi tudo o que vem a seguir no macOS com Flutter 3.44.8, 3.47.0 e 3.47.4 (Dart 3.13.0 e 3.13.3). Apontei cada versão para um Android SDK descartável cujo `platform-tools/adb` é um script falso e forneci a todas as mesmas nove linhas de dispositivo.

## O erro em contexto

O `flutter devices` lista os alvos desktop e web, mas não o celular que o `adb devices` claramente enxerga:

```text
Found 2 connected devices:
  macOS (desktop) • macos  • darwin-arm64   • macOS 26.6.1 25G76 darwin-arm64
  Chrome (web)    • chrome • web-javascript • Google Chrome 151.0.7922.140

No wireless devices were found.

Unexpected failure parsing device information from adb output:
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:1
Please report a bug at https://github.com/flutter/flutter/issues.
```

No `flutter doctor` é fácil deixar passar, porque a seção "Connected device" continua recebendo o check verde e o aviso fica logo abaixo dela:

```text
[✓] Connected device (2 available)
    ! Unexpected failure parsing device information from adb output:
      9b01005930533036340043eb2a5c2c device usb:17907712X product:serenity_p_in model:25028PC03I device:serenity transport_id:1
      Please report a bug at https://github.com/flutter/flutter/issues.
```

Esse segundo é um celular USB, não sem fio, e é por isso que o conselho "só acontece com depuração sem fio" que você encontra em algumas threads está incompleto. O Android Studio e o VS Code obtêm a lista de dispositivos do mesmo código de descoberta, então o dispositivo também some do seletor da IDE, e o `flutter run -d <serial>` não tem com o que fazer correspondência.

Os relatos são [flutter/flutter#191167](https://github.com/flutter/flutter/issues/191167) (USB, Flutter 3.47.0 no macOS), [#191119](https://github.com/flutter/flutter/issues/191119) (pareamento por Wi-Fi no Fedora), [#191343](https://github.com/flutter/flutter/issues/191343) (Ubuntu) e os upstream [#189430](https://github.com/flutter/flutter/issues/189430) e [#189972](https://github.com/flutter/flutter/issues/189972).

## Por que o Flutter 3.47.0 rejeita uma linha válida do adb

O adb monta cada linha da listagem longa em `append_transport`, no `transport.cpp`:

```cpp
// adb (platform/packages/modules/adb), transport.cpp
android::base::StringAppendF(result, "%-22s %s", serial.c_str(),
                             to_string(t->GetConnectionState()).c_str());
```

`%-22s` é uma largura mínima, não uma coluna. Um serial de 10 caracteres como `ZN52278M76` recebe 12 espaços de preenchimento mais o espaço literal, ou seja, 13 espaços no total. Um serial de 21 caracteres recebe dois. Um serial de 22 caracteres ou mais recebe exatamente um. Os seriais de depuração sem fio são o nome do serviço mDNS, e só o sufixo `._adb-tls-connect._tcp` já tem 22 caracteres. Muitos seriais USB também passam disso: o serial de 30 caracteres da #191167 é um exemplo.

O Flutter 3.44.x interpretava as linhas com `^(\S+)\s+(\S+)(.*)`: primeiro token, qualquer espaço em branco, segundo token. Isso lida bem com um único espaço, mas quebra quando o próprio serial contém um espaço. Quando você liga e desliga a depuração sem fio rapidamente, o mDNS acrescenta um sufixo de conflito e o serial vira `adb-26151FDF60083B-9tP4nl (2)._adb-tls-connect._tcp`. O Flutter 3.44.8 então corta o serial no primeiro espaço. Meu adb falso registrou a chamada recebida como `adb -s adb-26151FDF60083B-9tP4nl shell getprop`, e um servidor adb de verdade não conhece esse serial truncado.

Corrigir isso levou três tentativas durante o ciclo do 3.47:

1. [#187943](https://github.com/flutter/flutter/pull/187943) passou a usar uma correspondência preguiçosa do serial, `^(.*?)\s+(no permissions|\S+)...`, que saiu no 3.47.0-0.1.pre. Ela quebrou linhas que trazem um devpath sem o prefixo `key:`.
2. [#189369](https://github.com/flutter/flutter/pull/189369) corrigiu isso listando explicitamente os estados conhecidos do adb e exigindo `(?:\s{2,}|\t+)` antes do estado. Foi feito cherry-pick para o beta e saiu no 3.47.0. Essa regra dos dois espaços é o bug de que trata este post.
3. [#189973](https://github.com/flutter/flutter/pull/189973) passou a usar uma captura gulosa do serial ancorada nas palavras de estado conhecidas e depois remove o preenchimento. Foi feito cherry-pick para o stable como [#191296](https://github.com/flutter/flutter/pull/191296), e saiu no 3.47.1 em 19 de agosto de 2026.

Esta é a regex do 3.47.0, de `packages/flutter_tools/lib/src/android/android_device_discovery.dart`:

```dart
// Flutter 3.47.0, android_device_discovery.dart
static final _kDeviceRegex = RegExp(
  r'^(.*?)(?:\s{2,}|\t+)'
  r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)'
  r'(?:\s+(.*)|$)',
);
```

A única mudança no 3.47.1 é a primeira linha, que virou `r'^(.*)\s+'`, mais um `trimRight()` no serial capturado. O arquivo é idêntico do 3.47.1 ao 3.47.4 e no beta 3.48.0-0.5.pre.

## Reprodução mínima com um adb falso

Você não precisa de um celular para ver isso. O Flutter encontra o `adb` em `$ANDROID_HOME/platform-tools/adb`, então um shell script nesse caminho pode imprimir as linhas que você quiser. Ele usa o mesmo formato `%-22s %s` que o adb usa:

```bash
#!/bin/bash
# Fake adb for Flutter 3.44.8 / 3.47.0 / 3.47.4 repros: $SDK/platform-tools/adb
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  printf '%-22s %s\n' "adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" \
    "device product:oriole model:Pixel_6 device:oriole transport_id:2"
  echo
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf '[ro.build.characteristics]: [phone]\n[ro.build.version.release]: [16]\n'
  printf '[ro.build.version.sdk]: [36]\n[ro.product.cpu.abi]: [arm64-v8a]\n'
  exit 0
fi
exit 0
```

```bash
# Flutter 3.47.0 vs 3.47.4, same fake SDK
chmod +x sdk/platform-tools/adb
ANDROID_HOME=$PWD/sdk XDG_CONFIG_HOME=$PWD/xdg flutter devices
```

O `XDG_CONFIG_HOME` impede que um caminho que você tenha salvo algum dia com `flutter config --android-sdk` sobrescreva o `ANDROID_HOME`. Passei nove linhas por cada versão. A tabela mostra o que o `flutter devices` imprimiu:

| Linha do adb | 3.44.8 | 3.47.0 | 3.47.4 |
|---|---|---|---|
| USB, serial de 10 caracteres `ZN52278M76` | listado | listado | listado |
| USB, serial de 21 caracteres | listado | listado | listado |
| USB, serial de 22 caracteres | listado | falha de parsing | listado |
| USB, serial de 30 caracteres | listado | falha de parsing | listado |
| Sem fio mDNS `adb-...._adb-tls-connect._tcp` | listado | falha de parsing | listado |
| Sem fio mDNS com sufixo `(2)` | listado com serial truncado | falha de parsing | listado |
| Sem fio `192.168.1.3:36809` | listado | listado | listado |
| Sem fio mDNS, `unauthorized` | dica "is not authorized" | falha de parsing | dica "is not authorized" |
| USB, `detached` | listado como dispositivo | falha de parsing | falha de parsing |

A fronteira entre 21 e 22 caracteres é toda a história. A última linha é um problema separado, tratado nas pegadinhas abaixo.

## Correção 1: atualize o Flutter para o 3.47.1 ou posterior

Primeiro confira em qual versão você está:

```bash
# Flutter 3.47.x
flutter --version
```

Se a primeira linha disser `Flutter 3.47.0`, atualize no canal stable:

```bash
# moves 3.47.0 to the latest 3.47.x hotfix (3.47.4 as of 2026-09-16)
flutter upgrade
flutter devices
```

A correção está na [entrada do CHANGELOG do 3.47.1](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md) como "Fix ADB device list parsing for long wireless mDNS serials separated from state by a single space". O texto menciona seriais sem fio, mas a correção também cobre seriais USB longos, como mostra a tabela. Se você fixa versões com FVM ou com uma matriz de CI, suba a versão fixada para `3.47.4` em vez de executar `flutter upgrade`. Cada perna fixada mantém o próprio snapshot da ferramenta, então uma perna no 3.47.0 continuará falhando por conta própria. O mesmo vale se você [mira várias versões do Flutter a partir de um único pipeline](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

Você não precisa apagar `bin/cache/flutter_tools.snapshot` manualmente. O `flutter upgrade` recompila a ferramenta. Se em vez disso você fizer checkout de uma tag com git, o próximo comando `flutter` percebe a nova revisão e também recompila o snapshot.

## Correção 2: fique no 3.47.0 e conecte dispositivos sem fio por IP

Se você não pode atualizar hoje, por exemplo porque um branch de release está travado no 3.47.0, deixe o serial curto. O `adb connect` com IP e porta cria um transporte cujo serial é algo como `192.168.1.3:36809`. São 17 caracteres, que recebem preenchimento de dois ou mais espaços e são interpretados corretamente no 3.47.0:

```bash
# Android 11+ wireless debugging, Flutter 3.47.0
# IP address & Port from Settings > Developer options > Wireless debugging
adb connect 192.168.1.3:36809
adb devices -l
flutter devices
```

Use a porta de conexão mostrada na tela Wireless debugging, não a porta de uso único do diálogo "Pair device with pairing code". A issue #191343 mostra o resultado em hardware real: as linhas mDNS continuam imprimindo o aviso, e o dispositivo aparece listado sob o serial do IP.

Para impedir que o adb conecte automaticamente o transporte mDNS, de modo que o aviso também desapareça, defina `ADB_MDNS_AUTO_CONNECT=0` antes de o servidor adb iniciar. No `adb_mdns.cpp` do adb, o valor `0` esvazia a lista de permissões de conexão automática, que por padrão contém apenas `adb-tls-connect`. A variável é lida pelo processo do servidor, então reinicie o servidor:

```bash
# adb (platform-tools), macOS/Linux shell
adb kill-server
ADB_MDNS_AUTO_CONNECT=0 adb start-server
adb connect 192.168.1.3:36809
```

No Windows, execute `set ADB_MDNS_AUTO_CONNECT=0` no cmd ou `$env:ADB_MDNS_AUTO_CONNECT = "0"` no PowerShell antes de `adb start-server`. O Android Studio inicia o próprio servidor adb se nenhum estiver rodando, então inicie o seu primeiro.

Não existe truque equivalente para dispositivos USB com seriais longos, porque não dá para encurtar um serial de hardware. Para esses, a correção é atualizar. Se você realmente não pode atualizar, use uma conexão sem fio por IP para esse dispositivo, como descrito acima.

## Teste a saída do seu adb contra os dois parsers

Se você não tem certeza de que suas linhas caem nesse bug, este script Dart executa as regexes do 3.47.0 e do 3.47.1, copiadas literalmente da ferramenta, contra o que o `adb devices -l` imprimir:

```dart
// Dart 3.13 (Flutter 3.47). Run: adb devices -l | dart run check_adb_rows.dart
import 'dart:convert';
import 'dart:io';

const states =
    r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)';

final flutter3470 = RegExp(r'^(.*?)(?:\s{2,}|\t+)' + states + r'(?:\s+(.*)|$)');
final flutter3471 = RegExp(r'^(.*)\s+' + states + r'(?:\s+(.*)|$)');

Future<void> main() async {
  final lines = await stdin.transform(utf8.decoder).transform(const LineSplitter()).toList();
  for (final raw in lines) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('List of devices') || line.startsWith('* daemon ')) {
      continue;
    }
    final old = flutter3470.firstMatch(line);
    final fixed = flutter3471.firstMatch(line);
    print(line);
    print('  3.47.0:  ${old == null ? 'PARSE FAILURE' : 'serial="${old[1]}" state=${old[2]}'}');
    print('  3.47.1+: ${fixed == null ? 'PARSE FAILURE' : 'serial="${fixed[1]!.trimRight()}" state=${fixed[2]}'}');
  }
}
```

Nas minhas nove linhas de teste ele concordou com a ferramenta real em todos os casos. Para a linha sem fio ele imprime:

```text
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:2
  3.47.0:  PARSE FAILURE
  3.47.1+: serial="adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" state=device
```

## Pegadinhas e erros parecidos

**Um dispositivo `detached` continua falhando do 3.47.1 ao 3.47.4.** As platform-tools recentes têm `adb detach` e `adb attach`, que liberam um dispositivo USB para que outro processo possa usá-lo. O nome que o adb dá a esse estado de conexão é `detached` (veja `to_string(ConnectionState)` em `adb.cpp`), e essa palavra não está na lista de estados do Flutter, então até o parser corrigido reporta "Unexpected failure parsing device information" para ele. O Flutter 3.44.8 listava a mesma linha como um dispositivo normal. Execute `adb -s <serial> attach`, e a linha volta a ser `device`. O beta 3.48.0-0.5.pre tem a mesma lista de estados, então este ainda não foi corrigido.

**Depois de atualizar, você pode receber "is not authorized" no lugar.** No 3.47.0, um dispositivo com serial longo aguardando a aprovação da depuração USB também aparece como falha de parsing, o que esconde o problema real. Assim que o 3.47.1+ interpreta a linha, você recebe "Device ... is not authorized. You might need to check your device for an authorization dialog." Desbloqueie o celular e aceite o prompt da chave RSA.

**O sufixo `(2)` é um serial real e diferente.** Se o `adb devices -l` mostra tanto `adb-XXXX._adb-tls-connect._tcp` quanto `adb-XXXX (2)._adb-tls-connect._tcp`, o adb tem dois transportes para o mesmo celular depois de um conflito de nome mDNS. O Flutter 3.47.1+ interpreta cada linha separadamente, então os dois aparecem como entradas distintas. Escolha qualquer um com `-d`, ou ligue e desligue a depuração sem fio no celular mais uma vez para voltar a ter uma única entrada. No 3.44.x, o que tem sufixo é listado sob um serial truncado que os comandos do adb depois não conseguem encontrar, que é justamente o bug que a #187943 se propôs a corrigir.

**"No supported devices connected" com uma linha do adb limpa é outro problema.** Se a linha é interpretada mas o dispositivo continua não aparecendo, verifique a ABI e o nível de API, não o parser. O equivalente desse problema no MAUI está em [doesn't support required ABI](/pt-br/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/). Se o próprio `adb` não é encontrado, o problema é a localização do SDK, e [o post sobre cmdline-tools component is missing](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) percorre a ordem de resolução do SDK pelo Flutter.

**`adb server version doesn't match this client` não é uma falha de parsing.** O Flutter reporta essa linha como um diagnóstico separado. Normalmente significa que duas instalações de platform-tools estão brigando, muitas vezes a do Homebrew e a do Android Studio. Coloque uma delas primeiro no `PATH` e execute `adb kill-server`.

## Relacionados

- [Correção: flutter doctor --android-licenses falha com cmdline-tools 23](/pt-br/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) é outro bug de ferramentas Android cuja correção real é um hotfix do 3.47.x.
- [O que mais saiu no hotfix do Flutter 3.47.1](/pt-br/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/), incluindo a mudança na validação do plugin registrant.
- Se você se conecta a um app instalado com `adb install`, veja [como manter o appFlavor preenchido após um hot restart com flutter attach](/pt-br/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- [Could not create Dart VM instance após flutter upgrade](/pt-br/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) é um caso em que a correção é passar de uma versão específica com defeito.
- Para o lado iOS da depuração em dispositivo real, veja [depurando Flutter em um iPhone físico a partir do Windows](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/).

## Fontes

- [flutter/flutter#189972](https://github.com/flutter/flutter/issues/189972) e [#189430](https://github.com/flutter/flutter/issues/189430), as issues upstream, com os relatos de usuários [#191167](https://github.com/flutter/flutter/issues/191167), [#191119](https://github.com/flutter/flutter/issues/191119) e [#191343](https://github.com/flutter/flutter/issues/191343).
- [flutter/flutter#189973](https://github.com/flutter/flutter/pull/189973), a correção, e [#191296](https://github.com/flutter/flutter/pull/191296), seu cherry-pick para o stable.
- [flutter/flutter#189369](https://github.com/flutter/flutter/pull/189369) e [#187943](https://github.com/flutter/flutter/pull/187943), as mudanças anteriores no parser.
- [`android_device_discovery.dart` no 3.47.0](https://github.com/flutter/flutter/blob/3.47.0/packages/flutter_tools/lib/src/android/android_device_discovery.dart) e [no 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/android/android_device_discovery.dart).
- [CHANGELOG do Flutter no 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md).
- Código-fonte do adb: [`transport.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp) (`append_transport`), [`adb.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb.cpp) (nomes dos estados de conexão) e [`adb_mdns.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_mdns.cpp) (`ADB_MDNS_AUTO_CONNECT`).
- [Documentação do Android Debug Bridge](https://developer.android.com/tools/adb), incluindo a depuração sem fio no Android 11+.
