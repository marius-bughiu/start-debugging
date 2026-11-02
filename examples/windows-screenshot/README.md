# Windows desktop screenshot

Requires Windows and the .NET 8 SDK with Windows Desktop support. From this folder:

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

The self-test round-trips a synthetic bitmap through PNG without capturing the desktop. The other commands capture the current Windows session's virtual-screen bounding rectangle and write a uniquely named PNG to Pictures or the specified output folder.

Displays left or above the primary display can have negative coordinates; `CopyFromScreen` must use `screen.Left` and `screen.Top`. The bounding rectangle can also include unused space between differently arranged displays. This does not capture other users' sessions, secure desktops, or guaranteed protected content.

The project can be cross-built using its `EnableWindowsTargeting` setting, but it requires Windows to run. A cross-build does not verify real display capture, DPI behavior, or a particular multi-monitor arrangement.
