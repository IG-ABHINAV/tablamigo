# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub (Security tab, "Report a vulnerability") or by email to **support@hookstep.in** with "Tablamigo security" in the subject. Do not open a public issue, pull request or discussion for a vulnerability, and do not post details anywhere public until we have fixed it.

Useful things to include: what you found, the steps to reproduce it, which part is affected (API route, mobile screen, web page), and what an attacker could do with it. A short proof of concept helps. Please test only against your own local setup or your own account, and never touch other people's data.

We aim to acknowledge your report within 5 working days, keep you updated while we work on it, and credit you in the fix if you want that.

## Scope

In scope: this repository (`apps/api`, `apps/mobile`, `apps/web`), the web app at https://tablamigo.hookstep.in/app and the Android app.

Out of scope: vulnerabilities in third-party services and libraries (report those upstream), denial-of-service by volume, and social engineering of our team or users.

## Secrets

This repository must never contain real secrets. If you find a key, token or password in the code or in the git history, report it to the same address instead of opening an issue. Local development uses placeholder values only (see `apps/api/.env.example` and `apps/mobile/.env.example`).
