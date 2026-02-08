---
title: "Windows 8 and Secure Boot – What if your PC doesn’t support it?"
description: "What to do when you get the 'Secure Boot isn't compatible with your PC' error while installing Windows 8, and what Secure Boot actually is."
pubDate: 2012-06-05
updatedDate: 2023-11-05
tags:
  - "windows"
---
So today, while (by mistake) attempting to upgrade my Windows 7 to Windows 8 I ran into a compatibility check with 6 errors including one that states:

> Secure Boot isn’t compatible with your PC

At first it gave me the creeps thinking that I won’t be able to install Windows 8 although the Consumer Preview ran just fine (with a few exceptions) but then, a couple of searches later, I realized that this won’t be a problem at all. Secure Boot is a feature that you can just skip and everything will work just fine.

**So what exactly is Secure Boot?**

Secure Boot is a new boot process (measured boot) which together with UEFI 2.3.1 (Unified Extensible Firmware Interface) addresses an existing security hole in the current BIOS design which allows malicious software to be loaded before the operating system. This is done through the use of certificates – basically nothing will be loaded unless signed by Microsoft – meaning no malware.

This feature is only available on rather new systems because it relies on a chip called Trusted Platform Module or TPM. This chip is used to store the actual signed, protected and measured start-up processes on which Secure Boot relies.

So no TPM – no Secure Boot, just the normal one – meaning that this will not prevent you from installing Windows 8 on your machine.
