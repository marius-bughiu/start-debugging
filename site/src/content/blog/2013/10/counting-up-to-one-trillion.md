---
title: "How long does it take a PC to count to one trillion"
description: "Benchmarking how long it takes a PC to count to one trillion and beyond, with updated results from 2023."
pubDate: 2013-10-13
updatedDate: 2023-11-05
tags:
  - "csharp"
---
This is a question that came up during a discussion with a colleague over some company worth over 20 trillion dollars -- and we just couldn't imagine what that much money would look like in cash. Just to get an idea of it, we calculated how many hundred dollar bills it would take to circle the Earth once – the answer was I believe around 240.000.000 meaning around 24 billion US dollars. That’s a lot of money. How much would it take a person to count that much money? Well, nobody can say for sure, but it’s somewhere in the tens of thousands of years.

That being said, we can get a pretty good impression of how long it would take a computer to count up to one trillion. To simply iterate, no other action in between. For that I wrote a simple piece of code that measures how long it takes to count up to one billion and then does some simple math to estimate how long it would take to count up to different values, displaying the results in a friendly way.

The results are interesting. And the answer is: it depends on your machine. Even on the same machine you will get different results depending on the load. But let’s look at mine for a bit:

**Updated results as of October 2023** – this time on a liquid-cooled i9-11900k.

```plaintext
9 minutes, 38 seconds         for 1 trillion (12 zeros)
6 days, 16 hours              for 1 quadrillion (15 zeros)
18 years, 130 days            for 1 quintillion (18 zeros)
18356 years, 60 days          for 1 sextillion (21 zeros)
```

It’s quite interesting to compare these results to the ones from 10 years ago when I originally created this post. The time dropped from several hours to under 10 minutes. Now of course, we are in a way comparing apples to oranges due to the fact that the original benchmark was ran on a budget laptop CPU, while the updated numbers are from running an unlocked desktop CPU with liquid cooling. But still, curious to see how this evolves over time.

> Original results from 2013, executed on a laptop are as follows:
> 
> -   one billion (9 zeros) is being reached fast – 15 seconds
> -   but to get to one trillion (12 zeros) – the difference is amazing – 4 hours and 10 minutes. Basically 1000 times more.
> -   the differences get even more impressive as we go up to quadrillions (15 zeros)  which would take 173 days and then quintillions (18 zeros) which would take 475 years
> -   the last one for which I did the math is one sextillion (21 zeros) and get ready – it would take my laptop exactly 475473 years, 292 days, 6 hours, 43 minutes and 52 seconds to iterate up to that value.

As I’ve said – these values depend a lot on the machine. So you can give it a try yourself and maybe share the results. Code below:

```cs
using System.Diagnostics;

var sw = new Stopwatch();
sw.Start();

// 10 billion iterations (10 zeros)
for (long i = 1; i <= 10000000000; i++) ;

sw.Stop();

Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100)} for 1 trillion (12 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000)} for 1 quadrillion (15 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000)} for 1 quintillion (18 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000000)} for 1 sextillion (21 zeros)");

Console.ReadKey();

string FormatString(long elapsed, long multiplier)
{
    var span = new TimeSpan(elapsed * multiplier).Duration();

    return string.Format("{0}{1}{2}{3}{4}",
        span.Days > 364 ? $"{span.Days / 365} years, " : "",
        span.Days > 0        ? $"{span.Days % 365} days, "  : "",
        span.Hours > 0       ? $"{span.Hours} hours, "      : "",
        span.Minutes > 0     ? $"{span.Minutes} minutes, "  : "",
        span.Seconds > 0     ? $"{span.Seconds} seconds"    : "");
}
```

## How about iterating through all the GUIDs?

Then, in the true spirit of an engineer, I switched to another subject – totally related (for me) – the uniqueness of GUIDs. I had previously asked myself how unique a GUID actually is. And I somewhat got my answer back then but now I think it’s even more clear.

To start – GUIDs are usually represented as 32 hexadecimal digits – so we can take the highest 32-hex number (`ffffffffffffffffffffffffffffffff`) and convert it to decimal, to obtain: 340,282,366,920,938,463,463,374,607,431,768,211,455 – that’s 39 digits and in rounded plain English: 340 undecillions.

So if my math is correct, we take the time from the sixtillion (18365 years) – multiply it by 1.000.000.000.000.000 (the extra 15 digits between undecillion and sextillion), then by 340 – since we’re talking about 340 undecillions.

That’s about 6,244,100,000,000,000,000,000 years – meaning 6,244,100,000,000 million millennia. That’s how much it would take my computer to iterate through all the possible values of a GUID. Now how unique is that?
