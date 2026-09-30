---
title: "Correção: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate em uma imagem Docker do Dart 3.13"
description: "O Dart 3.13 removeu os certificados raiz de fallback embutidos na VM. Coloque um bundle de CA na imagem de runtime: COPY /runtime/ de dart:stable ou instale ca-certificates."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "docker"
  - "tls"
  - "dart-3-13"
lang: "pt-br"
translationOf: "2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image"
translatedBy: "claude"
translationDate: 2026-09-30
---

Seu Dockerfile não mudou. O Dart mudou. A partir do Dart 3.13.0 (o SDK do Flutter 3.47.0 e o que está por trás da tag `dart:stable` desde agosto de 2026, atualmente 3.13.5), a VM standalone não traz mais um conjunto de certificados raiz de fallback compilado no binário. Se a imagem em que seu app roda não tem um bundle de CA em um dos caminhos padrão do Linux, toda chamada HTTPS agora falha no handshake. Corrija dando ao estágio de runtime um trust store: mantenha `COPY --from=build /runtime/ /` em um estágio `FROM scratch`, ou use `apt-get install ca-certificates` em uma imagem base slim. Se você não pode alterar a imagem, aponte a VM para um arquivo PEM com `DART_VM_OPTIONS=--root-certs-file=/path/to/cacert.pem`.

Tudo abaixo se baseia no código-fonte do Dart SDK nas tags `3.12.2`, `3.13.0` e `3.13.5`, no Dockerfile `stable/trixie` de `dart-lang/dart-docker` e na triagem de [dart-lang/sdk#64060](https://github.com/dart-lang/sdk/issues/64060), onde a equipe do Dart confirmou que o comportamento é intencional.

## O erro em contexto

O app compila normalmente e inicia normalmente. A primeira conexão TLS de saída, seja por `HttpClient`, `package:http`, `dio`, um canal gRPC ou um driver de banco de dados, lança:

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:320))

#0      _SecureFilterImpl._handshake (dart:io-patch/secure_socket_patch.dart:101)
#1      _SecureFilterImpl.handshake (dart:io-patch/secure_socket_patch.dart:146)
#2      _RawSecureSocket._secureHandshake (dart:io/secure_socket.dart:995)
#3      _RawSecureSocket._tryFilter (dart:io/secure_socket.dart:1127)
<asynchronous suspension>
```

O indício é o momento em que aparece. O mesmo código, o mesmo Dockerfile e o mesmo endpoint funcionavam com `dart:3.12.2`. Fixar o estágio de build de volta em `dart:3.12.2` faz o erro desaparecer, que foi exatamente o que o autor do #64060 fez antes de descobrir a causa. Endpoints com certificados públicos perfeitamente válidos (pub.dev, googleapis.com, sua própria API com Let's Encrypt) falham do mesmo jeito que os autoassinados, porque o problema não é a cadeia do servidor. O cliente não confia em absolutamente nada.

## Por que o Dart 3.13 deixou de confiar em qualquer coisa em uma imagem vazia

No Linux, `SSLCertContext::TrustBuiltinRoots()` em `runtime/bin/security_context_linux.cc` procura raízes confiáveis em uma ordem fixa:

1. A opção `--root-certs-file` ou `--root-certs-cache`, se você a passou.
2. O primeiro arquivo de bundle que existir entre `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/pki/tls/cacert.pem` e `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`.
3. O primeiro diretório que existir entre `/etc/ssl/certs`, `/system/etc/security/cacerts`, `/usr/local/share/certs`, `/etc/pki/tls/certs` e `/etc/openssl/certs`.
4. Como último recurso, `AddCompiledInCerts()`, que carrega um bundle de raízes da Mozilla embutido nos binários `dart` e `dartaotruntime` (e, portanto, em toda saída de `dart compile exe`).

O passo 4 é o que mudou. O changelog do Dart 3.13.0 diz isso em uma linha na seção "Dart Runtime": os certificados raiz de fallback embutidos "are no longer included". O commit do SDK é [`7e5b075680`](https://github.com/dart-lang/sdk/commit/7e5b075680), "Reland [standalone] Remove the fallback root certificates", integrado em 2026-06-01 após uma primeira tentativa em maio ter sido revertida. A função ainda existe no 3.13, mas `runtime/bin/BUILD.gn` não inclui mais `third_party/fallback_root_certificates` e define incondicionalmente `DART_IO_ROOT_CERTS_DISABLED`, então `root_certificates_pem` é nulo e a função retorna sem adicionar nada.

Por anos esse fallback cobriu silenciosamente imagens de runtime sem bundle de CA. Um estágio `FROM scratch` que copiava apenas o binário compilado funcionava porque o binário carregava suas próprias raízes. Uma base `debian:trixie-slim` sem `ca-certificates` funcionava pelo mesmo motivo. No 3.13 essas imagens acabam com um `X509_STORE` vazio, e o BoringSSL reporta o primeiro certificado de qualquer cadeia como tendo um emissor desconhecido.

Dois detalhes tornam isso mais confuso do que deveria:

- **A imagem `dart:stable` em si está correta.** O Dockerfile dela instala `ca-certificates`, e o diretório `/runtime/` que ela prepara para builds multi-stage inclui `/etc/ssl/certs` e `/usr/share/ca-certificates`, copiados com `--dereference` para que os links simbólicos sobrevivam. Se você vê o erro, quase sempre o processo que falha está rodando em uma imagem *diferente* daquela com que você compilou. No #64060 o build usou `dart:3.13.0`, mas o pod rodava em uma imagem `docker:19.03.15` / `ubuntu:xenial` de cinco anos atrás.
- **Um diretório `/etc/ssl/certs` vazio é pior que um ausente.** O passo 3 só verifica se o diretório existe, não se ele contém algo. Algumas imagens base trazem o diretório sem os certificados, então a VM "carrega" zero raízes dele sem reclamar.

## Reprodução mínima

Um programa Dart que faz uma única requisição HTTPS:

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

E um Dockerfile multi-stage que copia apenas o executável para o estágio final, um formato comum em Dockerfiles escritos à mão e em templates de CI anteriores ao oficial:

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

Compilado com `dart:3.12.2`, isso imprime `status: 200`, graças às raízes embutidas. Compilado com `dart:3.13.0` ou posterior, lança a `HandshakeException` acima, porque `debian:trixie-slim` não inclui o pacote `ca-certificates`.

## A correção em detalhes

Escolha a primeira opção que couber na sua imagem. Todas dão à VM um trust store de verdade; nenhuma desativa a verificação.

### 1. Mantenha a cópia oficial de `/runtime/` em um estágio `FROM scratch`

Este é o layout que a [documentação da imagem oficial `dart`](https://hub.docker.com/_/dart) recomenda, e ele já traz os certificados:

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

Se o seu estágio final é `FROM scratch` e o único `COPY` é o binário, adicione a linha do `/runtime/`. Além dos certificados, ela também traz o loader da glibc, `libnss_dns` e `/etc/nsswitch.conf`, então corrige problemas de resolução de DNS que você talvez ainda não tenha encontrado.

### 2. Instale `ca-certificates` em uma imagem de runtime slim

Se você usa `debian:*-slim` ou `ubuntu:*`, instale o pacote no estágio final:

```dockerfile
# Dart 3.13.5 AOT binary on debian:trixie-slim
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

O script de pós-instalação do pacote gera `/etc/ssl/certs/ca-certificates.crt`, que é o primeiro caminho que a VM verifica. Você não precisa de uma chamada separada a `update-ca-certificates`, a menos que esteja adicionando seus próprios certificados (veja abaixo). Em imagens RHEL, UBI ou Fedora, o pacote equivalente também se chama `ca-certificates` e produz `/etc/pki/tls/certs/ca-bundle.crt`, que também está na lista.

Distroless também funciona: `gcr.io/distroless/cc-debian12` traz `/etc/ssl/certs/ca-certificates.crt` e a glibc de que um binário AOT do Dart precisa.

### 3. Atualize uma imagem base antiga

Se a imagem de runtime tem `ca-certificates`, mas é muito antiga, o bundle é anterior às raízes às quais as CAs mais novas se encadeiam. Essa era a situação real no #64060. Migrar para uma imagem base atual é a correção. Atualizar o pacote no lugar (`apt-get update && apt-get install --only-upgrade ca-certificates`) só funciona enquanto a distribuição ainda publica atualizações.

### 4. Aponte a VM para um bundle com `DART_VM_OPTIONS`

Quando você não pode mexer na imagem, mas pode montar um arquivo ou definir uma variável de ambiente (a especificação de um pod do Kubernetes, um runtime gerenciado), use `--root-certs-file`. Para JIT (`dart run`, `dart bin/server.dart`) ela é uma opção normal da VM:

```bash
dart --root-certs-file=/certs/cacert.pem bin/server.dart
```

Um binário de `dart compile exe` ignora a própria linha de comando para opções da VM, já que todo argumento vai para o seu `main`. Ele lê `DART_VM_OPTIONS`, uma lista separada por vírgulas processada em `main_impl.cc` apenas para executáveis com snapshot anexado, e `--root-certs-file` é uma das opções que ele aceita:

```dockerfile
# Dart 3.13.5 AOT binary, CA bundle supplied explicitly
FROM debian:trixie-slim
COPY cacert.pem /certs/cacert.pem
COPY --from=build /app/bin/server /app/bin/server
ENV DART_VM_OPTIONS=--root-certs-file=/certs/cacert.pem
CMD ["/app/bin/server"]
```

`--root-certs-cache=<dir>` faz o mesmo para um diretório de arquivos de certificado com hash no estilo `c_rehash`. Qualquer uma das opções substitui completamente a busca no sistema: os passos 2 e 3 são pulados, então o arquivo que você passa é o trust store inteiro. Use um bundle mantido, como o [`cacert.pem` publicado pelo curl](https://curl.se/docs/caextract.html), derivado da Mozilla, e mantenha-o atualizado.

### 5. Carregue o bundle pelo código

Se você prefere tornar o programa autossuficiente, adicione raízes ao contexto padrão na inicialização. `SecurityContext.defaultContext` é o que `HttpClient`, o `IOClient` do `package:http` e a maioria dos outros clientes usam quando você não passa um contexto:

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

Para uma configuração totalmente delimitada, crie um contexto que confie apenas no seu bundle e entregue-o ao cliente:

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

Esta é a ferramenta certa para fixar uma CA privada em um único serviço. Como correção geral para endpoints públicos, ela apenas recria o bundle de fallback que você perdeu, agora com você responsável por atualizá-lo, então prefira as opções 1 ou 2.

## Como confirmar que a imagem não tem trust store

Imagens `FROM scratch` e distroless não têm shell, então `docker run ... ls` não funciona. Copie o caminho de um contêiner parado:

```bash
docker create --name probe my-dart-app:latest
docker cp probe:/etc/ssl/certs/ca-certificates.crt - | tar -tv
docker rm probe
```

Se o `docker cp` disser `Could not find the file`, verifique os outros quatro caminhos de bundle da lista acima. Se nenhum existir e `/etc/ssl/certs` estiver ausente ou vazio, você encontrou a causa. Para imagens com shell, `ls -la /etc/ssl/certs | head` é suficiente.

## Pegadinhas e casos parecidos

- **`SSL_CERT_FILE` e `SSL_CERT_DIR` não fazem nada.** Essas variáveis de ambiente são uma convenção do OpenSSL. A VM do Dart usa BoringSSL e sua própria lista fixa de caminhos, então exportá-las não tem efeito. Use `DART_VM_OPTIONS=--root-certs-file=...` no lugar.
- **Inspeção de TLS corporativa é um problema diferente.** Se um proxy reassina o tráfego com uma CA interna, você recebe a mesma mensagem em todas as versões do Dart, porque o fallback da Mozilla nunca continha essa CA. Adicione a CA ao store do sistema (`COPY corp-root.crt /usr/local/share/ca-certificates/` e depois `update-ca-certificates`) ou carregue-a com `setTrustedCertificates`.
- **Cadeias autoassinadas e incompletas falham com a mesma mensagem.** Se apenas um host falha enquanto `https://pub.dev` funciona, o servidor provavelmente não está enviando seu certificado intermediário. Corrija o servidor. Não adicione `badCertificateCallback: (_, _, _) => true`, porque isso desativa a verificação para tudo com que o cliente se comunica.
- **`dart pub get` também falha** em uma imagem personalizada que instala o zip do SDK sobre uma base sem `ca-certificates`. Nesse caso é o estágio de build que precisa do pacote, com a mesma correção.
- **Alpine não é uma saída.** A saída de `dart compile exe` é vinculada à glibc, então uma imagem musl falha antes mesmo de chegar ao TLS. Fique em uma base com glibc.
- **Apps móveis Flutter não são afetados.** O Android carrega `/system/etc/security/cacerts` diretamente e nunca usou o fallback, e o iOS avalia a confiança pelo framework Security. A mudança importa para a VM standalone no Linux: servidores, CLIs e backends compilados com `dart compile exe`.

## Relacionado

- Se o mesmo CI em contêineres também imprime avisos do pub, [o erro de decodificação de advisories do pub.dev](/pt-br/2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev/) é uma mensagem separada e inofensiva.
- Para um backend Dart que roda fora de um contêiner de longa duração, o [suporte experimental a Dart no Firebase Cloud Functions](/pt-br/2026/05/dart-cloud-functions-firebase-experimental/) também acaba como um binário Dart compilado dentro de um contêiner Linux, então verifique a imagem base dele da mesma forma.
- Os trade-offs de um estágio de runtime minúsculo são muito parecidos no lado .NET; veja [framework-dependent vs self-contained vs Native AOT para uma imagem de contêiner .NET 11](/pt-br/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/).
- Se a chamada que falha é gRPC, [as armadilhas do gRPC em contêineres](/pt-br/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) cobrem problemas de TLS e HTTP/2 que parecem semelhantes do lado do cliente.

## Fontes

- [dart-lang/sdk#64060: CERTIFICATE_VERIFY_FAILED on dart:3.13.0 (dart:stable) image](https://github.com/dart-lang/sdk/issues/64060)
- [Dart SDK CHANGELOG, 3.13.0 "Dart Runtime" section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Commit 7e5b075680: Reland "[standalone] Remove the fallback root certificates."](https://github.com/dart-lang/sdk/commit/7e5b075680)
- [`runtime/bin/security_context_linux.cc` at 3.13.5](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/security_context_linux.cc)
- [`runtime/bin/main_impl.cc` and `main_options.cc` at 3.13.5 (`DART_VM_OPTIONS` handling)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/main_options.cc)
- [dart-lang/dart-docker `stable/trixie/Dockerfile`](https://github.com/dart-lang/dart-docker/blob/main/stable/trixie/Dockerfile)
- [`SecurityContext` API reference](https://api.dart.dev/dart-io/SecurityContext-class.html)
