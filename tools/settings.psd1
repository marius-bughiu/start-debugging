@{
  # Used by sd-daily.ps1 (does not affect the other tools unless you wire it in).
  UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StartDebuggingBot/1.0'

  # Default time window for “what’s new”.
  SinceHours = 48

  # Feeds used by fetch-trends.ps1 (sd-daily will call fetch-trends with this list).
  TrendUrls = @(
    'https://devblogs.microsoft.com/dotnet/feed/',
    'https://github.com/dotnet/runtime/releases.atom',
    'https://github.com/dotnet/sdk/releases.atom',
    'https://github.com/dotnet/aspnetcore/releases.atom',
    'https://github.com/flutter/flutter/releases.atom',
    'https://github.com/dart-lang/sdk/releases.atom',
    'https://www.reddit.com/r/dotnet/new/.rss',
    'https://www.reddit.com/r/csharp/new/.rss',
    'https://www.reddit.com/r/FlutterDev/new/.rss',
    'https://hnrss.org/frontpage?count=50'
  )

  # StartDebugging site root for internal duplicate checks.
  SiteRoot = 'https://startdebugging.net'
}

