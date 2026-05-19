---
title: "Cloud Functions for Firebase Now Speaks Dart (Experimental)"
description: "Firebase shipped experimental Dart support for Cloud Functions on May 6, 2026. HTTPS and callable triggers, AOT-compiled cold starts, and the Firebase CLI handles compilation."
pubDate: 2026-05-19
tags:
  - "dart"
  - "flutter"
  - "firebase"
  - "cloud-functions"
  - "backend"
---

On May 6, 2026 the Firebase team [announced experimental Dart support](https://firebase.blog/posts/2026/05/dart-functions-exp) for Cloud Functions, days ahead of Google I/O 2026. For Flutter teams that have been writing TypeScript backends out of necessity, this is the first official path to a Dart-only stack on Firebase, with the Firebase CLI handling compilation and deployment end to end.

## Why This Is a Big Deal for Flutter Shops

Today a typical Flutter app sends its server logic to Cloud Functions written in Node.js or Python. That means two languages, two type systems, two sets of validation rules, and a constant context switch when modelling the same domain object on both sides. With native Dart functions you can put your shared data classes, validators, and result types in a single `package:` and consume them from both the app and the backend without a translation layer.

The Firebase team also calls out cold start as a deliberate design point. Because the Firebase CLI compiles your function locally with `dart compile exe` and uploads the AOT binary directly to Cloud Run, there is no VM warm-up phase. Early numbers from the launch post talk about cold starts around 10 ms, well below the typical Node.js TypeScript baseline.

## Prerequisites and the Experiment Flag

According to the [official getting-started guide](https://firebase.google.com/docs/functions/start-dart), you need:

- Dart SDK 3.9 or higher
- Firebase CLI 15.15.0 or higher

The feature is gated behind an experiment flag, so you opt in once per machine:

```bash
firebase experiments:enable dartfunctions
firebase init functions
```

When the init wizard asks for a language, Dart now appears alongside JavaScript, TypeScript, and Python.

## A Minimal HTTPS Function

The generated scaffold drops a `functions/bin/server.dart` with one HTTPS trigger. The shape is close to the JS SDK but reads like idiomatic Dart:

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

Deploy with the usual command and the CLI will compile and ship the binary for you:

```bash
firebase deploy --only functions
```

For local iteration, `firebase emulators:start` works the same way it does for Node.js. Hot edits to your Dart files reload the emulated function without restarting the suite.

## What You Cannot Do Yet

This is an experimental release and the rough edges are explicit. From the docs:

- Only HTTPS (`onRequest`) and callable (`onCall`) triggers can deploy. Firestore, Auth, Pub/Sub, and scheduled triggers are not yet supported.
- Deployed callable functions cannot be invoked through the client SDK's `httpsCallable` helper. You have to use `httpsCallableFromURL` with the full Cloud Run URL.
- Dart functions do not show up in the Firebase Console during this preview. They appear in the Cloud Console instead.

If your backend lives mostly on HTTP endpoints and your team is already deep in Dart, this is enough to start porting a real service. If you depend on Firestore triggers or scheduled jobs, it is worth tracking the [firebase-functions-dart repo](https://github.com/firebase/firebase-functions-dart) and the [Dart Admin SDK](https://pub.dev/packages/firebase_admin) but staying on the Node.js runtime for now.

Expect more on this at Google I/O 2026, where the Flutter team has a [breakout session](https://io.google/2026/explore/pa-keynote-12) tied to the announcement.
