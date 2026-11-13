---
title: "November 2026 .NET patch: two CVEs a runtime update does not fix"
description: "The November 10, 2026 servicing release (.NET 10.0.15, 9.0.23, 8.0.34) patches 25 CVEs. Two of them, the Identity scaffolding email bug and the System.Formats.Cbor hash flood, need package bumps and code changes, not just a new runtime."
pubDate: 2026-11-13
tags:
  - "dotnet"
  - "security"
  - "aspnetcore"
  - "dotnet-10"
---

The [November 2026 servicing updates](https://devblogs.microsoft.com/dotnet/dotnet-and-dotnet-framework-november-2026-servicing-updates/) landed on November 10, the same day .NET 11 went GA. The new versions are .NET 10.0.15 (SDKs 10.0.404 and 10.0.115), 9.0.23, 8.0.34, and 11.0.0. The bulletin lists 25 CVEs across ASP.NET Core, the runtime, and Visual Studio. For most of them you install the new runtime, rebuild your container images, and you're done.

Two of them are different. The bulletin says outright that updating the runtime alone does not fix them. If your patch process ends at `dotnet --list-runtimes`, these two are still open.

## CVE-2026-118741: Identity scaffolding emailed the wrong address

[Advisory #525](https://github.com/dotnet/announcements/issues/525) (CVSS 8.1, CWE-640) covers the ASP.NET Core Identity scaffolding and project templates. The generated `ForgotPassword` and `ResendEmailConfirmation` handlers, including the Blazor versions, sent password-reset and confirmation links to the email address from the request, not the email stored on the account. Code that was generated once and then committed to your repo doesn't change when you update the tools that generated it.

Fixed versions:

- `Microsoft.VisualStudio.Web.CodeGeneration.Design` / `CodeGenerators.Mvc`: 8.0.24, 9.0.13, 10.0.3
- `Microsoft.DotNet.Web.ProjectTemplates.*`: 8.0.34, 9.0.23, 10.0.15
- `Microsoft.dotnet-scaffold`: 20.3.0 (it replaces `Microsoft.dotnet-scaffold-aspnet`, and the 20.x tool targets .NET 8 through 11)

Update the tooling first:

```bash
dotnet tool uninstall --global Microsoft.dotnet-scaffold-aspnet
dotnet tool update --global Microsoft.dotnet-scaffold --version 20.3.0
```

Then fix every generated handler by hand. Keep looking up the user by the address they typed, but send the email to the stored address:

```csharp
var user = await _userManager.FindByEmailAsync(Input.Email);
if (user is null || !await _userManager.IsEmailConfirmedAsync(user))
{
    return RedirectToPage("./ForgotPasswordConfirmation");
}

var storedEmail = await _userManager.GetEmailAsync(user);
if (string.IsNullOrEmpty(storedEmail))
{
    throw new InvalidOperationException("User has no stored email.");
}

// token + callback URL generation unchanged
await _emailSender.SendEmailAsync(
    storedEmail, // was: Input.Email
    "Reset Password",
    $"Please reset your password by <a href='{HtmlEncoder.Default.Encode(callbackUrl!)}'>clicking here</a>.");
```

Blazor components use `UserManager` instead of `_userManager`. Rebuild and redeploy.

## CVE-2026-118747: System.Formats.Cbor hash flooding

[GHSA-vmv3-wvjp-wqpj](https://github.com/dotnet/runtime/security/advisories/GHSA-vmv3-wvjp-wqpj) (CVSS 7.5, CWE-407) is a denial of service in `System.Formats.Cbor`. An attacker can send CBOR maps whose keys all collide, which slows the reader's duplicate-key check to the point of a hash flood. The fix switches that check to seeded Marvin hashing. `System.Formats.Cbor` ships as a standalone NuGet package, not as part of the shared framework, so your app keeps whatever version it references.

Fixed package versions are 8.0.2, 10.0.15, and 11.0.0. On the 9.0 line the fix is **9.0.24**. The advisory says plainly that 9.0.23 is not a fix, even though 9.0.23 is the November runtime version. Alternatively, the 10.0.15 package includes a `net9.0` target.

```xml
<PackageReference Include="System.Formats.Cbor" Version="9.0.24" />
```

To find out whether you depend on it, including transitively, run:

```bash
dotnet list package --include-transitive | grep -i Formats.Cbor
```

If it shows up, pin the patched version, then rebuild and redeploy. If you read untrusted CBOR with the incremental `CborReader` added in .NET 11 ([covered here](/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/)), the 11.0.0 package already has the fix.

## The rest of the list

The remaining CVEs include six ASP.NET Core denial-of-service bugs, several elevation-of-privilege fixes, and five Visual Studio remote code execution issues. A runtime or SDK update covers all of them, so install 10.0.15 (or 8.0.34 / 9.0.23 if you're still on those) and refresh your base images. .NET 8 and 9 reached end of support on the same day, so this is the last patch either of them gets. The full per-version lists are in [10.0/cve.md](https://github.com/dotnet/core/blob/main/release-notes/10.0/cve.md) and the [10.0.15 release notes](https://github.com/dotnet/core/blob/main/release-notes/10.0/10.0.15/10.0.15.md).
