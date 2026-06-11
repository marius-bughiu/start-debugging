---
title: "Blazor static SSR forms get client-side validation in .NET 11 Preview 5"
description: "Static server-rendered Blazor forms could only validate after a full POST round-trip. .NET 11 Preview 5 renders validation metadata so the Blazor JS enforces DataAnnotations rules in the browser, no circuit required."
pubDate: 2026-06-11
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) shipped on 2026-06-09, and one ASP.NET Core change closes a gap that has annoyed anyone building forms on static server-side rendering (static SSR): forms now validate in the browser without an interactive render mode. Until this preview, a static SSR form had exactly one way to tell the user their email was malformed: submit the whole thing, let the server run `DataAnnotations`, and re-render the page with the error messages. That is a full POST round-trip for a typo.

## Why static SSR forms were stuck on the server

The Blazor Web App template renders most content as static HTML. There is no SignalR circuit and no WebAssembly payload, which is exactly why static SSR is cheap and fast. But client-side validation needs code running in the browser, and a static page does not ship any component logic to the client. So validation lived entirely on the server: you posted the form, `DataAnnotationsValidator` walked the model, and any failures came back as a re-rendered page. Correct, but slow, and a poor experience next to an interactive form that flags a bad field on blur.

The usual workaround was to opt the form's component into `InteractiveServer` or `InteractiveWebAssembly` just to get live feedback, paying for a circuit or a WASM download you did not otherwise need.

## How Preview 5 closes the gap

In Preview 5 the server renders the validation rules as metadata into the HTML, and the Blazor JS enforces them in the browser. Your `DataAnnotations` attributes stay the authoritative source of truth, evaluated again on the server on submit. The browser just gets an early, free copy of the same rules. The feature is enabled by default for every static SSR form that includes a `DataAnnotationsValidator`, and it works with both enhanced and non-enhanced forms.

There is no new API to learn. The form you already wrote starts validating client-side the moment you target the Preview 5 SDK:

```razor
<EditForm Model="Model" Enhance FormName="registration" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <div>
        <label for="Email">Email</label>
        <InputText @bind-Value="Model!.Email" id="Email" />
        <ValidationMessage For="@(() => Model!.Email)" />
    </div>
    <button type="submit" id="submit-btn">Register</button>
</EditForm>
```

```csharp
public class RegistrationModel
{
    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    public string Password { get; set; }

    [Required]
    [Compare("Password")]
    [Display(Name = "Confirm Password")]
    public string ConfirmPassword { get; set; }
}
```

A bad email or a too-short password now surfaces in the browser before the form ever hits the wire. The server still runs the same checks on POST, so you do not lose the defense-in-depth: client validation is a convenience layer, not a security boundary, exactly as it should be.

## What is still missing

Async rules (a database uniqueness check, a remote API lookup) are not part of this yet. The release notes say the full async story lands when the new asynchronous `DataAnnotations` APIs ship in a later preview. For now this covers the synchronous attribute set, which is the bulk of real-world form validation.

This pairs with the other Preview 5 additions like [System.Text.Json JSON Lines serialization](/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/). To try it, install the .NET 11 Preview 5 SDK and target `net11.0`. Full details are in the [ASP.NET Core Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md).
