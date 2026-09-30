---
title: "Fix: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate in a Dart 3.13 Docker image"
description: "Dart 3.13 removed the VM's built-in fallback root certificates. Put a CA bundle in the runtime image: COPY /runtime/ from dart:stable or install ca-certificates."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "docker"
  - "tls"
  - "dart-3-13"
---

Your Dockerfile did not change. Dart did. Starting with Dart 3.13.0 (the SDK in Flutter 3.47.0, and the one behind the `dart:stable` tag since August 2026, currently 3.13.5), the standalone VM no longer ships a compiled-in fallback set of root certificates. If the image your app runs in has no CA bundle at one of the standard Linux paths, every HTTPS call now fails the handshake. Fix it by giving the runtime stage a trust store: keep `COPY --from=build /runtime/ /` in a `FROM scratch` stage, or `apt-get install ca-certificates` in a slim base image. If you cannot change the image, point the VM at a PEM file with `DART_VM_OPTIONS=--root-certs-file=/path/to/cacert.pem`.

Everything below is based on the Dart SDK source at the `3.12.2`, `3.13.0` and `3.13.5` tags, the `stable/trixie` Dockerfile in `dart-lang/dart-docker`, and the triage of [dart-lang/sdk#64060](https://github.com/dart-lang/sdk/issues/64060), where the Dart team confirmed the behaviour is intentional.

## The error in context

The app builds fine and starts fine. The first outbound TLS connection, whether it goes through `HttpClient`, `package:http`, `dio`, a gRPC channel or a database driver, throws:

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:320))

#0      _SecureFilterImpl._handshake (dart:io-patch/secure_socket_patch.dart:101)
#1      _SecureFilterImpl.handshake (dart:io-patch/secure_socket_patch.dart:146)
#2      _RawSecureSocket._secureHandshake (dart:io/secure_socket.dart:995)
#3      _RawSecureSocket._tryFilter (dart:io/secure_socket.dart:1127)
<asynchronous suspension>
```

The tell is the timing. The same code, the same Dockerfile and the same endpoint worked on `dart:3.12.2`. Pinning the build stage back to `dart:3.12.2` makes the error go away, which is exactly what the reporter of #64060 did before tracking down the cause. Endpoints with perfectly valid public certificates (pub.dev, googleapis.com, your own Let's Encrypt API) fail just like self-signed ones, because the problem is not the server chain. The client trusts nothing at all.

## Why Dart 3.13 stopped trusting anything in a bare image

On Linux, `SSLCertContext::TrustBuiltinRoots()` in `runtime/bin/security_context_linux.cc` looks for trusted roots in a fixed order:

1. The `--root-certs-file` or `--root-certs-cache` option, if you passed one.
2. The first bundle file that exists out of `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/pki/tls/cacert.pem` and `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`.
3. The first directory that exists out of `/etc/ssl/certs`, `/system/etc/security/cacerts`, `/usr/local/share/certs`, `/etc/pki/tls/certs` and `/etc/openssl/certs`.
4. As a last resort, `AddCompiledInCerts()`, which loads a Mozilla root bundle baked into the `dart` and `dartaotruntime` binaries (and therefore into every `dart compile exe` output).

Step 4 is what changed. The Dart 3.13.0 changelog says it in one line under "Dart Runtime": the built-in fallback root certificates "are no longer included". The SDK commit is [`7e5b075680`](https://github.com/dart-lang/sdk/commit/7e5b075680), "Reland [standalone] Remove the fallback root certificates", landed on 2026-06-01 after a first attempt in May was reverted. The function still exists in 3.13, but `runtime/bin/BUILD.gn` no longer pulls in `third_party/fallback_root_certificates` and unconditionally defines `DART_IO_ROOT_CERTS_DISABLED`, so `root_certificates_pem` is null and the function returns without adding anything.

For years that fallback silently covered for runtime images that had no CA bundle. A `FROM scratch` stage that copied only the compiled binary worked because the binary carried its own roots. A `debian:trixie-slim` base without `ca-certificates` worked for the same reason. In 3.13 those images end up with an empty `X509_STORE`, and BoringSSL reports the first certificate in any chain as having an unknown issuer.

Two details make this more confusing than it should be:

- **The `dart:stable` image itself is fine.** Its Dockerfile installs `ca-certificates`, and the `/runtime/` directory it prepares for multi-stage builds includes `/etc/ssl/certs` and `/usr/share/ca-certificates`, copied with `--dereference` so the symlinks survive. If you see the error, the failing process is almost always running in a *different* image than the one you built with. In #64060 the build used `dart:3.13.0`, but the pod ran on a five-year-old `docker:19.03.15` / `ubuntu:xenial` image.
- **An empty `/etc/ssl/certs` directory is worse than a missing one.** Step 3 only checks that the directory exists, not that it contains anything. Some base images ship the directory without the certificates, so the VM happily "loads" zero roots from it.

## Minimal repro

A Dart program that makes one HTTPS request:

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

And a multi-stage Dockerfile that copies only the executable into the final stage, a shape that is common in hand-written Dockerfiles and in CI templates that predate the official one:

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

Built with `dart:3.12.2` this prints `status: 200`, thanks to the compiled-in roots. Built with `dart:3.13.0` or later it throws the `HandshakeException` above, because `debian:trixie-slim` does not include the `ca-certificates` package.

## Fix, in detail

Pick the first option that fits your image. All of them give the VM a real trust store; none of them turn verification off.

### 1. Keep the official `/runtime/` copy in a `FROM scratch` stage

This is the layout the [official `dart` image documentation](https://hub.docker.com/_/dart) recommends, and it already carries the certificates:

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

If your final stage is `FROM scratch` and the only `COPY` is the binary, add the `/runtime/` line. Beyond the certificates it also brings the glibc loader, `libnss_dns` and `/etc/nsswitch.conf`, so it fixes DNS resolution problems you might not have hit yet.

### 2. Install `ca-certificates` in a slim runtime image

If you run on `debian:*-slim` or `ubuntu:*`, install the package in the final stage:

```dockerfile
# Dart 3.13.5 AOT binary on debian:trixie-slim
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

The package's post-install script generates `/etc/ssl/certs/ca-certificates.crt`, which is the first path the VM checks. You do not need a separate `update-ca-certificates` call unless you are adding your own certificates (see below). On RHEL, UBI or Fedora images the equivalent package is also `ca-certificates`, and it produces `/etc/pki/tls/certs/ca-bundle.crt`, which is also on the list.

Distroless works as well: `gcr.io/distroless/cc-debian12` ships `/etc/ssl/certs/ca-certificates.crt` and the glibc a Dart AOT binary needs.

### 3. Refresh an old base image

If the runtime image has `ca-certificates` but is years old, the bundle predates the roots that newer CAs chain to. That was the actual situation in #64060. Moving to a current base image is the fix. Refreshing the package in place (`apt-get update && apt-get install --only-upgrade ca-certificates`) works only while the distribution still publishes updates.

### 4. Point the VM at a bundle with `DART_VM_OPTIONS`

When you cannot touch the image, but you can mount a file or set an environment variable (a Kubernetes pod spec, a managed runtime), use `--root-certs-file`. For JIT (`dart run`, `dart bin/server.dart`) it is a normal VM option:

```bash
dart --root-certs-file=/certs/cacert.pem bin/server.dart
```

A `dart compile exe` binary ignores its own command line for VM options, since every argument goes to your `main`. It does read `DART_VM_OPTIONS`, a comma-separated list parsed in `main_impl.cc` only for executables with an appended snapshot, and `--root-certs-file` is one of the options it accepts:

```dockerfile
# Dart 3.13.5 AOT binary, CA bundle supplied explicitly
FROM debian:trixie-slim
COPY cacert.pem /certs/cacert.pem
COPY --from=build /app/bin/server /app/bin/server
ENV DART_VM_OPTIONS=--root-certs-file=/certs/cacert.pem
CMD ["/app/bin/server"]
```

`--root-certs-cache=<dir>` does the same for a directory of `c_rehash`-style hashed certificate files. Either option replaces the system lookup entirely: steps 2 and 3 are skipped, so the file you pass is the whole trust store. Use a maintained bundle such as the Mozilla-derived [`cacert.pem` published by curl](https://curl.se/docs/caextract.html), and keep it updated.

### 5. Load the bundle from code

If you would rather make the program self-sufficient, add roots to the default context at startup. `SecurityContext.defaultContext` is what `HttpClient`, `package:http`'s `IOClient` and most other clients use when you do not pass a context:

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

For a fully scoped setup, build a context that trusts only your bundle and hand it to the client:

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

This is the right tool for pinning a private CA for one service. As a general fix for public endpoints it just recreates the fallback bundle you lost, now with you responsible for updating it, so prefer options 1 or 2.

## How to confirm the image has no trust store

`FROM scratch` and distroless images have no shell, so `docker run ... ls` will not work. Copy the path out of a stopped container instead:

```bash
docker create --name probe my-dart-app:latest
docker cp probe:/etc/ssl/certs/ca-certificates.crt - | tar -tv
docker rm probe
```

If `docker cp` says `Could not find the file`, check the other four bundle paths from the list above. If none exist and `/etc/ssl/certs` is missing or empty, you found the cause. For images with a shell, `ls -la /etc/ssl/certs | head` is enough.

## Gotchas and lookalikes

- **`SSL_CERT_FILE` and `SSL_CERT_DIR` do nothing.** Those environment variables are an OpenSSL convention. The Dart VM uses BoringSSL and its own hard-coded path list, so exporting them has no effect. Use `DART_VM_OPTIONS=--root-certs-file=...` instead.
- **Corporate TLS inspection is a different problem.** If a proxy re-signs traffic with an internal CA, you get the same message on every Dart version, because the Mozilla fallback never contained that CA. Add the CA to the system store (`COPY corp-root.crt /usr/local/share/ca-certificates/` then `update-ca-certificates`) or load it with `setTrustedCertificates`.
- **Self-signed and incomplete chains fail with the same message.** If only one host fails while `https://pub.dev` works, the server is probably not sending its intermediate certificate. Fix the server. Do not add `badCertificateCallback: (_, _, _) => true`, because that disables verification for everything the client talks to.
- **`dart pub get` fails too** in a custom image that installs the SDK zip onto a base without `ca-certificates`. The build stage is then the one that needs the package, with the same fix.
- **Alpine is not a way out.** `dart compile exe` output links against glibc, so a musl image fails before it ever gets to TLS. Stay on a glibc base.
- **Flutter mobile apps are not affected.** Android loads `/system/etc/security/cacerts` directly and never used the fallback, and iOS evaluates trust through the Security framework. The change matters for the standalone VM on Linux: servers, CLIs and backends compiled with `dart compile exe`.

## Related

- If the same containerised CI also prints pub warnings, [the advisories decode error from pub.dev](/2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev/) is a separate, harmless message.
- For a Dart backend that runs outside a long-lived container, the [experimental Dart support in Firebase Cloud Functions](/2026/05/dart-cloud-functions-firebase-experimental/) also ends up as a compiled Dart binary inside a Linux container, so check its base image the same way.
- The trade-offs of a tiny runtime stage are very similar on the .NET side; see [framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).
- If the failing call is gRPC, [the traps of gRPC in containers](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) cover TLS and HTTP/2 issues that look similar from the client side.

## Sources

- [dart-lang/sdk#64060: CERTIFICATE_VERIFY_FAILED on dart:3.13.0 (dart:stable) image](https://github.com/dart-lang/sdk/issues/64060)
- [Dart SDK CHANGELOG, 3.13.0 "Dart Runtime" section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Commit 7e5b075680: Reland "[standalone] Remove the fallback root certificates."](https://github.com/dart-lang/sdk/commit/7e5b075680)
- [`runtime/bin/security_context_linux.cc` at 3.13.5](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/security_context_linux.cc)
- [`runtime/bin/main_impl.cc` and `main_options.cc` at 3.13.5 (`DART_VM_OPTIONS` handling)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/main_options.cc)
- [dart-lang/dart-docker `stable/trixie/Dockerfile`](https://github.com/dart-lang/dart-docker/blob/main/stable/trixie/Dockerfile)
- [`SecurityContext` API reference](https://api.dart.dev/dart-io/SecurityContext-class.html)
