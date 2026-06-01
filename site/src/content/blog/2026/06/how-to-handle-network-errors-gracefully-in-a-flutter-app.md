---
title: "How to Handle Network Errors Gracefully in a Flutter App"
description: "A request can fail with no connectivity, a timeout, a DNS failure, a 500, or malformed JSON, and each needs a different response. Here is how to catch the right exceptions, classify them, retry safely, and show a UI a user can act on."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "networking"
---

A network call in Flutter fails in at least five distinct ways, and a graceful app treats each one differently: no connectivity, a connection timeout, a DNS or socket failure, a non-2xx HTTP status, and a malformed or unexpected response body. The fix is to catch the specific exception type instead of a bare `catch (e)`, map it to a small set of user-facing states (offline, timed out, server error, retryable, fatal), wrap the call in a timeout and a bounded retry-with-backoff, and render a state the user can actually act on instead of a spinner that never resolves. This guide uses Flutter 3.44 (stable, May 2026), Dart 3.x, the `http` package 1.x, `dio` 5.9.2, and `connectivity_plus` 7.1.1.

The mistake almost every Flutter app makes early is treating "the network" as a single failure mode. You wrap the call in `try`/`catch`, show a snackbar that says "Something went wrong", and move on. But "no Wi-Fi" and "the server returned a 503" are not the same problem, and a user staring at a generic error has no idea whether to retry, wait, or give up. Worse, the most common bug is not even reaching the catch: a `Future` that never completes because there was no timeout, leaving a spinner spinning forever.

## The exceptions a Flutter HTTP call actually throws

When you use `dart:io` and the `http` package, a failed request surfaces as a typed exception, and the type tells you what went wrong:

- `SocketException` is thrown when the connection itself cannot be established or is dropped: no route to host, DNS resolution failed, connection refused, or the device is offline. This is the "the network is unreachable" bucket.
- `TimeoutException` (from `dart:async`) is thrown when you wrap a `Future` in `.timeout(...)` and the duration elapses. The `http` package does not time out on its own, so if you do not add this, a hung connection hangs your UI indefinitely.
- `HttpException` and `ClientException` cover protocol-level problems: a malformed response, a connection closed mid-response, or a redirect loop.
- `FormatException` is thrown by `jsonDecode` when the body is not valid JSON. A 200 OK with an HTML error page (a captive portal, a proxy, a misconfigured gateway) lands here, not in any of the network buckets. I covered this specific trap in [the FormatException unexpected character guide](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/).

A non-2xx status code is not an exception at all with the `http` package. `http.get` returns a `Response` with `statusCode == 500` and you have to check it yourself. This is the single most common reason an app silently shows empty data: the developer parsed `response.body` as JSON without ever looking at `response.statusCode`, and the body was an error payload.

## A repro that swallows everything

Here is the pattern to avoid. It compiles, it works on a fast connection, and it fails in every interesting way.

```dart
// Flutter 3.44, Dart 3.x, http 1.x -- anti-pattern, do not copy.
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<String>> fetchNames() async {
  try {
    final response =
        await http.get(Uri.parse('https://api.example.com/names'));
    final data = jsonDecode(response.body) as List;
    return data.cast<String>();
  } catch (e) {
    return []; // every failure looks like "no data"
  }
}
```

Three things are broken. There is no timeout, so a stalled connection hangs forever. The status code is never checked, so a 500 with a JSON error body either throws in `cast` or returns garbage. And the `catch (e)` collapses offline, timeout, server error, and bad JSON into one outcome: an empty list, indistinguishable from "the server legitimately has no names". The UI cannot tell the user anything useful because the function threw away the only information that mattered.

## Classify the failure into a result the UI can render

The first real fix is to stop returning bare data and start returning a result that encodes how the call ended. A sealed class hierarchy (Dart 3 sealed classes) makes the compiler force you to handle every case.

```dart
// Flutter 3.44, Dart 3.x
sealed class NetworkResult<T> {
  const NetworkResult();
}

class Success<T> extends NetworkResult<T> {
  final T data;
  const Success(this.data);
}

class Offline<T> extends NetworkResult<T> {
  const Offline();
}

class TimedOut<T> extends NetworkResult<T> {
  const TimedOut();
}

class ServerError<T> extends NetworkResult<T> {
  final int statusCode;
  const ServerError(this.statusCode);
}

class BadResponse<T> extends NetworkResult<T> {
  final String detail;
  const BadResponse(this.detail);
}
```

Now the data layer maps every exception type and status code onto one of these, and nothing leaks through as an unhandled throw:

```dart
// Flutter 3.44, Dart 3.x, http 1.x
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await http
        .get(Uri.parse('https://api.example.com/names'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode >= 500) {
      return ServerError(response.statusCode);
    }
    if (response.statusCode >= 400) {
      // 4xx is usually a client bug or auth issue, not retryable.
      return BadResponse('HTTP ${response.statusCode}');
    }

    final decoded = jsonDecode(response.body) as List;
    return Success(decoded.cast<String>());
  } on SocketException {
    return const Offline();
  } on TimeoutException {
    return const TimedOut();
  } on FormatException catch (e) {
    return BadResponse('Malformed JSON: ${e.message}');
  } on http.ClientException catch (e) {
    return BadResponse(e.message);
  }
}
```

Notice the order of the `on` clauses. Dart evaluates them top to bottom and runs the first match, so put the most specific exceptions first. `TimeoutException` and `SocketException` are siblings, not parent and child, so their order relative to each other does not matter, but `FormatException` and `ClientException` must come before any broad `catch`. There is deliberately no bare `catch (e)` here, because if some exception I did not anticipate is thrown, I want it to crash in debug and show up in my error reporting, not get silently mapped to `BadResponse`.

## Render every branch in the widget

Because `NetworkResult` is a sealed class, a `switch` expression in the widget is exhaustive: add a new result type and the compiler flags every `switch` that does not handle it. This is the payoff of the sealed hierarchy.

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

Widget buildBody(NetworkResult<List<String>> result, VoidCallback onRetry) {
  return switch (result) {
    Success(data: final names) => ListView(
        children: [for (final n in names) ListTile(title: Text(n))],
      ),
    Offline() => _ErrorState(
        message: 'You appear to be offline. Check your connection.',
        onRetry: onRetry,
      ),
    TimedOut() => _ErrorState(
        message: 'The request took too long. Try again.',
        onRetry: onRetry,
      ),
    ServerError(statusCode: final code) => _ErrorState(
        message: 'The server had a problem (HTTP $code). Try again shortly.',
        onRetry: onRetry,
      ),
    BadResponse(detail: final detail) => _ErrorState(
        message: 'Something went wrong. ($detail)',
        onRetry: null, // not retryable, retry will not help
      ),
  };
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: FilledButton(onPressed: onRetry, child: const Text('Retry')),
            ),
        ],
      ),
    );
  }
}
```

The distinction that matters to the user: `Offline`, `TimedOut`, and `ServerError` offer a retry button because retrying might succeed. `BadResponse` does not, because a malformed payload or a 400 will fail identically on the next attempt, and a retry button that never works is worse than no button. Keep the error widget simple so it does not introduce a second bug; an error screen that itself overflows is a bad look, and [the RenderFlex overflow guide](/2026/05/fix-renderflex-overflowed-in-flutter/) covers why that happens.

## Retry transient failures with exponential backoff

`Offline`, `TimedOut`, and `ServerError` (specifically 502, 503, 504) are transient: the same request may succeed seconds later. A graceful app retries them automatically a bounded number of times, with increasing delay so it does not hammer a struggling server. Do not retry 4xx, and do not retry forever.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'dart:io';

Future<T> withRetry<T>(
  Future<T> Function() action, {
  int maxAttempts = 3,
  Duration baseDelay = const Duration(milliseconds: 400),
}) async {
  var attempt = 0;
  while (true) {
    attempt++;
    try {
      return await action();
    } on SocketException {
      if (attempt >= maxAttempts) rethrow;
    } on TimeoutException {
      if (attempt >= maxAttempts) rethrow;
    }
    // 2^attempt backoff: 0.8s, 1.6s, 3.2s ...
    final delay = baseDelay * (1 << attempt);
    await Future<void>.delayed(delay);
  }
}
```

The `1 << attempt` is a bit shift that doubles the multiplier each round, which is the cheapest way to write exponential backoff. In production you also want jitter (a small random offset) so that a thousand clients recovering from the same outage do not all retry on the same tick and create a thundering herd, but the core shape is this loop. Wrap the HTTP call, not the whole `fetchNames`, so the retry sees the raw exception before it is mapped to a `NetworkResult`. If the work inside the retried action is CPU-heavy (decoding a huge payload, for example), push that off the UI isolate as described in [the Dart isolate guide](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), because retries multiply that cost.

## dio gives you typed errors and an interceptor for retries

The `http` package is fine, but `dio` 5.9.2 wraps every failure in a single `DioException` whose `type` field already classifies the failure for you, which removes a lot of the manual `on SocketException` plumbing. The `DioExceptionType` enum has eight values: `connectionTimeout`, `sendTimeout`, `receiveTimeout`, `badCertificate`, `badResponse`, `cancel`, `connectionError`, and `unknown`. You configure timeouts once on `BaseOptions` and they apply to every request.

```dart
// Flutter 3.44, Dart 3.x, dio 5.9.2
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.example.com',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 10),
));

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await dio.get<List<dynamic>>('/names');
    return Success((response.data ?? []).cast<String>());
  } on DioException catch (e) {
    return switch (e.type) {
      DioExceptionType.connectionError => const Offline(),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout =>
        const TimedOut(),
      DioExceptionType.badResponse =>
        ServerError(e.response?.statusCode ?? 0),
      _ => BadResponse(e.message ?? 'Unknown dio error'),
    };
  }
}
```

`dio` also validates status codes by default: a non-2xx response throws `DioException` with `type == badResponse` instead of returning quietly, so the "forgot to check the status code" bug cannot happen. And because `dio` exposes an interceptor pipeline, you can attach retry logic centrally rather than wrapping each call. The community `dio_smart_retry` package plugs into that pipeline and retries idempotent requests with backoff out of the box, which is worth adopting once you have more than a handful of endpoints.

## connectivity_plus tells you about the radio, not the internet

A frequent request is "check if the user is online before making the call". `connectivity_plus` 7.1.1 does part of this, but read its own warning carefully: connection type availability does not guarantee internet access. As of version 5 the API returns a `List<ConnectivityResult>` (a device can be on Wi-Fi and cellular at once), not a single value, which trips up code written against older examples.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
import 'package:connectivity_plus/connectivity_plus.dart';

Future<bool> hasNetworkInterface() async {
  final results = await Connectivity().checkConnectivity();
  return !results.contains(ConnectivityResult.none);
}
```

The trap is treating this as a gate: "if connected, the request will succeed". It will not. A phone reports `wifi` while connected to a coffee-shop network that has not been authorized through its captive portal, so every request still fails with a `SocketException` or a timeout. Use `connectivity_plus` to react to changes (show an offline banner the moment the radio drops, hide it when it returns) and to decide whether retrying is even worth attempting, but never as a substitute for actually handling the exception from the request. The connectivity check is an optimization, the exception handler is the source of truth.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
// React to connectivity changes for a live offline banner.
final sub = Connectivity().onConnectivityChanged.listen(
  (List<ConnectivityResult> results) {
    final online = !results.contains(ConnectivityResult.none);
    // update a banner; this stream's subscription must be cancelled
    // in dispose() like any other.
  },
);
```

That `StreamSubscription` is exactly the kind of resource that leaks if you forget to cancel it, which is the whole subject of [disposing controllers and subscriptions in Flutter](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## Edge cases that separate a robust app from a demo

**Cancellation on dispose.** If the user navigates away mid-request, the `Future` may still complete and call `setState` on a defunct `State`, throwing. Guard with `if (!mounted) return;` after every `await` in a widget, or move the call into a state-management layer that survives navigation. Mishandled ownership here is a recurring theme when restructuring an app, which is part of why [migrating from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) has to be careful about where async work lives.

**Timeouts must be shorter than the user's patience, not the server's.** A 30-second timeout is technically correct and a terrible experience. Pick a connect timeout around 5 seconds and a receive timeout around 10, and surface a retry well before a user concludes the app is frozen.

**A 200 with the wrong body is still a failure.** Treat schema validation as part of network handling. If `jsonDecode` succeeds but a required field is missing, that is a `BadResponse`, not a `Success`. Validate the shape before you construct your model, or you push the failure deep into the UI where it is far harder to diagnose.

**Do not log and rethrow at every layer.** Pick one place (the data layer's exception mapping) to record the error with its stack trace, and let the typed result carry the rest. Logging the same exception three times as it bubbles up just makes your crash reports noisier.

**Retries amplify load during an outage.** When a backend is already struggling, aggressive client retries make it worse. Cap attempts, use backoff with jitter, and respect a `Retry-After` header if the server sends one. Graceful degradation is as much about being a good client as about showing a nice error screen.

The throughline is that "network error handling" is really three jobs that people collapse into one: catching the specific failure, classifying it into something the UI and the retry logic can reason about, and presenting it as a state the user can act on. Get the typed `catch` clauses and the sealed result right, add a bounded backoff for the transient cases, and treat `connectivity_plus` as a hint rather than a guarantee, and the generic "Something went wrong" snackbar disappears from your app for good.

## Related

- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) covers cancelling the `StreamSubscription` a connectivity listener creates.
- [Fix: FormatException Unexpected character when parsing JSON in Dart](/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) is the malformed-body case in detail.
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) is where heavy response decoding belongs so retries do not jank the UI.
- [How to migrate a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) shows where async network work should live across a state-management change.
- [Fix: RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) keeps your error and loading widgets from breaking layout.

## Sources

- [DioException class, dio API reference](https://pub.dev/documentation/dio/latest/dio/DioException-class.html)
- [DioExceptionType enum, dio API reference](https://pub.dev/documentation/dio/latest/dio/DioExceptionType.html)
- [connectivity_plus, pub.dev](https://pub.dev/packages/connectivity_plus)
- [Future.timeout, Dart API reference](https://api.dart.dev/stable/dart-async/Future/timeout.html)
- [SocketException class, Dart API reference](https://api.dart.dev/stable/dart-io/SocketException-class.html)
- [http package, pub.dev](https://pub.dev/packages/http)
