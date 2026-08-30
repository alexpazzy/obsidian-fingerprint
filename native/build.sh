#!/bin/bash
# Compiles the Touch ID helper binary. Run this once on your Mac after
# installing the plugin (and again if you ever edit TouchIDAuth.swift).
#
#   cd native
#   ./build.sh
#
# The binary is named "Obsidian" on purpose: macOS shows the requesting
# process's name in the Touch ID dialog, so this makes the prompt read
# "Obsidian" instead of a cryptic helper name.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "error: swiftc not found. Install Xcode or the Xcode Command Line Tools:" >&2
	echo "  xcode-select --install" >&2
	exit 1
fi

echo "Compiling TouchIDAuth.swift -> Obsidian ..."
swiftc -O TouchIDAuth.swift -o Obsidian

echo "Ad-hoc signing Obsidian ..."
codesign --force --identifier Obsidian --sign - Obsidian

chmod +x Obsidian

# Clean up a binary left over from versions that used the old name.
rm -f touchid-auth

echo
echo "Done. Built: $(pwd)/Obsidian"
echo "Test it directly with:"
echo "  ./Obsidian --reason \"test run\""
echo
echo "Then in Obsidian, open Settings -> Touch ID Lock -> \"Run test\" to confirm the plugin can call it."
