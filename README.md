# Obsidian Fingerprint

Locks Obsidian behind a full-screen lock screen and unlocks it with your
fingerprint. macOS Touch ID is supported today; Windows Hello support is
planned (see the roadmap at the end). Includes an optional password fallback.

**What this is not:** file encryption. Like every other Obsidian lock-screen
plugin, this only hides the UI — your notes on disk are untouched. If you
also want encryption at rest, pair this with FileVault or an encrypted disk
image (see the "alternatives" note at the end).

**How Touch ID actually gets called:** Obsidian plugins can't call Apple's
LocalAuthentication framework directly — that's a native, Swift-only API.
So this plugin ships a tiny separate command-line helper
(`native/TouchIDAuth.swift`) that talks to LocalAuthentication, and the
plugin's JS shells out to it via Node's `child_process`. You compile that
helper once, locally, with the included script. Your fingerprint never
leaves the Secure Enclave — this plugin (and the helper) only ever get a
yes/no answer back from macOS.

---

## 1. Install the plugin files

Copy this whole folder into your vault's plugins directory, so it becomes:

```
<YourVault>/.obsidian/plugins/obsidian-fingerprint/
├── main.js
├── manifest.json
├── styles.css
└── native/
    ├── TouchIDAuth.swift
    └── build.sh
```

Then in Obsidian: **Settings → Community plugins** → make sure "Restricted
mode" is off → find "Obsidian Fingerprint" in the list → enable it.

## 2. Build the Touch ID helper (one-time, on your Mac)

You need Xcode or the Xcode Command Line Tools installed
(`xcode-select --install` if you're not sure).

```bash
cd "<YourVault>/.obsidian/plugins/obsidian-fingerprint/native"
./build.sh
```

This compiles `TouchIDAuth.swift` into a binary named `Obsidian` right next
to it and ad-hoc code-signs it (required for LocalAuthentication to allow the
prompt). The binary is deliberately named `Obsidian` because macOS displays
the requesting process's name in the Touch ID dialog — this way the prompt
says "Obsidian" instead of a cryptic helper name. You can test it standalone
before touching Obsidian at all:

```bash
./Obsidian --reason "test run"
```

You should see a Touch ID prompt. It prints `SUCCESS` and exits 0 on
success, or `FAILURE:<reason>` / exit 1 if you cancel or fail the scan.

## 3. Configure in Obsidian

Open **Settings → Obsidian Fingerprint**:

- **Test Touch ID** — confirms the plugin can find and call the binary,
  without locking anything.
- **Set a password fallback** — strongly recommended. If Touch ID ever
  fails (sensor issue, external display, whatever), this is your way back
  in without touching the file system.
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

- **"Native helper not found"** — you haven't run `native/build.sh` yet, or
  the vault isn't backed by the local filesystem (this plugin is
  desktop-only and won't work on mobile).
- **Touch ID prompt never appears / immediate failure** — re-run
  `native/build.sh`; codesigning can be invalidated if you move or edit the
  binary afterward. Confirm Touch ID works for *anything* on your Mac
  first (System Settings → Touch ID & Password).
- **You're locked out with no password set** — quit Obsidian, then delete
  or rename the plugin folder
  (`<YourVault>/.obsidian/plugins/obsidian-fingerprint`) from Finder or Terminal.
  Reopening the vault will start it without the plugin. This is exactly why
  the settings page nags you to set a password fallback.

## Roadmap

- **Windows 11 (Windows Hello)** — planned. The plugin is structured for it:
  the lock screen and password fallback are already platform-neutral, and
  biometrics go through a per-platform helper binary. Windows support means
  adding a small helper that calls the Windows Hello API
  (`UserConsentVerifier`) and teaching `nativeAuth.ts` to pick the right
  helper per platform. Until then, the plugin runs on Windows but reports
  biometrics as unavailable and relies on the password fallback.

## An alternative worth knowing about

This plugin (like all Obsidian lock-screen plugins) only controls the UI.
If your actual goal is protecting the notes themselves, not just hiding the
window, consider storing the vault on an encrypted APFS disk image instead
and unlocking *that* with Touch ID via Keychain — Obsidian then simply
never sees the files until the volume is mounted.
