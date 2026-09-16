---
title: "Fix: Unexpected failure parsing device information from adb output in Flutter"
description: "Flutter 3.47.0 cannot parse adb rows whose serial is 22+ characters, so wireless and some USB Android devices vanish. Upgrade to 3.47.1 or later, or adb connect by IP."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "adb"
  - "flutter-tools"
---

This is a parser bug in Flutter 3.47.0, and you do not need to report it again. `adb devices -l` pads the serial column to 22 characters and then adds one space, so any serial that is 22 characters or longer (every wireless debugging `adb-...._adb-tls-connect._tcp` name, plus some USB serials) is followed by a single space. The 3.47.0 parser requires two spaces or a tab there, rejects the row, and leaves the device out. Run `flutter upgrade` to get 3.47.1 or later (3.47.4 is the current stable). If you have to stay on 3.47.0, connect wireless devices with `adb connect <ip>:<port>`, since the short IP serial still parses.

I reproduced everything below on macOS with Flutter 3.44.8, 3.47.0, and 3.47.4 (Dart 3.13.0 and 3.13.3). I pointed each one at a scratch Android SDK whose `platform-tools/adb` is a fake script, and fed it the same nine device rows.

## The error in context

`flutter devices` lists desktop and web targets, but not the phone that `adb devices` clearly sees:

```text
Found 2 connected devices:
  macOS (desktop) • macos  • darwin-arm64   • macOS 26.6.1 25G76 darwin-arm64
  Chrome (web)    • chrome • web-javascript • Google Chrome 151.0.7922.140

No wireless devices were found.

Unexpected failure parsing device information from adb output:
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:1
Please report a bug at https://github.com/flutter/flutter/issues.
```

In `flutter doctor` it is easy to miss, because the "Connected device" section still gets a green check and the warning sits underneath it:

```text
[✓] Connected device (2 available)
    ! Unexpected failure parsing device information from adb output:
      9b01005930533036340043eb2a5c2c device usb:17907712X product:serenity_p_in model:25028PC03I device:serenity transport_id:1
      Please report a bug at https://github.com/flutter/flutter/issues.
```

That second one is a USB phone, not a wireless one, which is why the "it only happens with wireless debugging" advice you will find in some threads is incomplete. Android Studio and VS Code get their device list from the same discovery code, so the device is missing from the IDE picker too, and `flutter run -d <serial>` has nothing to match.

The reports are [flutter/flutter#191167](https://github.com/flutter/flutter/issues/191167) (USB, Flutter 3.47.0 on macOS), [#191119](https://github.com/flutter/flutter/issues/191119) (Wi-Fi pairing on Fedora), [#191343](https://github.com/flutter/flutter/issues/191343) (Ubuntu), and the upstream [#189430](https://github.com/flutter/flutter/issues/189430) and [#189972](https://github.com/flutter/flutter/issues/189972).

## Why Flutter 3.47.0 rejects a valid adb row

adb builds each long-listing row in `append_transport` in `transport.cpp`:

```cpp
// adb (platform/packages/modules/adb), transport.cpp
android::base::StringAppendF(result, "%-22s %s", serial.c_str(),
                             to_string(t->GetConnectionState()).c_str());
```

`%-22s` is a minimum width, not a column. A 10-character serial like `ZN52278M76` gets 12 spaces of padding plus the literal space, so 13 spaces in total. A 21-character serial gets two. A serial of 22 characters or more gets exactly one. Wireless debugging serials are the mDNS service name, and the `._adb-tls-connect._tcp` suffix alone is 22 characters. Many USB serials are too: the 30-character serial in #191167 is one example.

Flutter 3.44.x parsed rows with `^(\S+)\s+(\S+)(.*)`: first token, any whitespace, second token. That handles one space fine, but it breaks when the serial itself contains a space. When you toggle wireless debugging quickly, mDNS appends a conflict suffix and the serial becomes `adb-26151FDF60083B-9tP4nl (2)._adb-tls-connect._tcp`. Flutter 3.44.8 then cuts the serial at the first space. My fake adb logged the call it received as `adb -s adb-26151FDF60083B-9tP4nl shell getprop`, and a real adb server does not know that truncated serial.

Fixing that took three attempts during the 3.47 cycle:

1. [#187943](https://github.com/flutter/flutter/pull/187943) switched to a lazy serial match, `^(.*?)\s+(no permissions|\S+)...`, which shipped in 3.47.0-0.1.pre. It broke rows that carry a devpath without a `key:` prefix.
2. [#189369](https://github.com/flutter/flutter/pull/189369) fixed that by listing the known adb states explicitly and requiring `(?:\s{2,}|\t+)` before the state. It was cherry-picked to beta and shipped in 3.47.0. That two-space rule is the bug this post is about.
3. [#189973](https://github.com/flutter/flutter/pull/189973) switched to a greedy serial capture anchored on the known state words, then trims the padding. It was cherry-picked to stable as [#191296](https://github.com/flutter/flutter/pull/191296) and shipped in 3.47.1 on August 19, 2026.

This is the 3.47.0 regex, from `packages/flutter_tools/lib/src/android/android_device_discovery.dart`:

```dart
// Flutter 3.47.0, android_device_discovery.dart
static final _kDeviceRegex = RegExp(
  r'^(.*?)(?:\s{2,}|\t+)'
  r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)'
  r'(?:\s+(.*)|$)',
);
```

The only change in 3.47.1 is the first line, which became `r'^(.*)\s+'`, plus a `trimRight()` on the captured serial. The file is identical from 3.47.1 through 3.47.4 and in the 3.48.0-0.5.pre beta.

## Minimal repro with a fake adb

You do not need a phone to see this. Flutter finds `adb` at `$ANDROID_HOME/platform-tools/adb`, so a shell script at that path can print whatever rows you want. It uses the same `%-22s %s` format adb uses:

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

`XDG_CONFIG_HOME` keeps a path you once stored with `flutter config --android-sdk` from overriding `ANDROID_HOME`. I ran nine rows through each version. The table shows what `flutter devices` printed:

| adb row | 3.44.8 | 3.47.0 | 3.47.4 |
|---|---|---|---|
| USB, 10-char serial `ZN52278M76` | listed | listed | listed |
| USB, 21-char serial | listed | listed | listed |
| USB, 22-char serial | listed | parse failure | listed |
| USB, 30-char serial | listed | parse failure | listed |
| Wireless mDNS `adb-...._adb-tls-connect._tcp` | listed | parse failure | listed |
| Wireless mDNS with `(2)` suffix | listed with truncated serial | parse failure | listed |
| Wireless `192.168.1.3:36809` | listed | listed | listed |
| Wireless mDNS, `unauthorized` | "is not authorized" hint | parse failure | "is not authorized" hint |
| USB, `detached` | listed as a device | parse failure | parse failure |

The 21 versus 22 character boundary is the whole story. The last row is a separate problem, covered in the gotchas below.

## Fix 1: upgrade Flutter to 3.47.1 or later

Check what you are on first:

```bash
# Flutter 3.47.x
flutter --version
```

If the first line says `Flutter 3.47.0`, upgrade on the stable channel:

```bash
# moves 3.47.0 to the latest 3.47.x hotfix (3.47.4 as of 2026-09-16)
flutter upgrade
flutter devices
```

The fix is in the [3.47.1 CHANGELOG entry](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md) as "Fix ADB device list parsing for long wireless mDNS serials separated from state by a single space". The wording mentions wireless serials, but the fix also covers long USB serials, as the table shows. If you pin versions with FVM or a CI matrix, bump the pin to `3.47.4` rather than running `flutter upgrade`. Each pinned leg keeps its own tool snapshot, so a 3.47.0 leg will keep failing on its own. The same thing applies if you [target several Flutter versions from one pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

You do not need to delete `bin/cache/flutter_tools.snapshot` by hand. `flutter upgrade` rebuilds the tool. If you check out a tag with git instead, the next `flutter` command notices the new revision and rebuilds the snapshot too.

## Fix 2: stay on 3.47.0 and connect wireless devices by IP

If you cannot upgrade today, for example because a release branch is locked to 3.47.0, make the serial short. `adb connect` with an IP and port creates a transport whose serial is something like `192.168.1.3:36809`. That is 17 characters, gets padded to two or more spaces, and parses on 3.47.0:

```bash
# Android 11+ wireless debugging, Flutter 3.47.0
# IP address & Port from Settings > Developer options > Wireless debugging
adb connect 192.168.1.3:36809
adb devices -l
flutter devices
```

Use the connection port shown on the Wireless debugging screen, not the one-time port from the "Pair device with pairing code" dialog. Issue #191343 shows the result on real hardware: the mDNS rows still print the warning, and the device is listed under its IP serial.

To stop adb from auto-connecting the mDNS transport at all, so the warning goes away too, set `ADB_MDNS_AUTO_CONNECT=0` before the adb server starts. In adb's `adb_mdns.cpp`, the value `0` clears the auto-connect allowlist, which by default contains only `adb-tls-connect`. The variable is read by the server process, so restart the server:

```bash
# adb (platform-tools), macOS/Linux shell
adb kill-server
ADB_MDNS_AUTO_CONNECT=0 adb start-server
adb connect 192.168.1.3:36809
```

On Windows, run `set ADB_MDNS_AUTO_CONNECT=0` in cmd or `$env:ADB_MDNS_AUTO_CONNECT = "0"` in PowerShell before `adb start-server`. Android Studio starts its own adb server if none is running, so start yours first.

There is no equivalent trick for USB devices with long serials, because you cannot shorten a hardware serial. For those, upgrading is the fix. If you truly cannot upgrade, use a wireless IP connection for that device as above.

## Check your own adb output against both parsers

If you are not sure whether your rows hit this bug, this Dart script runs the 3.47.0 and 3.47.1 regexes, copied verbatim from the tool, against whatever `adb devices -l` prints:

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

On my nine test rows it agreed with the real tool in every case. For the wireless row it prints:

```text
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:2
  3.47.0:  PARSE FAILURE
  3.47.1+: serial="adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" state=device
```

## Gotchas and lookalikes

**A `detached` device still fails on 3.47.1 through 3.47.4.** Recent platform-tools have `adb detach` and `adb attach`, which release a USB device so another process can use it. adb's name for that connection state is `detached` (see `to_string(ConnectionState)` in `adb.cpp`), and that word is not in Flutter's state list, so even the fixed parser reports "Unexpected failure parsing device information" for it. Flutter 3.44.8 listed the same row as a normal device. Run `adb -s <serial> attach`, and the row goes back to `device`. The 3.48.0-0.5.pre beta has the same state list, so this one is not fixed yet.

**After upgrading, you may get "is not authorized" instead.** On 3.47.0 a long-serial device waiting for USB debugging approval also shows up as a parse failure, which hides the real problem. Once 3.47.1+ parses the row, you get "Device ... is not authorized. You might need to check your device for an authorization dialog." Unlock the phone and accept the RSA key prompt.

**The `(2)` suffix is a real, different serial.** If `adb devices -l` shows both `adb-XXXX._adb-tls-connect._tcp` and `adb-XXXX (2)._adb-tls-connect._tcp`, adb has two transports to the same phone after an mDNS name conflict. Flutter 3.47.1+ parses each row on its own, so both show up as separate entries. Pick either one with `-d`, or toggle wireless debugging on the phone once more to get back to a single entry. On 3.44.x the suffixed one is listed under a truncated serial that adb commands then fail to find, which is the bug #187943 set out to fix.

**"No supported devices connected" with a clean adb row is a different problem.** If the row parses but the device still does not appear, check the ABI and API level, not the parser. The MAUI equivalent of that problem is covered in [doesn't support required ABI](/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/). If `adb` itself is not found, the SDK lookup is the issue, and [the cmdline-tools component is missing post](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) walks through Flutter's SDK resolution order.

**`adb server version doesn't match this client` is not a parse failure.** Flutter reports that line as a separate diagnostic. It usually means two platform-tools installs are fighting, often Homebrew's and Android Studio's. Put one of them first on `PATH` and `adb kill-server`.

## Related

- [Fix: flutter doctor --android-licenses fails with cmdline-tools 23](/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) is another Android tooling bug whose real fix is a 3.47.x hotfix.
- [What else shipped in the Flutter 3.47.1 hotfix](/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/), including the plugin registrant validation change.
- If you attach to an app you installed with `adb install`, see [keeping appFlavor populated after a hot restart with flutter attach](/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- [Could not create Dart VM instance after flutter upgrade](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) is a case where the fix is moving past a specific broken release.
- For the iOS side of real-device debugging, see [debugging Flutter on a physical iPhone from Windows](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/).

## Sources

- [flutter/flutter#189972](https://github.com/flutter/flutter/issues/189972) and [#189430](https://github.com/flutter/flutter/issues/189430), the upstream issues, with user reports [#191167](https://github.com/flutter/flutter/issues/191167), [#191119](https://github.com/flutter/flutter/issues/191119), and [#191343](https://github.com/flutter/flutter/issues/191343).
- [flutter/flutter#189973](https://github.com/flutter/flutter/pull/189973), the fix, and [#191296](https://github.com/flutter/flutter/pull/191296), its stable cherry-pick.
- [flutter/flutter#189369](https://github.com/flutter/flutter/pull/189369) and [#187943](https://github.com/flutter/flutter/pull/187943), the earlier parser changes.
- [`android_device_discovery.dart` at 3.47.0](https://github.com/flutter/flutter/blob/3.47.0/packages/flutter_tools/lib/src/android/android_device_discovery.dart) and [at 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/android/android_device_discovery.dart).
- [Flutter CHANGELOG at 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md).
- adb source: [`transport.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp) (`append_transport`), [`adb.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb.cpp) (connection state names), and [`adb_mdns.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_mdns.cpp) (`ADB_MDNS_AUTO_CONNECT`).
- [Android Debug Bridge documentation](https://developer.android.com/tools/adb), including wireless debugging on Android 11+.
