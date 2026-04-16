---
title: "Blazor Virtualize Finally Handles Variable-Height Items in .NET 11"
description: "ASP.NET Core in .NET 11 Preview 3 teaches the Virtualize component to measure items at runtime, fixing the spacing and scroll jitter that uniform-height assumptions caused."
pubDate: 2026-04-16
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "virtualize"
---

Anyone who has used [`Virtualize<TItem>`](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/virtualization) for a chat log, a feed of cards, or a notifications panel has seen the same bug: items jitter on scroll, the scrollbar thumb jumps around, and you end up with awkward gaps or overlaps. The root cause has always been the same. `Virtualize` assumed every row was the same height and used that single number to compute the scroll window. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md) finally fixes that: the component now measures items at runtime and adjusts the virtual viewport to whatever heights actually land in the DOM.

## Why the old behavior broke real UIs

The original API forced you to pick a scalar via `ItemSize`. If your items were 48px tall, you set 48. Blazor then multiplied item count by 48 to size the scrollable area and rendered only the rows whose computed top position intersected the viewport. The moment your rows contained a variable-length body, a wrapping quote, or a responsive image, the math stopped matching reality and the browser and Blazor fought over placement.

```razor
<Virtualize Items="messages" Context="message">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

That snippet is exactly the scenario that used to misbehave. A short one-liner and a five-paragraph reply share the same row slot, so scroll offsets drift as you move through the list.

## Measuring the rendered DOM

In .NET 11 Preview 3, `Virtualize` now tracks measured item dimensions at runtime and feeds them back into its spacer calculations. You no longer need to set `ItemSize` to a value that matches the worst case, and you no longer need to set `overflow: hidden` on children to force them into a fixed box. The component still accepts an initial size hint, but it treats it as a starting estimate rather than ground truth.

The second change is the `OverscanCount` default. `Virtualize` used to render three items above and below the viewport. In Preview 3 that default jumps to 15 so there are enough measured items to stabilize the height estimate before the user scrolls into unmeasured territory.

```razor
<Virtualize Items="messages" Context="message" OverscanCount="30">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

Bumping `OverscanCount` higher is now a legitimate tuning knob for feeds with wildly different item heights. The cost is rendering more off-screen DOM, but in exchange you get smoother scrolling and a stable scrollbar.

## QuickGrid keeps the old default

If you are using `QuickGrid`, nothing changes. The component pins its own `OverscanCount` at 3 because grid rows are intentionally uniform and rendering 30 hidden rows per scroll tick would torch performance for tables with hundreds of columns. That is deliberate: the new defaults target the components where the old assumption was genuinely wrong.

## What to change in existing apps

Drop the `ItemSize` value if you set it only to paper over variable heights, since the measured path is strictly better there. Audit any CSS you added to force children into a fixed box. And profile scrolling before tuning `OverscanCount` up further, because 15 is already a big jump from 3.

The implementation lives in [dotnet/aspnetcore#64964](https://github.com/dotnet/aspnetcore/pull/64964). Grab [.NET 11 Preview 3](https://dotnet.microsoft.com/download/dotnet/11.0) and the next time someone asks why the chat log scrolls weirdly, you will have one fewer workaround to explain.
