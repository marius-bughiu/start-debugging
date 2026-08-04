---
title: "How to build an infinite-scrolling paginated list in Flutter with ScrollController"
description: "Attach a ScrollController to a ListView.builder, fire the next page when position.extentAfter drops below a prefetch threshold, and guard the fetch with isLoading, hasMore, and error flags. Full implementation plus the short-first-page trap."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "listview"
  - "scrollcontroller"
  - "pagination"
  - "how-to"
---

To build an infinite-scrolling list in Flutter, attach a `ScrollController` to a `ListView.builder`, listen for scroll changes, and request the next page when `position.extentAfter` drops below a prefetch threshold of a few hundred pixels. The listener itself must be idempotent: it fires on every scroll frame, so the actual fetch has to be behind an `isLoading`/`hasMore`/`error` guard or you will kick off a dozen identical requests during a single fling. This post builds the whole thing on Flutter 3.44.8 (Dart 3.12.2), then covers the two failure modes that bite in production: the first page that is too short to scroll, and the retry loop that hammers a dead API.

## Why `pixels >= maxScrollExtent` is the wrong trigger

Almost every tutorial starts here:

```dart
// Flutter 3.44.8, Dart 3.12.2 -- do not ship this
_controller.addListener(() {
  if (_controller.position.pixels >= _controller.position.maxScrollExtent) {
    _loadMore();
  }
});
```

Three things are wrong with it.

First, a `ScrollController` notifies its listeners on every scroll position change, which during a fling means once per frame at 60Hz or 120Hz. If `_loadMore()` is an unguarded `await api.fetch(...)`, the condition stays true for the whole time the list sits pinned at the bottom, and you fire a new request every frame until the first response lands. On a 120Hz device with a 300ms round trip that is roughly 36 duplicate requests.

Second, `maxScrollExtent` is the exact bottom. Waiting for it means the user has already run out of content before you start asking for more, so they stare at an empty gutter for the length of a network round trip. Flutter's viewport builds a `cacheExtent` of `RenderAbstractViewport.defaultCacheExtent`, which is `250.0` logical pixels, past the visible edge. Triggering while there is still content in that band means the fetch overlaps the scroll instead of following it.

Third, `ScrollController.position` is not safe to touch unconditionally. The getter is two asserts deep:

```dart
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}
```

Both fire in debug builds and both are reachable in ordinary code, which is covered in the gotchas below.

The fix for the first two is to trigger on `extentAfter`, which the `ScrollPosition` docs define as the quantity of content conceptually below the viewport. When `extentAfter` is 400 the user still has 400 logical pixels of already-built rows to scroll through, which is usually enough runway to hide the fetch entirely.

## Building it in four steps

The whole pattern is four moving parts. Everything else is presentation.

1. **Hold the pagination state in the `State`, not in the builder.** You need the accumulated `List<T>`, the cursor or page number for the next request, and three flags: `_isLoading`, `_hasMore`, and `_error`. Those three flags are what make the scroll listener safe to call on every frame.
2. **Attach a `ScrollController` in `initState` and detach it in `dispose`.** Call `removeListener` before `dispose()` on the controller, and kick off the first page from `initState` so the list is never empty on the first frame without a spinner.
3. **Trigger on `extentAfter`, not on `pixels`.** In the listener, bail out early if the controller has no clients, if a fetch is already in flight, if the server said there are no more pages, or if the last attempt failed. Only then compare `extentAfter` against your prefetch threshold.
4. **Render one extra row for the tail state.** Set `itemCount` to `items.length + 1` while there is more to load or an error to show, and have `itemBuilder` return a spinner, a retry tile, or nothing for that final index. This is what turns the loading state into something the user can see and act on.

## The full implementation

```dart
// Flutter 3.44.8, Dart 3.12.2
class FeedPage extends StatefulWidget {
  const FeedPage({super.key});

  @override
  State<FeedPage> createState() => _FeedPageState();
}

class _FeedPageState extends State<FeedPage> {
  // Default viewport cacheExtent is 250.0 px, so 400 leaves runway.
  static const double _prefetchExtent = 400;
  static const int _pageSize = 20;

  final ScrollController _controller = ScrollController();
  final List<Post> _items = [];

  String? _cursor;
  bool _isLoading = false;
  bool _hasMore = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
    _loadMore();
  }

  @override
  void dispose() {
    _controller.removeListener(_onScroll);
    _controller.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_controller.hasClients) return;
    if (_isLoading || !_hasMore || _error != null) return;
    if (_controller.position.extentAfter > _prefetchExtent) return;
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final page = await api.fetchFeed(after: _cursor, limit: _pageSize);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.nextCursor != null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      _isLoading = false;
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool showTail = _hasMore || _error != null;

    return ListView.builder(
      controller: _controller,
      itemCount: _items.length + (showTail ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < _items.length) {
          return PostTile(post: _items[index]);
        }
        if (_error != null) {
          return _RetryTile(error: _error!, onRetry: _retry);
        }
        return const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        );
      },
    );
  }

  void _retry() {
    setState(() => _error = null);
    _loadMore();
  }
}
```

Note the split between `_onScroll` and `_loadMore`. `_onScroll` refuses to run when `_error != null`; `_loadMore` does not. That asymmetry is deliberate and is what stops the retry loop described further down. The scroll listener will never auto-retry a failed page, but the retry button can, because it clears `_error` first.

The `finally` block sets `_isLoading = false` as a plain assignment before checking `mounted`. If you put the assignment inside a `setState` that only runs when mounted, an unmount during the request leaves the flag stuck true; harmless for a disposed widget, but it makes the state machine harder to reason about when the same controller logic gets lifted into a Riverpod notifier later.

## The short first page that never scrolls

This is the bug that reaches production most often, because it only shows up on tall screens. If page one returns 20 rows and the viewport fits 30, `maxScrollExtent` is `0.0`, no scroll is possible, the `ScrollController` never notifies, and the list is permanently stuck at 20 items. It works perfectly on a phone in portrait and looks broken on a tablet, on desktop, and on web at a maximized window.

`ScrollController` cannot help here, because nothing scrolled. The cheapest fix is to re-check after the frame that laid out the new rows:

```dart
// Flutter 3.44.8: run after layout so maxScrollExtent is real.
void _fillViewportIfNeeded() {
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted || !_controller.hasClients) return;
    if (_error != null || !_hasMore) return;
    if (_controller.position.maxScrollExtent == 0) _loadMore();
  });
}
```

Call it at the end of the success branch in `_loadMore`. It terminates: each pass either makes the content taller than the viewport (so `maxScrollExtent > 0`) or exhausts the feed (so `_hasMore` goes false).

The more complete fix is `ScrollMetricsNotification`, which Flutter dispatches when a scrollable's `ScrollMetrics` change without any scrolling happening, including when the content grows or shrinks and when the parent window is resized. Wrapping the list in one catches the tablet case, the desktop window-resize case, and the case where the on-screen keyboard closes and the viewport suddenly gets taller:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollMetricsNotification>(
  onNotification: (notification) {
    if (notification.metrics.maxScrollExtent == 0 && _error == null) {
      _loadMore();
    }
    return false; // let it keep bubbling
  },
  child: ListView.builder(/* ... */),
)
```

Return `false` from `onNotification`. Returning `true` cancels the notification's trip up the tree, which quietly breaks any ancestor that depends on it, such as a `Scrollbar` or a `RefreshIndicator`.

## The retry loop that hammers a dead API

Suppose the guard in `_onScroll` were only `if (_isLoading || !_hasMore) return;`. The user is at the bottom, the request fails, `_isLoading` goes false, `_hasMore` is still true, and the position has not moved. The next scroll notification, which arrives on the very next micro-movement of the user's thumb, calls `_loadMore` again. Every failure immediately produces another request, so a network outage turns into a request flood that keeps the radio awake and drains battery.

Adding `_error != null` to the scroll guard makes failure a terminal state that only an explicit user action clears. If you want automatic recovery, put it behind a backoff rather than behind the scroll listener, and cap the attempts. The general shape of that, including which exceptions are worth retrying, is in [handling network errors gracefully in a Flutter app](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Gotchas that will bite you

1. **`ScrollController not attached to any scroll views.`** Reading `.position` before the first layout, or after the `ListView` is gone, trips this assert. It is easy to hit from a post-frame callback that survives a `Navigator.pop`. Guard every access with `hasClients`, which is just `_positions.isNotEmpty`.
2. **`ScrollController attached to multiple scroll views.`** One controller can only report a position if exactly one scrollable is using it. Passing the same `_controller` to two `ListView`s inside a `TabBarView` is the classic way in. Each tab needs its own controller and its own pagination state.
3. **Offset pagination drifts under a live feed.** If the server inserts a row while the user is between page 2 and page 3, `?page=3&size=20` returns a window that overlaps page 2, so the user sees a duplicate and misses one. Cursor pagination does not have that failure mode, which is why the example above threads a `nextCursor` rather than a page index. The server-side half of this, with the SQL and the index it needs, is in [keyset (cursor) pagination in EF Core 11](/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).
4. **`setState` after `dispose`.** Every `await` in `_loadMore` is a point where the user can hit back. The `if (!mounted) return;` after each await is not optional; without it you get `setState() called after dispose()`. The full rule, including why `mounted` must be re-checked after every gap rather than once at the top, is in [guarding setState with the mounted check after an async gap](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).
5. **The controller is a disposable you own.** `ScrollController` extends `ChangeNotifier`; if the `State` that created it does not dispose it, the listener closure keeps the `State` and everything it captured alive. This is the same leak class as an undisposed `TextEditingController` or `AnimationController`, covered in [disposing controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
6. **`shrinkWrap: true` destroys the whole point.** A shrink-wrapped list builds every child on the first frame to measure itself, so an infinite list becomes an infinitely growing first-frame cost. If you reached for it to silence an unbounded-height error, the correct alternatives are laid out in [shrinkWrap vs Expanded vs slivers for long lists](/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

## When to use `NotificationListener` instead of a controller

`ScrollController` is not the only way to read scroll metrics. A `NotificationListener<ScrollNotification>` gets the same numbers through `notification.metrics` without owning a controller at all:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollEndNotification>(
  onNotification: (notification) {
    if (notification.metrics.extentAfter < 400) _loadMore();
    return false;
  },
  child: ListView.builder(/* ... */),
)
```

Prefer this when you do not own the scrollable: inside a `NestedScrollView`, under a `PrimaryScrollController`, or when the list is a `CustomScrollView` with several sliver sections and a single controller would be ambiguous about which one you meant. `ScrollEndNotification` also fires far less often than a controller listener, which removes the per-frame concern, though at the cost of not prefetching mid-fling.

Prefer the controller when you also need to *drive* the scroll: `jumpTo`, `animateTo`, restoring an offset, or scrolling to a newly inserted item. And if your list shares a viewport with other content, the sliver equivalents apply unchanged; the pagination logic is identical, only the widget wrapping changes, as in [mixing a ListView and a GridView in one scroll view with slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

## Whether to just use the package

`infinite_scroll_pagination` 5.1.1 packages this state machine as a `PagingController` plus a `PagedListView` and `PagingListener`, and handles the tail states, the short-first-page case, and pull-to-refresh integration for you. It is a reasonable dependency for an app with many paginated screens, since the alternative is copy-pasting the `State` above five times.

Write it by hand when you have one or two paginated lists, when your pagination state already lives in Riverpod or Bloc (at which point the controller is just a trigger and the package's own controller is redundant), or when your API's paging contract is unusual enough that you would be fighting the abstraction. If you are wiring this into Riverpod, the loading and error branches map cleanly onto `AsyncValue`, which is covered in [showing loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Sources

- [ScrollPosition class](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html), Flutter API docs (`extentAfter`, `maxScrollExtent`, `atEdge`)
- [ScrollController class](https://api.flutter.dev/flutter/widgets/ScrollController-class.html), Flutter API docs (`hasClients`, `position`, `keepScrollOffset`)
- [ScrollMetricsNotification class](https://api.flutter.dev/flutter/widgets/ScrollMetricsNotification-class.html), Flutter API docs
- [RenderAbstractViewport.defaultCacheExtent](https://api.flutter.dev/flutter/rendering/RenderAbstractViewport/defaultCacheExtent-constant.html), Flutter API docs
- [Flutter 3.44.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0), Flutter documentation
- [infinite_scroll_pagination on pub.dev](https://pub.dev/packages/infinite_scroll_pagination)
