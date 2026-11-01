---
title: "Converting Megabytes to Kilobytes Made Simple"
description: "Convert megabytes to kilobytes by multiplying by 1,000. Learn when to use 1,024 for MiB to KiB, with examples and a decimal-versus-binary unit table."
pubDate: 2023-11-13
updatedDate: 2026-11-01
tags:
  - "informational"
---
To convert megabytes to kilobytes, multiply by **1,000**: **1 MB = 1,000 kB**. If you mean the binary units mebibytes and kibibytes, use **1 MiB = 1,024 KiB** instead. The unit labels determine which formula to use.

## Megabytes, kilobytes, and binary units

The decimal prefixes kilo and mega represent powers of ten. The binary prefixes kibi and mebi represent powers of two. [NIST’s reference on binary prefixes](https://physics.nist.gov/cuu/Units/binary.html) explains the IEC naming convention and compares it with SI prefixes.

| Unit | Symbol | Bytes |
| --- | --- | ---: |
| Kilobyte | kB | 1,000 |
| Megabyte | MB | 1,000,000 |
| Kibibyte | KiB | 1,024 |
| Mebibyte | MiB | 1,048,576 |

“KB” is common in software interfaces, but **kB** is the decimal symbol used here. Some software labels binary measurements as KB or MB, so check the tool’s definition before converting a displayed value. Our [MB versus MiB guide](/2020/08/mib-vs-mb/) explains this labeling confusion in more detail.

## The formula: MB to kB

**Kilobytes = megabytes × 1,000**

For example:

- 5 MB × 1,000 = **5,000 kB**
- 10 MB × 1,000 = **10,000 kB**
- 0.5 MB × 1,000 = **500 kB**

To convert in the other direction, divide by 1,000. A file of 2,500 kB is 2.5 MB.

## When to multiply by 1,024

Use 1,024 when converting between the binary units **MiB and KiB**:

**Kibibytes = mebibytes × 1,024**

For example, 5 MiB is 5,120 KiB. That is a different quantity from 5 MB, so changing the unit labels without converting the value gives the wrong result.

## Converting between decimal and binary units

When crossing between the two systems, convert through bytes:

1. Multiply the starting value by the number of bytes in its unit.
2. Divide by the number of bytes in the destination unit.

For example, 1 MB is 1,000,000 bytes. Dividing by 1,024 gives **976.5625 KiB**. In the other direction, 1 MiB is 1,048,576 bytes, or **1,048.576 kB**.

This also explains why the same file can have different numerical sizes in two tools without any bytes being lost.

## Choosing the right conversion in practice

Before using a calculator or comparing a file with an upload limit, identify what each side means by its units. If a limit is documented in bytes, compare byte counts directly. If the documentation only says “MB,” check whether it uses decimal units or a binary convention.

Keep the units in spreadsheet column headings, reports, and API documentation. A value such as “5,120” is ambiguous on its own; “5,120 KiB” makes the intended quantity clear.

Also distinguish bytes from bits: **1 byte = 8 bits**. A network transfer rate in megabits per second is not a file size in megabytes.

_Corrected November 1, 2026: an earlier version incorrectly used 1,024 for MB-to-kilobyte conversion. That factor applies to MiB-to-KiB conversion; decimal MB-to-kB conversion uses 1,000._
