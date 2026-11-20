---
title: "Fix: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate on Android 13/14 but not Android 16 in Flutter"
description: "Older Android root stores lack newer roots like Sectigo R46. Serve the cross-signed root in your chain, or trust the root via SecurityContext. Never use badCertificateCallback."
pubDate: 2026-11-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "android"
  - "tls"
---

Your server's chain ends at a root CA that is newer than the device. Android 16 ships that root, Android 13 and 14 do not, and `dart:io` does not fetch missing issuers, so the handshake fails with `unable to get local issuer certificate`. The fix belongs on the server: append the cross-signed version of the new root (for Sectigo, "Sectigo Public Server Authentication Root R46" signed by "USERTrust RSA Certification Authority") to the certificate chain. If you cannot touch the server, bundle the root in the app and add it to a `SecurityContext(withTrustedRoots: true)`. Do not ship `badCertificateCallback => true`.

Everything below was checked on Flutter 3.44.8 (Dart 3.12.2) against an Android 16 (API 36) emulator, OpenSSL 3.6.4 on macOS, the AOSP `system/ca-certificates` repository at the `android13-release` through `android16-release` branches, and the Dart SDK source at the `3.12.2`, `3.13.7` and `3.14.0` tags.

## The error in context

The same build works on a Pixel with Android 16 and fails on a Samsung with Android 13, or on an emulator image for API 33 or 34:

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:298))
```

The usual story behind it, taken from [a Stack Overflow question](https://stackoverflow.com/questions/79915722) with over a thousand views and no answer: the server certificate was renewed, the new one was issued by "Sectigo Public Server Authentication CA DV R36", SSL Labs gives the host an A- with "Chain issues: None", and the browser on the failing phone loads the site fine. A [second report](https://stackoverflow.com/questions/79996048) describes the same thing on Android 11, 12 and 13 right after an SSL certificate update, with a `FormatException: Unexpected character (at character 1)` showing up next to it because the app tried to parse a response it never got.

## Why the newer root is missing on older Android

`unable to get local issuer certificate` is BoringSSL's `X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (error 20). It means the verifier walked the chain the server sent, reached the last certificate, and found no trusted root that signed it. Nothing is wrong with the certificate itself. The client's trust store is missing one entry.

Android's root store is versioned with the OS. Listing the `files/` directory of [`platform/system/ca-certificates`](https://android.googlesource.com/platform/system/ca-certificates/) on each release branch gives:

| Branch | Roots | Sectigo R46 (`e071171e.0`) |
| --- | --- | --- |
| `android13-release` | 129 | missing |
| `android14-release` | 134 | missing |
| `android15-release` | 145 | present |
| `android16-release` | 149 | present |

Sectigo Public Server Authentication Root R46 and its ECC sibling E46 (`3afde786.0`) both arrive in `android15-release`. They are not the only ones: Android 15 also added roots from SSL.com, CommScope, TrustAsia, Atos and BJCA, and Android 14 added GlobalSign R46/E46, ISRG Root X2, HARICA 2021, Certainly and others. If your certificate chains up to any root added after the oldest Android version you support, you have the same problem, regardless of the CA's name.

Two more things make this harder to diagnose than it should be.

**SSL Labs says the chain is fine.** It is, for clients that already trust R46. A chain of leaf plus "DV R36" is complete if R46 is a trusted anchor, and current Mozilla, Apple, Microsoft and Android 15+ stores all have it. SSL Labs does not test against an Android 13 root store, so "Chain issues: None" tells you nothing about older phones.

**The browser on the same phone works.** Browsers can use their own root store and can fetch missing issuer certificates from the AIA URL in a certificate. `dart:io` does neither. On Android it loads the OS root directory into BoringSSL and verifies with only the certificates the server sent. A browser test on the failing device proves nothing about your Flutter app.

### Android 14 is a special case for Flutter

Since Android 14 the system root store lives in the updatable Conscrypt APEX module at `/apex/com.android.conscrypt/cacerts`, so Google can add or remove roots through Google Play system updates without an OTA. `/system/etc/security/cacerts` is only a fallback. Native Android code (`HttpsURLConnection`, OkHttp) uses the APEX copy.

`dart:io` did not, until recently. In Dart 3.12.2 (Flutter 3.44.x) and every 3.13 release up to 3.13.6, `SSLCertContext::TrustBuiltinRoots()` in `runtime/bin/security_context_linux.cc` always loaded `/system/etc/security/cacerts`. [dart-lang/sdk#64696](https://github.com/dart-lang/sdk/pull/64696) changed it to prefer the APEX directory, and it shipped in Dart 3.13.7 on 2026-10-22, which is the SDK in Flutter 3.47.8, 3.47.9 and the 3.50 releases. A follow-up commit on `main` ([`9707c439c0`](https://github.com/dart-lang/sdk/commit/9707c439c0)) also falls back when the APEX directory exists but is empty; it is not in Dart 3.14.0 yet.

So on an Android 14 phone whose Conscrypt module has been updated with a newer root, a Kotlin `HttpsURLConnection` call can succeed while the Flutter app built with 3.44 fails against the same host. Upgrading Flutter helps those devices. It does nothing for Android 11, 12 or 13, which have no APEX root store at all.

## Minimal repro

You cannot make a public CA issue you a certificate from an old root, but you can build the same shape with OpenSSL: an "old" root the device trusts, a "new" root it does not, a cross-certificate of the new root signed by the old one, an intermediate under the new root, and a leaf.

```bash
# OpenSSL 3.6.4. Mirrors USERTrust RSA (old root) -> R46 (new root) -> DV R36 -> leaf
O=/opt/homebrew/opt/openssl@3/bin/openssl
cat > ext.cnf <<'EOF'
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:10.0.2.2,IP:127.0.0.1,DNS:localhost
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
for k in oldroot newroot int leaf; do $O genrsa -out $k.key 2048; done
$O req -x509 -new -key oldroot.key -subj "/CN=Test Old Root" -days 3650 -out oldroot.pem \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
$O req -x509 -new -key newroot.key -subj "/CN=Test New Root" -days 3650 -out newroot.pem \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
# Cross-certificate: same subject and key as the new root, issued by the old root
$O req -new -key newroot.key -subj "/CN=Test New Root" -out newroot.csr
$O x509 -req -in newroot.csr -CA oldroot.pem -CAkey oldroot.key -CAcreateserial \
  -days 3000 -extfile ext.cnf -extensions ca -out newroot-cross.pem
$O req -new -key int.key -subj "/CN=Test Server CA" -out int.csr
$O x509 -req -in int.csr -CA newroot.pem -CAkey newroot.key -CAcreateserial \
  -days 2000 -extfile ext.cnf -extensions ca -out int.pem
$O req -new -key leaf.key -subj "/CN=10.0.2.2" -out leaf.csr
$O x509 -req -in leaf.csr -CA int.pem -CAkey int.key -CAcreateserial \
  -days 300 -extfile ext.cnf -extensions leaf -out leaf.pem
cat leaf.pem int.pem > chain-short.pem                    # what the broken server sends
cat leaf.pem int.pem newroot-cross.pem > chain-long.pem   # what the fixed server sends
```

A Dart server on the host serves the same leaf with each chain:

```dart
// Dart 3.12.2 (Flutter 3.44.8): dart run server.dart <pki-dir>
import 'dart:io';

Future<void> serve(int port, String chain, String pki) async {
  final ctx = SecurityContext()
    ..useCertificateChain('$pki/$chain')
    ..usePrivateKey('$pki/leaf.key');
  final server = await HttpServer.bindSecure(InternetAddress.anyIPv4, port, ctx);
  await for (final req in server) {
    req.response.write('ok from $chain');
    await req.response.close();
  }
}

void main(List<String> args) {
  serve(8443, 'chain-short.pem', args.first);
  serve(8444, 'chain-long.pem', args.first);
}
```

And a Flutter app on the emulator plays both kinds of device by controlling which roots its `SecurityContext` trusts (`oldRootPem`, `newRootPem` and `android13RootsPem` are string constants holding the PEM files):

```dart
// Flutter 3.44.8, Dart 3.12.2, Android 16 (API 36) emulator
import 'dart:convert';
import 'dart:io';

import 'pems.dart';

Future<String> probe(String label, SecurityContext? ctx, Uri uri) async {
  final client = HttpClient(context: ctx);
  try {
    final res = await (await client.getUrl(uri)).close();
    final body = await res.transform(utf8.decoder).join();
    return '$label -> HTTP ${res.statusCode} (${body.length} chars)';
  } on HandshakeException catch (e) {
    return '$label -> ${e.toString().replaceAll('\n', ' ')}';
  } finally {
    client.close(force: true);
  }
}

SecurityContext only(List<String> pems) {
  final ctx = SecurityContext(withTrustedRoots: false);
  for (final pem in pems) {
    ctx.setTrustedCertificatesBytes(utf8.encode(pem));
  }
  return ctx;
}

Future<void> main() async {
  final short = Uri.parse('https://10.0.2.2:8443/');
  final long = Uri.parse('https://10.0.2.2:8444/');
  final oldDevice = only([oldRootPem]);
  final newDevice = only([oldRootPem, newRootPem]);
  final systemPlusOld = SecurityContext(withTrustedRoots: true)
    ..setTrustedCertificatesBytes(utf8.encode(oldRootPem));
  final systemPlusNew = SecurityContext(withTrustedRoots: true)
    ..setTrustedCertificatesBytes(utf8.encode(oldRootPem))
    ..setTrustedCertificatesBytes(utf8.encode(newRootPem));

  for (final line in [
    await probe('old-device  short-chain', oldDevice, short),
    await probe('old-device  long-chain ', oldDevice, long),
    await probe('new-device  short-chain', newDevice, short),
    await probe('new-device  long-chain ', newDevice, long),
    await probe('system+old  short-chain', systemPlusOld, short),
    await probe('system+new  short-chain', systemPlusNew, short),
    await probe('default     sectigo.com', null, Uri.parse('https://sectigo.com/')),
    await probe('a13-roots   sectigo.com', only([android13RootsPem]),
        Uri.parse('https://sectigo.com/')),
  ]) {
    print(line);
  }
  exit(0);
}
```

Output from `adb logcat` after installing the debug APK on the API 36 emulator:

```text
old-device  short-chain -> HandshakeException: Handshake error in client (OS Error:  	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:298))
old-device  long-chain  -> HTTP 200 (22 chars)
new-device  short-chain -> HTTP 200 (23 chars)
new-device  long-chain  -> HTTP 200 (22 chars)
system+old  short-chain -> HandshakeException: Handshake error in client (OS Error:  	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:298))
system+new  short-chain -> HTTP 200 (23 chars)
default     sectigo.com -> HTTP 200 (632797 chars)
a13-roots   sectigo.com -> HTTP 200 (632797 chars)
```

That is the whole bug in four lines. The "old device" fails only on the short chain. Adding the cross-certificate to the server chain fixes it without changing the client, and adding the new root to the client fixes it without changing the server. The last two lines are real network calls: `sectigo.com` serves its R46 chain correctly, so even a context loaded with only Android 13's 129 roots connects.

To confirm the real Sectigo chain behaves the same way, the `android13-release` root files were concatenated into one PEM and fed to OpenSSL with the certificates `sectigo.com` sends:

```text
# OpenSSL 3.6.4, Android 13 root store, sectigo.com chain (leaf <- OV R36 <- R46 <- USERTrust)
$ openssl verify -CAfile android13-roots.pem -untrusted ov-r36.pem leaf.pem
error 20 at 1 depth lookup: unable to get local issuer certificate
error leaf.pem: verification failed

$ openssl verify -CAfile android13-roots.pem -untrusted ov-r36-plus-r46-cross.pem -show_chain leaf.pem
leaf.pem: OK
depth=2: C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication Root R46 (untrusted)
depth=3: C=US, ST=New Jersey, L=Jersey City, O=The USERTRUST Network, CN=USERTrust RSA Certification Authority
```

The emulator itself has R46 in both `/apex/com.android.conscrypt/cacerts/e071171e.0` and `/system/etc/security/cacerts/e071171e.0` (149 files in each), which matches the `android16-release` table row.

## Fix, in detail

Ranked by how much of your user base each fix covers.

### 1. Serve the cross-signed root in the server chain

This fixes every client at once: Flutter apps already in the store, Android 7 phones, Java services, anything that trusts the old root. For Sectigo's R36 intermediates the certificate you need is:

- Subject: `CN=Sectigo Public Server Authentication Root R46, O=Sectigo Limited, C=GB`
- Issuer: `CN=USERTrust RSA Certification Authority`
- Serial: `D27FBBC1DE359E5216AD6149586099C4`
- Valid until: 2038-01-18
- SHA-256: `92:F3:51:BF:3D:54:16:4D:FA:8D:D8:F9:E1:13:9D:31:50:34:97:86:48:5D:2B:9E:EC:D0:0E:29:71:C1:E6:C5`

USERTrust RSA Certification Authority is in the Android 13 root store as `35105088.0`. Your CA's download bundle usually contains this cross-certificate already; it is the file people delete because "the root does not belong in the chain". It is not the root. The self-signed R46 (SHA-256 `7B:B6:47:A6:...:5A:06`) is the one you leave out. You can also copy it from a server that does this right:

```bash
# OpenSSL 3.6.4: print the third certificate sectigo.com sends (R46 signed by USERTrust)
echo | openssl s_client -connect sectigo.com:443 -servername sectigo.com -showcerts 2>/dev/null \
  | awk '/BEGIN CERT/{n++} n==3{print} /END CERT/{if(n==3) exit}' > r46-cross-usertrust.pem
openssl x509 -in r46-cross-usertrust.pem -noout -subject -issuer -serial -enddate
```

Then order the server chain leaf first, root-most last:

```nginx
# nginx: fullchain.pem = leaf + DV R36 + R46 cross-signed by USERTrust
ssl_certificate     /etc/ssl/example/fullchain.pem;
ssl_certificate_key /etc/ssl/example/privkey.pem;
```

Clients that already trust R46 are unaffected: the `new-device long-chain` probe above connected, and modern verifiers such as BoringSSL and OpenSSL 1.1+ can end the path at the self-signed R46 they trust even when the cross-certificate is present. The cost is one extra certificate (about 1.5 KB) in every handshake.

### 2. Trust the missing root inside the app

If the API belongs to someone else, ship the self-signed root as an asset and add it to the system roots. `withTrustedRoots: true` matters: without it you trust only your file, and every other host the app talks to breaks.

```dart
// Flutter 3.44.8, Dart 3.12.2, http 1.6.0
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/io_client.dart';

Future<IOClient> createApiClient() async {
  // assets/certs/sectigo-r46.pem: the self-signed R46, declared under flutter: assets:
  final pem = await rootBundle.load('assets/certs/sectigo-r46.pem');
  final context = SecurityContext(withTrustedRoots: true)
    ..setTrustedCertificatesBytes(pem.buffer.asUint8List());
  return IOClient(HttpClient(context: context));
}
```

For `dio` the same `HttpClient` goes into the adapter (both snippets pass `dart analyze` with these package versions; the `system+new` probe in the repro is the runtime check):

```dart
// Flutter 3.44.8, dio 5.11.1
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

Dio createDio(SecurityContext context) => Dio()
  ..httpClientAdapter = IOHttpClientAdapter(
    createHttpClient: () => HttpClient(context: context),
  );
```

The `system+new` probe in the repro is exactly this configuration, and it connected through the short chain. Two caveats: you now own that root's lifecycle in your app (if the CA is ever distrusted, your copy keeps trusting it until you ship an update), and `SecurityContext` is per isolate, so a background isolate that makes its own requests needs its own context.

### 3. Upgrade Flutter, for Android 14+ devices only

Flutter 3.47.8 and later (Dart 3.13.7+) read the Conscrypt APEX store on Android 14+. That brings Flutter in line with native Android code on devices that have received newer roots through Google Play system updates. It is worth doing anyway, but it is not a fix for this error on its own: Android 11, 12 and 13 have no APEX store, and an Android 14 device only benefits if its module update actually contains the root you need.

### What not to do

The `badCertificateCallback` workaround from the question "only for my host" still disables certificate validation for that host. Anyone on the same Wi-Fi can present any certificate for `api.example.com` and the app will accept it, because the callback receives the certificate and host but you return `true` without checking the certificate. If you must use the callback as a stopgap, compare `cert.der` against a pinned SHA-256 instead of returning `true`, and remove it once option 1 is deployed.

## Gotchas and lookalikes

- **It worked before the renewal.** CAs move customers to new hierarchies at renewal time. Sectigo's R36 intermediates chain to R46; older certificates chained to USERTrust directly. The server config did not change, but the chain the CA handed you did.
- **"Fix" by switching the certificate to Let's Encrypt.** ISRG Root X1 has been in Android since 7.1.1, so this works, but only by accident. ISRG Root X2 (ECDSA) only arrived in `android14-release`, so the same problem returns if you opt into the ECDSA-only chain.
- **The failing call is a WebView, image or `video_player` load.** Those go through Android's own stack, not `dart:io`. They see a different root store (APEX on 14+) and a different error. This page is about `HttpClient`, `package:http`, `dio` and anything else built on `dart:io`.
- **The app fails on every Android version.** That is a server chain that is genuinely incomplete (no intermediate at all), a self-signed certificate, or a user-installed corporate CA. Android only trusts user CAs for apps that opt in through `network_security_config.xml`, and `dart:io` never reads user CAs.
- **The same error in a Docker container or a CLI tool.** Dart 3.13 removed the VM's compiled-in fallback roots, which breaks bare images. See [the Dart 3.13 Docker variant of this error](/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/).
- **`FormatException: Unexpected character (at character 1)` in the same log.** That is your error handler parsing an empty or HTML body after the request failed. Fix the handshake first; the [FormatException walkthrough](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) covers the parsing side.

## Related

- [Fix: CERTIFICATE_VERIFY_FAILED in a Dart 3.13 Docker image](/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/) explains where `dart:io` finds roots on Linux and why bare images trust nothing.
- [Fix: FormatException: Unexpected character when parsing JSON in Dart](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) for the secondary error that often hides this one.
- [Fix: The SSL connection could not be established with HttpClient](/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) is the .NET version of the same diagnosis: read the inner reason, then fix trust, name or protocol.
- [How to add platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) if you want to compare `dart:io` with a native `HttpsURLConnection` call on the same device.

## Sources

- [AOSP `platform/system/ca-certificates`](https://android.googlesource.com/platform/system/ca-certificates/), `files/` on `android13-release`, `android14-release`, `android15-release` and `android16-release`.
- [dart-lang/sdk#64696: Use Conscrypt APEX root store on Android 14+](https://github.com/dart-lang/sdk/pull/64696) and the [Dart 3.13.7 changelog entry](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md#3137).
- [`runtime/bin/security_context_linux.cc`](https://github.com/dart-lang/sdk/blob/3.12.2/runtime/bin/security_context_linux.cc) at Dart 3.12.2, and the [follow-up empty-directory fix](https://github.com/dart-lang/sdk/commit/9707c439c0).
- [`SecurityContext` API reference](https://api.flutter.dev/flutter/dart-io/SecurityContext-class.html).
- Stack Overflow: [CERTIFICATE_VERIFY_FAILED on Android 13/14 but works on Android 16 (Sectigo CA)](https://stackoverflow.com/questions/79915722) and [Android 11, 12 and 13 HandshakeException after SSL certificate update](https://stackoverflow.com/questions/79996048).
