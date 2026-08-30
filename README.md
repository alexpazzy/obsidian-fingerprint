# Obsidian Fingerprint

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
  talks to the LocalAuthentication framework. You compile it once, locally,
  with the included script.
- **Windows** — a PowerShell script (`native/WindowsHelloAuth.ps1`) that
  calls the WinRT `UserConsentVerifier` API. **Nothing to build or
  install** — Windows PowerShell 5.1 ships with every Windows 10/11 machine.

Either way, your fingerprint/face never reaches this plugin — the OS handles
the scan and the helper only relays a yes/no answer.

---

## 1. Install the plugin files

Copy this whole folder into your vault's plugins directory, so it becomes:

```
<YourVault>/.obsidian/plugins/obsidian-fingerprint/
├── main.js
├── manifest.json
├── styles.css
└── native/
    ├── TouchIDAuth.swift      (macOS)
    ├── build.sh               (macOS)
    └── WindowsHelloAuth.ps1   (Windows)
```

Then in Obsidian: **Settings → Community plugins** → make sure "Restricted
mode" is off → find "Obsidian Fingerprint" in the list → enable it.

## 2a. Windows setup

There is none. If Windows Hello works on your machine (Settings → Accounts →
Sign-in options — a fingerprint, face, or PIN is enrolled), the plugin works.
Open **Settings → Obsidian Fingerprint → Test Windows Hello** to confirm:
you should get the standard Windows Hello dialog.

You can also test the helper standalone from a terminal:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<YourVault>/.obsidian/plugins/obsidian-fingerprint/native/WindowsHelloAuth.ps1" -Reason "test run"
```

It prints `SUCCESS` (exit 0), `FAILURE:<reason>` (exit 1), or
`UNAVAILABLE:<reason>` (exit 2) — the same protocol the macOS helper speaks.

## 2b. macOS setup — build the Touch ID helper (one-time)

You need Xcode or the Xcode Command Line Tools installed
(`xcode-select --install` if you're not sure).

```bash
cd "<YourVault>/.obsidian/plugins/obsidian-fingerprint/native"
./build.sh
```

This compiles `TouchIDAuth.swift` into a binary named `Obsidian` right next
to it and ad-hoc code-signs it (required for LocalAuthentication to allow the
prompt). The binary is deliberately named `Obsidian` because macOS displays
the requesting process's name in the Touch ID dialog. You can test it
standalone before touching Obsidian at all:

```bash
./Obsidian --reason "test run"
```

## 3. Configure in Obsidian

On the very first launch (before any settings exist), the plugin opens a
setup dialog prompting you to create a fallback password — and it will not
lock the vault on startup until at least one unlock method can actually
succeed, so you can never be dead-ended on a fresh install. This works the
same on macOS and Windows 11.

Open **Settings → Obsidian Fingerprint**:

- **Test Touch ID / Test Windows Hello** — confirms the plugin can call the
  helper, without locking anything.
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

Once a password fallback is set, use the ribbon lock icon or the command
palette ("Lock vault now") to test the full flow.

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

- **"Native helper not found"** — you haven't run `native/build.sh` yet, or
  the vault isn't backed by the local filesystem (this plugin is
  desktop-only and won't work on mobile).
- **Touch ID prompt never appears / immediate failure** — re-run
  `native/build.sh`; codesigning can be invalidated if you move or edit the
  binary afterward. Confirm Touch ID works for *anything* on your Mac
  first (System Settings → Touch ID & Password).

**Windows**

- **"Windows Hello unavailable: not set up"** — enroll a fingerprint, face,
  or PIN in Settings → Accounts → Sign-in options first.
- **Helper script missing** — the plugin folder should contain
  `native/WindowsHelloAuth.ps1`; if it doesn't, reinstall the plugin.
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
  (`<YourVault>/.obsidian/plugins/obsidian-fingerprint`) from your file
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
