# Fingerprint Lock

[![Available in the Obsidian community plugins directory](https://img.shields.io/badge/Obsidian-Install%20from%20directory-7c3aed?logo=obsidian&logoColor=white)](https://community.obsidian.md/plugins/fingerprint-lock)

Locks Obsidian behind a full-screen lock screen and unlocks it with your
fingerprint — **macOS Touch ID** or **Windows Hello** (fingerprint, face, or
PIN). Hardware **security keys** (YubiKey and similar, via WebAuthn) and an
optional password fallback are also supported.

**What this is not:** file encryption. Like every other Obsidian lock-screen
plugin, this only hides the UI — your notes on disk are untouched. If you
also want encryption at rest, pair this with FileVault/BitLocker or an
encrypted disk image (see the "alternatives" note at the end).

**How the biometric prompt actually gets called:** Obsidian plugins can't
call the OS biometric APIs directly — those are native APIs. So the plugin
shells out to a tiny per-platform helper in its `native/` folder:

- **macOS** — a Swift command-line helper (`native/TouchIDAuth.swift`) that
  talks to the LocalAuthentication framework. The plugin compiles and signs
  it for you on first load; nothing to do by hand.
- **Windows** — a PowerShell script (`native/WindowsHelloAuth.ps1`) that
  calls the WinRT `UserConsentVerifier` API. **Nothing to build or
  install** — Windows PowerShell 5.1 ships with every Windows 10/11 machine.

Either way, your fingerprint/face never reaches this plugin — the OS handles
the scan and the helper only relays a yes/no answer.

---

## Install

### From the Obsidian community plugins directory (recommended)

**[Install Fingerprint Lock](https://community.obsidian.md/plugins/fingerprint-lock)** — or, inside
Obsidian: **Settings → Community plugins** → turn off "Restricted mode" →
**Browse** → search for *Fingerprint Lock* → **Install**, then **Enable**.

That's the whole install. There is **nothing to build and no terminal step**:
the first time the plugin loads it writes its native helper into the plugin
folder and, on macOS, compiles and signs it for you, then offers to set a
fallback password. Installing this way also means Obsidian keeps the plugin
updated for you.

On macOS the automatic build needs the Xcode Command Line Tools (most
developer Macs already have them). If they're missing, the plugin says so and
you can install them with `xcode-select --install`, then press **Rebuild
helper** in the plugin's settings. Your password fallback works either way.

### Manually, without the directory

Prefer to install by hand, or want to run an unreleased build? Download
`main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/alexpazzy/obsidian-fingerprint/releases/latest)
and put them in a folder in your vault:

```
<YourVault>/.obsidian/plugins/fingerprint-lock/
├── main.js
├── manifest.json
└── styles.css
```

Then enable it under **Settings → Community plugins**. The helper sources are
bundled inside `main.js`, so this path sets itself up exactly like the
directory install does.

Release assets carry [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations),
so you can verify they were built from this repository:

```bash
gh attestation verify main.js -R alexpazzy/obsidian-fingerprint
```

### Building the native helper yourself (optional)

The plugin does this for you. If you'd rather do it by hand — say you cloned
the repo, or you edited `TouchIDAuth.swift` — the script is still there:

```bash
cd native
./build.sh
```

It compiles `TouchIDAuth.swift` into a binary named `Obsidian` and ad-hoc
code-signs it (required for LocalAuthentication to show the prompt). The
binary is deliberately named `Obsidian` because macOS displays the requesting
process's name in the Touch ID dialog. Test it standalone with:

```bash
./Obsidian --reason "test run"
```

On Windows there is nothing to compile at all: `WindowsHelloAuth.ps1` runs
under the Windows PowerShell 5.1 that ships with every Windows 10/11 install.
You can test it directly with:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<plugin folder>/native/WindowsHelloAuth.ps1" -Reason "test run"
```

Both helpers print `SUCCESS` (exit 0), `FAILURE:<reason>` (exit 1), or
`UNAVAILABLE:<reason>` (exit 2).

## Configure in Obsidian

On the very first launch (before any settings exist), the plugin installs the
native helper and opens a setup dialog prompting you to create a fallback
password — and it will not
lock the vault on startup until at least one unlock method can actually
succeed, so you can never be dead-ended on a fresh install. This works the
same on macOS and Windows 11.

Open **Settings → Fingerprint Lock**:

- **Test Touch ID / Test Windows Hello** — confirms the plugin can call the
  helper, without locking anything.
- **Rebuild helper / Reinstall helper** — re-runs the automatic setup. Use it
  if biometrics stop working, or after installing the Xcode Command Line
  Tools on macOS.
- **Set a password fallback** — strongly recommended. If biometrics ever
  fail (sensor issue, external display, whatever), this is your way back
  in without touching the file system.
- **Encrypt password data (end-to-end)** — optional. Instead of a salted
  PBKDF2 hash, data.json stores only an AES-256-GCM encrypted verifier;
  the key is derived from your password on your device and never written
  anywhere. Toggle it, then (re-)save your password to apply. Uses the
  built-in Web Crypto API, so it behaves identically on macOS and Windows.
- **Security keys** — register a YubiKey or other WebAuthn security key,
  then a "Use security key" button appears on the lock screen. Only keys
  you registered can unlock the vault. On Windows, the security-key prompt
  goes through the same native Windows security dialog as Hello.
- **Lock on startup / lock on blur / lock on idle** — pick whichever
  triggers you want, each with its own delay.
- **Per-note lock** — cover individual notes behind the same unlock prompt
  (see below).

Once a password fallback is set, use the ribbon lock icon or the command
palette ("Lock vault now") to test the full flow.

---

## Locking individual notes

Turn on **Per-note lock** in settings, then flag a note by adding the
property to its frontmatter:

```yaml
---
fingerprint-lock: true
---
```

Or put the cursor in the note and run **Toggle fingerprint lock for this
note** from the command palette, which adds and removes the property for you.
The property name is configurable, and `true`, `yes` and `1` all count.

Flagged notes are covered with an unlock card offering the same methods as
the vault lock screen — Touch ID or Windows Hello, a security key, or your
fallback password. An unlocked note stays open until the vault locks, at
which point every note re-locks with it.

> [!warning]
> **This hides notes; it does not encrypt them.** The text stays plaintext on
> disk and is readable by any other plugin, by your sync client, and by
> anyone opening the file outside Obsidian. Note titles still show up in
> search and Quick Switcher, and the body can still surface in search results
> and previews. Treat it as protection from someone reading over your
> shoulder — not from someone with access to your files. For real protection,
> keep the vault on an encrypted volume (see the note at the end).

---

## Rebuilding from source

If you want to modify the plugin itself rather than just use it:

```bash
npm install
npm run build      # type-checks with tsc, then bundles main.js with esbuild
```

`npm run dev` runs an esbuild watcher for iterative development.

## Troubleshooting

**macOS**

- **"The Swift compiler isn't installed"** — the automatic build needs
  `swiftc`. Run `xcode-select --install`, then press **Rebuild helper** in the
  plugin's settings.
- **"Native helper not found"** — the automatic build didn't finish, or the
  vault isn't backed by the local filesystem (this plugin is desktop-only and
  won't work on mobile). Press **Rebuild helper** in settings.
- **Touch ID prompt never appears / immediate failure** — press **Rebuild
  helper**; code signing can be invalidated if the binary is moved or edited
  afterward. Confirm Touch ID works for *anything* on your Mac first
  (System Settings → Touch ID & Password).

**Windows**

- **"Windows Hello unavailable: not set up"** — enroll a fingerprint, face,
  or PIN in Settings → Accounts → Sign-in options first.
- **Helper script missing** — the plugin writes `native/WindowsHelloAuth.ps1`
  on load; if it's gone, press **Reinstall helper** in the plugin's settings.
- **The prompt is slow to appear** — the first call spins up PowerShell,
  which can take a second or two; subsequent calls are usually faster.
- **Hello dialog offers PIN, not just fingerprint** — that's by design:
  `UserConsentVerifier` uses whatever Hello methods you have enrolled.
  Your Windows PIN is hardware-backed and machine-local.

**Security keys**

- **Registration fails immediately** — your Obsidian build's Chromium may
  not expose WebAuthn to plugins; the settings page will say so. Biometrics
  and the password fallback are unaffected.
- **Key not recognized at unlock** — only keys registered in this vault's
  settings are accepted. Re-register the key if you've reset it.

**Any platform**

- **You're locked out with no password set** — quit Obsidian, then delete
  or rename the plugin folder
  (`<YourVault>/.obsidian/plugins/fingerprint-lock`) from your file
  manager or a terminal. Reopening the vault will start it without the
  plugin. This is exactly why the settings page nags you to set a password
  fallback.

## An alternative worth knowing about

This plugin (like all Obsidian lock-screen plugins) only controls the UI.
If your actual goal is protecting the notes themselves, not just hiding the
window, consider storing the vault on an encrypted volume instead — an
encrypted APFS disk image unlocked with Touch ID via Keychain on macOS, or
a BitLocker/VeraCrypt volume on Windows — so Obsidian never sees the files
until the volume is mounted.
