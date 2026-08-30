import { execFile, type ExecFileException } from "child_process";
import { FileSystemAdapter, type Vault } from "obsidian";
import * as fs from "fs";
import * as path from "path";

export type BiometricResult =
	| { status: "success" }
	| { status: "failed"; message: string }
	| { status: "unavailable"; message: string }
	| { status: "not-installed" };

export type BiometricPlatform = "touchid" | "windows-hello";

/**
 * Biometric unlock is backed by a per-platform helper:
 *  - macOS: a compiled Swift binary calling LocalAuthentication (Touch ID).
 *  - Windows: a PowerShell script calling WinRT's UserConsentVerifier
 *    (Windows Hello — fingerprint, face, or PIN). No build step needed;
 *    Windows PowerShell 5.1 ships with every Windows 10/11 install.
 * Both speak the same stdout protocol: SUCCESS / FAILURE:<msg> / UNAVAILABLE:<msg>.
 */
export function getBiometricPlatform(): BiometricPlatform | null {
	if (process.platform === "darwin") return "touchid";
	if (process.platform === "win32") return "windows-hello";
	return null;
}

export function isBiometricPlatformSupported(): boolean {
	return getBiometricPlatform() !== null;
}

/** Human-readable name of this platform's biometric method, for UI labels. */
export function getBiometricMethodName(): string {
	switch (getBiometricPlatform()) {
		case "touchid":
			return "Touch ID";
		case "windows-hello":
			return "Windows Hello";
		default:
			return "Biometrics";
	}
}

const AUTH_TIMEOUT_MS = 60_000;
const SUCCESS_MARKER = "SUCCESS";
const FAILURE_PREFIX = "FAILURE:";
const UNAVAILABLE_PREFIX = "UNAVAILABLE:";

/**
 * Resolves the absolute path to this platform's helper inside the plugin's
 * `native/` folder. Returns null if the vault isn't backed by the local
 * filesystem (e.g. mobile) or the platform has no biometric helper.
 */
export function getNativeHelperPath(vault: Vault, pluginDir: string): string | null {
	const adapter = vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		return null;
	}
	const pluginAbsolutePath = adapter.getFullPath(pluginDir);
	switch (getBiometricPlatform()) {
		case "touchid":
			// The helper binary is named "Obsidian" because macOS shows the
			// requesting process's name in the Touch ID dialog.
			return path.join(pluginAbsolutePath, "native", "Obsidian");
		case "windows-hello":
			return path.join(pluginAbsolutePath, "native", "WindowsHelloAuth.ps1");
		default:
			return null;
	}
}

function isErrnoException(err: unknown): err is ExecFileException & { code?: string; killed?: boolean } {
	return typeof err === "object" && err !== null;
}

function parseHelperOutput(
	error: ExecFileException | null,
	stdout: string,
	stderr: string,
	methodName: string
): BiometricResult {
	const out = stdout.trim();

	// The helpers report structured results on stdout even when exiting non-zero,
	// so check for the protocol markers before treating an error as fatal.
	if (out.startsWith(UNAVAILABLE_PREFIX)) {
		return { status: "unavailable", message: out.slice(UNAVAILABLE_PREFIX.length).trim() };
	}
	if (out.startsWith(FAILURE_PREFIX)) {
		return { status: "failed", message: out.slice(FAILURE_PREFIX.length).trim() };
	}
	if (out === SUCCESS_MARKER && !error) {
		return { status: "success" };
	}

	if (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			return { status: "not-installed" };
		}
		if (isErrnoException(error) && error.killed) {
			return { status: "failed", message: `${methodName} request timed out.` };
		}
		return { status: "failed", message: stderr.trim() || error.message };
	}

	return { status: "failed", message: out || `Unexpected response from the ${methodName} helper.` };
}

export function runBiometricAuth(helperPath: string, reason: string): Promise<BiometricResult> {
	const platform = getBiometricPlatform();
	const methodName = getBiometricMethodName();

	if (!platform) {
		return Promise.resolve({
			status: "unavailable",
			message: "Biometric unlock is only supported on macOS and Windows.",
		});
	}

	let command: string;
	let args: string[];
	if (platform === "windows-hello") {
		// The script ships with the plugin, so a missing file means a broken
		// install — surface that as not-installed rather than a PowerShell error.
		if (!fs.existsSync(helperPath)) {
			return Promise.resolve({ status: "not-installed" });
		}
		// Windows PowerShell 5.1 (powershell.exe) specifically: its WinRT
		// projection is what lets the script reach UserConsentVerifier.
		command = "powershell.exe";
		args = [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			helperPath,
			"-Reason",
			reason,
		];
	} else {
		command = helperPath;
		args = ["--reason", reason];
	}

	return new Promise((resolve) => {
		execFile(command, args, { timeout: AUTH_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
			resolve(parseHelperOutput(error, stdout ?? "", stderr ?? "", methodName));
		});
	});
}
