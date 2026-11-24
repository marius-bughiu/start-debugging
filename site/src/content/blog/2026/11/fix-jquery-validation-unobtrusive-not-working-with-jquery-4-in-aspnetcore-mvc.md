---
title: "Fix: jQuery client-side validation does nothing in ASP.NET Core MVC after moving to jQuery 4"
description: "jquery-validation-unobtrusive 4.0.0 calls $.parseJSON and $.isFunction, which jQuery 4 removed. The form posts with no client errors. Pin jQuery 3.8.0, or shim both helpers before the unobtrusive script."
pubDate: 2026-11-24
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "aspnet-core-mvc"
  - "jquery"
  - "validation"
  - "dotnet-11"
---

If client-side validation in an ASP.NET Core MVC or Razor Pages app silently stopped working and the form now posts straight to the server, check which jQuery you load. `jquery-validation-unobtrusive` 4.0.0, the latest release and the one every template ships, calls `$.parseJSON` and `$.isFunction`, both removed in jQuery 4.0.0 and still absent in jQuery 4.1.0. The quickest fix is to pin jQuery to `3.8.0` (or `3.7.1`). If you need jQuery 4, define `$.parseJSON` and `$.isFunction` before the unobtrusive script loads. Everything below was reproduced on .NET SDK 11.0.100 with ASP.NET Core 11.0.0 in Chromium.

## The error you never get to see

The Stack Overflow question that triggered this post says the code "runs without errors" and only server-side validation works. That is exactly what it looks like, because the error is thrown inside the `submit` handler and the page then navigates away. With DevTools' "Preserve log" turned on, clicking submit on an empty form produces this:

```text
Uncaught TypeError: s.parseJSON is not a function
    at HTMLFormElement.<anonymous> (jquery.validate.unobtrusive.min.js:8:1421)
    at a.validator.errorPlacement (jquery.validate.unobtrusive.min.js:8:1623)
    at a.validator.showLabel (jquery.validate.min.js:4:15865)
    at a.validator.defaultShowErrors (jquery.validate.min.js:4:14459)
    at a.validator.showErrors (jquery.validate.min.js:4:8249)
    at a.validator.form (jquery.validate.min.js:4:7164)
    at HTMLFormElement.<anonymous> (jquery.validate.min.js:4:1146)
    at HTMLFormElement.dispatch (jquery.min.js:2:37917)
    at v.handle (jquery.min.js:2:35897)
```

`s` is the minified name for `$`. With the unminified file you get `$.parseJSON is not a function`. If you configured `$.validator.unobtrusive.options` with an `errorPlacement`, `invalidHandler`, or `success` callback, you may instead (or additionally) hit `$.isFunction is not a function`.

## Why jQuery 4 breaks jquery-validation-unobtrusive

[jQuery 4.0.0](https://blog.jquery.com/2026/01/17/jquery-4-0-0/) shipped on 2026-01-17 and removed a long list of utilities that had been deprecated for years, including `jQuery.parseJSON` (use `JSON.parse`), `jQuery.isFunction` (use `typeof x === "function"`), `jQuery.isArray`, `jQuery.trim`, and `jQuery.type`. `jQuery.proxy` is deprecated but still present.

The last published `jquery-validation-unobtrusive` is 4.0.0, released on 2022-07-20. Its `dist/jquery.validate.unobtrusive.js` still has these lines:

```javascript
// jquery-validation-unobtrusive 4.0.0, dist/jquery.validate.unobtrusive.js
function onError(error, inputElement) {  // 'this' is the form element
    var container = $(this).find("[data-valmsg-for='" + escapeAttributeValue(inputElement[0].name) + "']"),
        replaceAttrValue = container.attr("data-valmsg-replace"),
        replace = replaceAttrValue ? $.parseJSON(replaceAttrValue) !== false : null;
    // ...
}

// inside validationInfo(form)
execInContext = function (name, args) {
    var func = defaultOptions[name];
    func && $.isFunction(func) && func.apply(form, args);
};
```

`onError` runs every time jQuery Validation places an error message. The `asp-validation-for` tag helper always renders `data-valmsg-replace="true"` on its `<span>`, so the very first failed rule on any field with a validation span calls `$.parseJSON` and throws. The `$.isFunction` path only runs when `$.validator.unobtrusive.options` defines one of the three callbacks, which is why most people only ever see the `parseJSON` error.

The throw explains the rest of the symptoms. jQuery Validation's submit handler is the one that returns `false` to block an invalid form. Because the exception escapes before that `return`, the browser's default submit goes ahead, the server runs `ModelState` validation, re-renders the view with server errors, and the navigation clears the console. You see server-side validation working and an empty console.

The fix has been in the repository's `main` branch since [PR #161, "Fixed jQuery deprecations"](https://github.com/aspnet/jquery-validation-unobtrusive/pull/161), merged on 2023-01-23. It was never released. The tracking issue, [aspnet/jquery-validation-unobtrusive#183 "jQuery 4.0.0 NOT supported"](https://github.com/aspnet/jquery-validation-unobtrusive/issues/183), got this answer from Microsoft on 2026-04-30: there are no plans to upgrade the library to jQuery 4, and it is only receiving critical security and bug fixes.

## Where jQuery 4 comes from (it is not `dotnet new mvc`)

A common explanation is that "a new ASP.NET Core MVC project ships jQuery 4". That is not what the CLI template does. On SDK 11.0.100, `dotnet new mvc` writes these versions into `wwwroot/lib`:

| Library | Version in `dotnet new mvc` (SDK 11.0.100) |
| --- | --- |
| jQuery | 3.7.1 |
| jquery-validation | 1.21.0 |
| jquery-validation-unobtrusive | 4.0.0 |

That combination works. jQuery 4 shows up when you add or update the libraries yourself. The project in the Stack Overflow question had a `libman.json` that asked for the latest cdnjs versions:

```json
{
  "version": "3.0",
  "defaultProvider": "cdnjs",
  "libraries": [
    { "library": "jquery@4.0.0", "destination": "wwwroot/lib/jquery/" },
    { "library": "jquery-validate@1.22.1", "destination": "wwwroot/lib/jquery-validate/" },
    { "library": "jquery-validation-unobtrusive@4.0.0", "destination": "wwwroot/lib/jquery-validation-unobtrusive/" }
  ]
}
```

As of 2026-11-24 the latest cdnjs versions are jQuery 4.1.0, jquery-validate 1.22.1, and jquery-validation-unobtrusive 4.0.0, so "Add Client-Side Library" with the defaults, `libman install jquery`, `npm i jquery`, or a CDN `<script>` pointing at "latest" all land you in the broken combination. Note that the npm package of `jquery-validation-unobtrusive` 4.0.0 declares `"jquery": "^3.6.0"` as a dependency, so it was never meant to run on 4.x.

## Minimal repro

Start from `dotnet new mvc` and add a model, a controller, and a view:

```csharp
// .NET 11, ASP.NET Core 11.0.0 - Models/LoginViewModel.cs
using System.ComponentModel.DataAnnotations;

namespace MvcApp.Models;

public class LoginViewModel
{
    [Required(ErrorMessage = "Email is required")]
    [EmailAddress(ErrorMessage = "Not a valid email address")]
    public string? Email { get; set; }

    [Required(ErrorMessage = "Password is required")]
    public string? Password { get; set; }
}
```

```csharp
// .NET 11, ASP.NET Core 11.0.0 - Controllers/LoginController.cs
using Microsoft.AspNetCore.Mvc;
using MvcApp.Models;

namespace MvcApp.Controllers;

public class LoginController : Controller
{
    [HttpGet]
    public IActionResult Index() => View(new LoginViewModel());

    [HttpPost]
    public IActionResult Index(LoginViewModel model)
    {
        ViewData["Posted"] = true; // proves the request reached the server
        return View(model);
    }
}
```

```razor
@* .NET 11, ASP.NET Core 11.0.0 - Views/Login/Index.cshtml *@
@model MvcApp.Models.LoginViewModel

@if (ViewData["Posted"] is true) { <p id="posted">Server round trip happened</p> }

<form asp-action="Index" method="post">
    <input asp-for="Email" class="form-control" />
    <span asp-validation-for="Email" class="text-danger"></span>
    <input asp-for="Password" type="password" class="form-control" />
    <span asp-validation-for="Password" class="text-danger"></span>
    <button type="submit">Login</button>
</form>

@section Scripts { <partial name="_ValidationScriptsPartial" /> }
```

Then swap the jQuery `<script>` in `Views/Shared/_Layout.cshtml` for jQuery 4.0.0 or 4.1.0. Run it, open `/Login`, and click "Login" with both fields empty. These are the results from Chromium, with jquery-validation 1.22.1 in every run:

| jQuery | Unobtrusive script | Client errors shown | Form posted to server |
| --- | --- | --- | --- |
| 3.7.1 | 4.0.0 (npm) | Yes | No |
| 3.8.0 | 4.0.0 (npm) | Yes | No |
| 4.0.0 | 4.0.0 (npm) | No, `parseJSON` throws | Yes |
| 4.1.0 | 4.0.0 (npm) | No, `parseJSON` throws | Yes |
| 4.0.0 | 4.0.0 + shim below | Yes | No |
| 4.1.0 | 4.0.0 + shim below | Yes | No |
| 4.0.0 | `src/` from `main` (PR #161) | Yes | No |

The shim was also checked with an invalid email (`not-an-email` shows "Not a valid email address"), with a form `reset`, and with a `success` callback in `$.validator.unobtrusive.options`, which throws `$.isFunction is not a function` on jQuery 4 without the shim.

## Fix 1: pin jQuery to 3.x

This is the lowest-risk fix and the one the accepted Stack Overflow answer gives. jQuery 3.8.0, released on 2026-11-17, is the current 3.x release, and the `v3-latest` dist-tag on npm points at it. 3.7.1 also works.

With LibMan, change the version in `libman.json` and restore:

```json
{
  "library": "jquery@3.8.0",
  "destination": "wwwroot/lib/jquery/"
}
```

```bash
libman restore
```

With npm, pin the major:

```bash
npm install jquery@3 jquery-validation@1.22.1 jquery-validation-unobtrusive@4.0.0
```

If you use a CDN, link the exact version (`https://cdnjs.cloudflare.com/ajax/libs/jquery/3.8.0/jquery.min.js`), never a "latest" alias. Then hard-reload so the browser does not keep a cached jQuery 4.

## Fix 2: keep jQuery 4 and shim the two removed helpers

If something else in the app needs jQuery 4, put the two helpers back before the unobtrusive script runs. In `Views/Shared/_ValidationScriptsPartial.cshtml`:

```razor
@* .NET 11, ASP.NET Core 11.0.0, jQuery 4.1.0, jquery-validation 1.22.1 *@
<script src="~/lib/jquery-validation/dist/jquery.validate.min.js"></script>
<script>
    // jQuery 4 removed these; jquery-validation-unobtrusive 4.0.0 still calls them.
    $.parseJSON ??= JSON.parse;
    $.isFunction ??= (obj) => typeof obj === "function";
</script>
<script src="~/lib/jquery-validation-unobtrusive/dist/jquery.validate.unobtrusive.min.js"></script>
```

The order matters only in the sense that the shim must run before the first validation, but putting it immediately before the unobtrusive script keeps it obvious. The `??=` makes it a no-op on jQuery 3, so the partial works on both majors. Better still, move the shim into a small `jquery4-compat.js` file so a Content Security Policy without `'unsafe-inline'` does not block it.

Two caveats. First, jquery-validation itself needs to be 1.22.0 or later on jQuery 4: [1.22.0 added jQuery 4.0.0 support](https://github.com/jquery-validation/jquery-validation/releases/tag/1.22.0), while the template ships 1.21.0. All runs above used 1.22.1, so 1.21.0 on jQuery 4 was not tested here. Second, the shim only covers the two helpers this library calls. Other plugins in your bundle may call different removed APIs.

## Fix 3: use the unreleased source from `main`

The `src/jquery.validate.unobtrusive.js` file on `main` already replaces both calls:

```javascript
// aspnet/jquery-validation-unobtrusive main, after PR #161
replace = replaceAttrValue ? JSON.parse(replaceAttrValue) !== false : null;
// ...
func && typeof func === "function" && func.apply(form, args);
```

You can vendor that file into `wwwroot/lib`. It worked in the test above with jQuery 4.0.0. The downside is that you now own an unversioned copy of a file Microsoft says it is not maintaining, and you lose the npm/LibMan update path. The shim in Fix 2 is less to maintain.

## Fix 4: drop jQuery from validation entirely

Microsoft's position on issue #183 means this library will not move forward. If you are on jQuery only because of validation, [haacked/aspnet-client-validation](https://github.com/haacked/aspnet-client-validation) reads the same `data-val-*` attributes that the MVC tag helpers emit, without jQuery. A commenter on the issue reports switching to it; it was not tested for this post, so check its handling of your custom adapters before you migrate. On Blazor, .NET 11 has its own path: [static SSR forms now validate in the browser](/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) with no jQuery at all.

## Gotchas and lookalikes

- **Only some fields fail.** `$.parseJSON` is only called when the field has a matching `data-valmsg-for` container with `data-valmsg-replace`. A field without an `asp-validation-for` span can still show the default jQuery Validation label, which makes the bug look intermittent.
- **Re-parsing does not help.** The question's code calls `removeData("validator")`, `removeData("unobtrusiveValidation")`, and `$.validator.unobtrusive.parse(form)` after rewriting the `data-val-*` attributes. That pattern is fine on jQuery 3, but on jQuery 4 the re-created validator still calls `$.parseJSON` and fails the same way.
- **Calling `.valid()` throws to your code.** `$('#form').valid()` on jQuery 4 surfaces `parseJSON is not a function` directly to the caller, so a custom submit button that calls `.valid()` before `form.submit()` dies there instead of submitting.
- **Script order is a different bug.** If `$.validator` is undefined, either the scripts load in the wrong order (jQuery, then jquery-validation, then the unobtrusive adapter) or the view never renders `_ValidationScriptsPartial`. That case has no `parseJSON` frame in the stack trace, so the trace above tells the two apart.
- **The POST itself fails.** Once the client lets the form through, an error on the round trip is a server problem, not a validation one. A common one is covered in [the antiforgery token could not be decrypted](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Related

- If your validation rules live in shared DTOs, [sharing validation logic between the server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) shows how to keep one set of attributes.
- For the jQuery-free route in Blazor, see [client-side validation for Blazor static SSR forms in .NET 11](/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/).
- For a refresher on when MVC views still make sense next to endpoints, read [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).
- POST failures after the client lets a form through are often [antiforgery token decryption errors](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Sources

- [jQuery 4.0.0 release announcement](https://blog.jquery.com/2026/01/17/jquery-4-0-0/), list of removed APIs.
- [aspnet/jquery-validation-unobtrusive#183: jQuery 4.0.0 NOT supported](https://github.com/aspnet/jquery-validation-unobtrusive/issues/183), including Microsoft's 2026-04-30 statement.
- [aspnet/jquery-validation-unobtrusive PR #161: Fixed jQuery deprecations](https://github.com/aspnet/jquery-validation-unobtrusive/pull/161), merged 2023-01-23, unreleased.
- [jquery-validation 1.22.0 release notes](https://github.com/jquery-validation/jquery-validation/releases/tag/1.22.0), jQuery 4.0.0 support.
- [Client-side validation in ASP.NET Core MVC](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/validation#client-side-validation) on Microsoft Learn.
- [Stack Overflow: JQuery validation not working in new ASP.NET Core MVC web application](https://stackoverflow.com/questions/80012423).
