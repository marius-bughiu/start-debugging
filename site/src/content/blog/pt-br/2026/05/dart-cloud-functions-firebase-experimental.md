---
title: "Cloud Functions for Firebase agora fala Dart (experimental)"
description: "O Firebase lançou suporte experimental a Dart para Cloud Functions em 2026-05-06. Triggers HTTPS e callable, cold starts AOT e a Firebase CLI cuida da compilação."
pubDate: 2026-05-19
tags:
  - "dart"
  - "flutter"
  - "firebase"
  - "cloud-functions"
  - "backend"
lang: "pt-br"
translationOf: "2026/05/dart-cloud-functions-firebase-experimental"
translatedBy: "claude"
translationDate: 2026-05-19
---

Em 2026-05-06 o time do Firebase [anunciou o suporte experimental a Dart](https://firebase.blog/posts/2026/05/dart-functions-exp) para Cloud Functions, poucos dias antes do Google I/O 2026. Para os times Flutter que vinham escrevendo backends em TypeScript por necessidade, esse é o primeiro caminho oficial para uma stack 100% Dart no Firebase, com a Firebase CLI cuidando da compilação e da implantação de ponta a ponta.

## Por que isso importa para times Flutter

Hoje um app Flutter típico manda sua lógica de servidor para Cloud Functions escritas em Node.js ou Python. Isso significa duas linguagens, dois sistemas de tipos, dois conjuntos de regras de validação e uma troca de contexto constante ao modelar o mesmo objeto de domínio nos dois lados. Com funções nativas em Dart você pode colocar suas classes de dados compartilhadas, validadores e tipos de resultado em um único `package:` e consumi-los tanto do app quanto do backend sem uma camada de tradução.

O time do Firebase também destaca o cold start como uma decisão deliberada de design. Como a Firebase CLI compila sua função localmente com `dart compile exe` e sobe o binário AOT direto para o Cloud Run, não existe fase de aquecimento da VM. Os primeiros números do post de lançamento falam em cold starts em torno de 10 ms, bem abaixo do desempenho típico de TypeScript no Node.js.

## Pré-requisitos e a flag experimental

Segundo o [guia oficial de início](https://firebase.google.com/docs/functions/start-dart), você precisa:

- Dart SDK 3.9 ou superior
- Firebase CLI 15.15.0 ou superior

O recurso fica atrás de uma flag experimental, então você ativa uma vez por máquina:

```bash
firebase experiments:enable dartfunctions
firebase init functions
```

Quando o assistente de init perguntar a linguagem, Dart aparece junto com JavaScript, TypeScript e Python.

## Uma função HTTPS mínima

O scaffold gerado deixa um `functions/bin/server.dart` com um trigger HTTPS. O formato é próximo ao do SDK JS, mas lê como Dart idiomático:

```dart
import 'package:firebase_functions/firebase_functions.dart';

void main(List<String> args) {
  runFunctions((firebase) {
    firebase.https.onRequest(
      name: 'hello',
      (request) async {
        return Response.ok('Hello from Dart!');
      },
    );
  });
}
```

Implante com o comando de sempre e a CLI compila e envia o binário para você:

```bash
firebase deploy --only functions
```

Para iterar localmente, `firebase emulators:start` funciona igual ao Node.js. Edições em quente nos arquivos Dart recarregam a função emulada sem reiniciar o suite.

## O que ainda não dá para fazer

É uma versão experimental e as arestas estão explícitas. Da documentação:

- Só triggers HTTPS (`onRequest`) e callable (`onCall`) podem ser implantados. Firestore, Auth, Pub/Sub e triggers agendados ainda não são suportados.
- Funções callable implantadas não podem ser invocadas pelo helper `httpsCallable` do SDK cliente. Você precisa usar `httpsCallableFromURL` com a URL completa do Cloud Run.
- Funções Dart não aparecem no Firebase Console durante essa versão prévia. Elas aparecem no Cloud Console no lugar.

Se seu backend vive em sua maior parte sobre endpoints HTTP e seu time já está mergulhado em Dart, isso basta para começar a portar um serviço real. Se você depende de triggers do Firestore ou de jobs agendados, vale acompanhar o [repo firebase-functions-dart](https://github.com/firebase/firebase-functions-dart) e o [Dart Admin SDK](https://pub.dev/packages/firebase_admin), mas continuar no runtime do Node.js por enquanto.

Espere mais sobre o tema no Google I/O 2026, onde o time do Flutter tem uma [breakout session](https://io.google/2026/explore/pa-keynote-12) ligada ao anúncio.
