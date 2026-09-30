---
title: "Solución: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate en una imagen Docker de Dart 3.13"
description: "Dart 3.13 eliminó los certificados raíz de respaldo integrados en la VM. Incluye un paquete de CA en la imagen de runtime: COPY /runtime/ desde dart:stable o instala ca-certificates."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "docker"
  - "tls"
  - "dart-3-13"
lang: "es"
translationOf: "2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image"
translatedBy: "claude"
translationDate: 2026-09-30
---

Tu Dockerfile no cambió. Dart sí. A partir de Dart 3.13.0 (el SDK de Flutter 3.47.0 y el que está detrás de la etiqueta `dart:stable` desde agosto de 2026, actualmente 3.13.5), la VM independiente ya no incluye un conjunto de certificados raíz de respaldo compilado en el binario. Si la imagen en la que se ejecuta tu aplicación no tiene un paquete de CA en una de las rutas estándar de Linux, todas las llamadas HTTPS fallan en el handshake. Se soluciona dando a la etapa de runtime un almacén de confianza: conserva `COPY --from=build /runtime/ /` en una etapa `FROM scratch`, o ejecuta `apt-get install ca-certificates` en una imagen base slim. Si no puedes cambiar la imagen, apunta la VM a un archivo PEM con `DART_VM_OPTIONS=--root-certs-file=/path/to/cacert.pem`.

Todo lo que sigue se basa en el código fuente del SDK de Dart en las etiquetas `3.12.2`, `3.13.0` y `3.13.5`, el Dockerfile `stable/trixie` de `dart-lang/dart-docker` y el análisis de [dart-lang/sdk#64060](https://github.com/dart-lang/sdk/issues/64060), donde el equipo de Dart confirmó que el comportamiento es intencional.

## El error en contexto

La aplicación se compila bien y arranca bien. La primera conexión TLS saliente, ya sea mediante `HttpClient`, `package:http`, `dio`, un canal gRPC o un controlador de base de datos, lanza:

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:320))

#0      _SecureFilterImpl._handshake (dart:io-patch/secure_socket_patch.dart:101)
#1      _SecureFilterImpl.handshake (dart:io-patch/secure_socket_patch.dart:146)
#2      _RawSecureSocket._secureHandshake (dart:io/secure_socket.dart:995)
#3      _RawSecureSocket._tryFilter (dart:io/secure_socket.dart:1127)
<asynchronous suspension>
```

La pista es el momento en que aparece. El mismo código, el mismo Dockerfile y el mismo endpoint funcionaban en `dart:3.12.2`. Fijar la etapa de compilación de nuevo a `dart:3.12.2` hace desaparecer el error, que es exactamente lo que hizo quien reportó #64060 antes de descubrir la causa. Los endpoints con certificados públicos perfectamente válidos (pub.dev, googleapis.com, tu propia API con Let's Encrypt) fallan igual que los autofirmados, porque el problema no es la cadena del servidor. El cliente no confía en absolutamente nada.

## Por qué Dart 3.13 dejó de confiar en algo en una imagen vacía

En Linux, `SSLCertContext::TrustBuiltinRoots()` en `runtime/bin/security_context_linux.cc` busca raíces de confianza en un orden fijo:

1. La opción `--root-certs-file` o `--root-certs-cache`, si pasaste alguna.
2. El primer archivo de paquete que exista entre `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/pki/tls/cacert.pem` y `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`.
3. El primer directorio que exista entre `/etc/ssl/certs`, `/system/etc/security/cacerts`, `/usr/local/share/certs`, `/etc/pki/tls/certs` y `/etc/openssl/certs`.
4. Como último recurso, `AddCompiledInCerts()`, que carga un paquete de raíces de Mozilla incluido en los binarios `dart` y `dartaotruntime` (y por lo tanto en cada salida de `dart compile exe`).

El paso 4 es lo que cambió. El registro de cambios de Dart 3.13.0 lo dice en una línea bajo "Dart Runtime": los certificados raíz de respaldo integrados "are no longer included". El commit del SDK es [`7e5b075680`](https://github.com/dart-lang/sdk/commit/7e5b075680), "Reland [standalone] Remove the fallback root certificates", integrado el 2026-06-01 después de un primer intento en mayo que se revirtió. La función sigue existiendo en 3.13, pero `runtime/bin/BUILD.gn` ya no incluye `third_party/fallback_root_certificates` y define incondicionalmente `DART_IO_ROOT_CERTS_DISABLED`, así que `root_certificates_pem` es nulo y la función retorna sin agregar nada.

Durante años ese respaldo cubrió en silencio a las imágenes de runtime que no tenían un paquete de CA. Una etapa `FROM scratch` que copiaba solo el binario compilado funcionaba porque el binario llevaba sus propias raíces. Una base `debian:trixie-slim` sin `ca-certificates` funcionaba por la misma razón. En 3.13 esas imágenes terminan con un `X509_STORE` vacío, y BoringSSL informa que el primer certificado de cualquier cadena tiene un emisor desconocido.

Dos detalles lo hacen más confuso de lo que debería:

- **La imagen `dart:stable` en sí está bien.** Su Dockerfile instala `ca-certificates`, y el directorio `/runtime/` que prepara para las compilaciones multietapa incluye `/etc/ssl/certs` y `/usr/share/ca-certificates`, copiados con `--dereference` para que los enlaces simbólicos sobrevivan. Si ves el error, el proceso que falla casi siempre se está ejecutando en una imagen *distinta* a la que usaste para compilar. En #64060 la compilación usó `dart:3.13.0`, pero el pod se ejecutaba en una imagen `docker:19.03.15` / `ubuntu:xenial` de hace cinco años.
- **Un directorio `/etc/ssl/certs` vacío es peor que uno inexistente.** El paso 3 solo comprueba que el directorio exista, no que contenga algo. Algunas imágenes base incluyen el directorio sin los certificados, así que la VM "carga" alegremente cero raíces desde él.

## Reproducción mínima

Un programa Dart que hace una solicitud HTTPS:

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

Y un Dockerfile multietapa que copia solo el ejecutable a la etapa final, una forma común en Dockerfiles escritos a mano y en plantillas de CI anteriores a la oficial:

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

Compilado con `dart:3.12.2` imprime `status: 200`, gracias a las raíces integradas. Compilado con `dart:3.13.0` o posterior lanza la `HandshakeException` de arriba, porque `debian:trixie-slim` no incluye el paquete `ca-certificates`.

## La solución en detalle

Elige la primera opción que encaje con tu imagen. Todas dan a la VM un almacén de confianza real; ninguna desactiva la verificación.

### 1. Conserva la copia oficial de `/runtime/` en una etapa `FROM scratch`

Este es el diseño que recomienda la [documentación de la imagen oficial `dart`](https://hub.docker.com/_/dart), y ya incluye los certificados:

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

Si tu etapa final es `FROM scratch` y el único `COPY` es el binario, agrega la línea de `/runtime/`. Además de los certificados, también trae el cargador de glibc, `libnss_dns` y `/etc/nsswitch.conf`, así que corrige problemas de resolución DNS que quizás aún no hayas encontrado.

### 2. Instala `ca-certificates` en una imagen de runtime slim

Si ejecutas en `debian:*-slim` o `ubuntu:*`, instala el paquete en la etapa final:

```dockerfile
# Dart 3.13.5 AOT binary on debian:trixie-slim
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

El script de posinstalación del paquete genera `/etc/ssl/certs/ca-certificates.crt`, que es la primera ruta que revisa la VM. No necesitas una llamada aparte a `update-ca-certificates` a menos que estés agregando tus propios certificados (ver más abajo). En imágenes RHEL, UBI o Fedora el paquete equivalente también se llama `ca-certificates`, y produce `/etc/pki/tls/certs/ca-bundle.crt`, que también está en la lista.

Distroless también funciona: `gcr.io/distroless/cc-debian12` incluye `/etc/ssl/certs/ca-certificates.crt` y la glibc que necesita un binario AOT de Dart.

### 3. Actualiza una imagen base antigua

Si la imagen de runtime tiene `ca-certificates` pero tiene años, el paquete es anterior a las raíces a las que se encadenan las CA más nuevas. Esa fue la situación real en #64060. La solución es pasar a una imagen base actual. Actualizar el paquete en el lugar (`apt-get update && apt-get install --only-upgrade ca-certificates`) solo funciona mientras la distribución siga publicando actualizaciones.

### 4. Apunta la VM a un paquete con `DART_VM_OPTIONS`

Cuando no puedes tocar la imagen, pero sí montar un archivo o definir una variable de entorno (la especificación de un pod de Kubernetes, un runtime administrado), usa `--root-certs-file`. Para JIT (`dart run`, `dart bin/server.dart`) es una opción normal de la VM:

```bash
dart --root-certs-file=/certs/cacert.pem bin/server.dart
```

Un binario de `dart compile exe` ignora su propia línea de comandos para las opciones de la VM, ya que todos los argumentos van a tu `main`. Sí lee `DART_VM_OPTIONS`, una lista separada por comas que `main_impl.cc` analiza solo para ejecutables con un snapshot adjunto, y `--root-certs-file` es una de las opciones que acepta:

```dockerfile
# Dart 3.13.5 AOT binary, CA bundle supplied explicitly
FROM debian:trixie-slim
COPY cacert.pem /certs/cacert.pem
COPY --from=build /app/bin/server /app/bin/server
ENV DART_VM_OPTIONS=--root-certs-file=/certs/cacert.pem
CMD ["/app/bin/server"]
```

`--root-certs-cache=<dir>` hace lo mismo para un directorio de archivos de certificados con hash al estilo `c_rehash`. Cualquiera de las dos opciones reemplaza por completo la búsqueda del sistema: los pasos 2 y 3 se omiten, así que el archivo que pases es todo el almacén de confianza. Usa un paquete mantenido, como el [`cacert.pem` derivado de Mozilla que publica curl](https://curl.se/docs/caextract.html), y mantenlo actualizado.

### 5. Carga el paquete desde código

Si prefieres que el programa sea autosuficiente, agrega raíces al contexto predeterminado al inicio. `SecurityContext.defaultContext` es lo que usan `HttpClient`, el `IOClient` de `package:http` y la mayoría de los demás clientes cuando no les pasas un contexto:

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

Para una configuración totalmente acotada, crea un contexto que confíe solo en tu paquete y pásalo al cliente:

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

Es la herramienta adecuada para fijar una CA privada para un servicio. Como solución general para endpoints públicos, solo recrea el paquete de respaldo que perdiste, ahora con la responsabilidad de actualizarlo a tu cargo, así que prefiere las opciones 1 o 2.

## Cómo confirmar que la imagen no tiene almacén de confianza

Las imágenes `FROM scratch` y distroless no tienen shell, así que `docker run ... ls` no funcionará. Copia la ruta desde un contenedor detenido:

```bash
docker create --name probe my-dart-app:latest
docker cp probe:/etc/ssl/certs/ca-certificates.crt - | tar -tv
docker rm probe
```

Si `docker cp` dice `Could not find the file`, revisa las otras cuatro rutas de paquete de la lista anterior. Si ninguna existe y `/etc/ssl/certs` no existe o está vacío, encontraste la causa. Para imágenes con shell, basta con `ls -la /etc/ssl/certs | head`.

## Trampas y casos parecidos

- **`SSL_CERT_FILE` y `SSL_CERT_DIR` no hacen nada.** Esas variables de entorno son una convención de OpenSSL. La VM de Dart usa BoringSSL y su propia lista de rutas fija, así que exportarlas no tiene efecto. Usa `DART_VM_OPTIONS=--root-certs-file=...` en su lugar.
- **La inspección TLS corporativa es un problema distinto.** Si un proxy vuelve a firmar el tráfico con una CA interna, obtienes el mismo mensaje en cualquier versión de Dart, porque el respaldo de Mozilla nunca contuvo esa CA. Agrega la CA al almacén del sistema (`COPY corp-root.crt /usr/local/share/ca-certificates/` y luego `update-ca-certificates`) o cárgala con `setTrustedCertificates`.
- **Las cadenas autofirmadas e incompletas fallan con el mismo mensaje.** Si solo falla un host mientras `https://pub.dev` funciona, probablemente el servidor no está enviando su certificado intermedio. Corrige el servidor. No agregues `badCertificateCallback: (_, _, _) => true`, porque eso desactiva la verificación para todo con lo que habla el cliente.
- **`dart pub get` también falla** en una imagen personalizada que instala el zip del SDK sobre una base sin `ca-certificates`. En ese caso la etapa de compilación es la que necesita el paquete, con la misma solución.
- **Alpine no es una salida.** La salida de `dart compile exe` enlaza contra glibc, así que una imagen musl falla antes de llegar a TLS. Quédate en una base con glibc.
- **Las aplicaciones móviles de Flutter no se ven afectadas.** Android carga `/system/etc/security/cacerts` directamente y nunca usó el respaldo, e iOS evalúa la confianza mediante el framework Security. El cambio afecta a la VM independiente en Linux: servidores, CLIs y backends compilados con `dart compile exe`.

## Relacionado

- Si el mismo CI en contenedores también imprime advertencias de pub, [el error de decodificación de advisories de pub.dev](/es/2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev/) es un mensaje distinto e inofensivo.
- Para un backend Dart que se ejecuta fuera de un contenedor de larga duración, el [soporte experimental de Dart en Firebase Cloud Functions](/es/2026/05/dart-cloud-functions-firebase-experimental/) también termina como un binario de Dart compilado dentro de un contenedor Linux, así que revisa su imagen base de la misma forma.
- Las ventajas y desventajas de una etapa de runtime diminuta son muy parecidas en el lado de .NET; consulta [dependiente del framework vs autocontenido vs Native AOT para una imagen de contenedor de .NET 11](/es/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).
- Si la llamada que falla es gRPC, [las trampas de gRPC en contenedores](/es/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) cubren problemas de TLS y HTTP/2 que se ven similares desde el lado del cliente.

## Fuentes

- [dart-lang/sdk#64060: CERTIFICATE_VERIFY_FAILED on dart:3.13.0 (dart:stable) image](https://github.com/dart-lang/sdk/issues/64060)
- [Dart SDK CHANGELOG, 3.13.0 "Dart Runtime" section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Commit 7e5b075680: Reland "[standalone] Remove the fallback root certificates."](https://github.com/dart-lang/sdk/commit/7e5b075680)
- [`runtime/bin/security_context_linux.cc` at 3.13.5](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/security_context_linux.cc)
- [`runtime/bin/main_impl.cc` and `main_options.cc` at 3.13.5 (`DART_VM_OPTIONS` handling)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/main_options.cc)
- [dart-lang/dart-docker `stable/trixie/Dockerfile`](https://github.com/dart-lang/dart-docker/blob/main/stable/trixie/Dockerfile)
- [`SecurityContext` API reference](https://api.dart.dev/dart-io/SecurityContext-class.html)
