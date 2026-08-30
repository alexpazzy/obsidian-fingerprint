import { execFile, type ExecFileException } from "child_process";
import { FileSystemAdapter, type Vault } from "obsidian";
import * as path from "path";

export type TouchIDResult =
	| { status: "success" }
	| { status: "failed"; message: string }
	| { status: "unavailable"; message: string }
	| { status: "not-installed" };

/**
 * Biometric unlock is macOS-only for now (Touch ID via LocalAuthentication).
 * Windows Hello support is planned; it will slot in here as a second
 * platform backend with its own helper binary.
 */
export function isBiometricPlatformSupported(): boolean {
	return process.platform === "darwin";
}

const AUTH_TIMEOUT_MS = 60_000;
const SUCCESS_MARKER = "SUCCESS";
const FAILURE_PREFIX = "FAILURE:";
const UNAVAILABLE_PREFIX = "UNAVAILABLE:";

/**
 * Resolves the absolute path to the compiled `touchid-auth` helper binary
 * that ships (once built) inside this plugin's `native/` folder.
 * Returns null if the vault isn't backed by the local filesystem (e.g. mobile).
 */
export function getNativeBinaryPath(vault: Vault, pluginDir: string): string | null {
	const adapter = vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		return null;
	}
	const pluginAbsolutePath = adapter.getFullPath(pluginDir);
	// The helper binary is named "Obsidian" because macOS shows the requesting
	// process's name in the Touch ID dialog.
	return path.join(pluginAbsolutePath, "native", "Obsidian");
}

function isErrnoException(err: unknown): err is ExecFileException & { code?: string; killed?: boolean } {
	return typeof err === "object" && err !== null;
}

export function runTouchIDAuth(binaryPath: string, reason: string): Promise<TouchIDResult> {
	return new Promise((resolve) => {
		execFile(
			binaryPath,
			["--reason", reason],
			{ timeout: AUTH_TIMEOUT_MS, windowsHide: true },
			(error, stdout, stderr) => {
				const out = (stdout ?? "").trim();

				if (error) {
					if (isErrnoException(error) && error.code === "ENOENT") {
						resolve({ status: "not-installed" });
						return;
					}
					if (out.startsWith(UNAVAILABLE_PREFIX)) {
						resolve({ status: "unavailable", message: out.slice(UNAVAILABLE_PREFIX.length).trim() });
						return;
					}
					if (out.startsWith(FAILURE_PREFIX)) {
						resolve({ status: "failed", message: out.slice(FAILURE_PREFIX.length).trim() });
						return;
					}
					if (isErrnoException(error) && error.killed) {
						resolve({ status: "failed", message: "Touch ID request timed out." });
						return;
					}
					resolve({ status: "failed", message: (stderr ?? "").trim() || error.message });
					return;
				}

				if (out === SUCCESS_MARKER) {
					resolve({ status: "success" });
					return;
				}

				resolve({ status: "failed", message: out || "Unexpected response from the Touch ID helper." });
			}
		);
	});
}
