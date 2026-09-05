import { execFile, type ExecFileException } from "child_process";
import { FileSystemAdapter, type Vault } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import touchIdSource from "../native/TouchIDAuth.swift";
import windowsHelloSource from "../native/WindowsHelloAuth.ps1";

export type BiometricResult =
	| { status: "success" }
	| { status: "failed"; message: string }
	| { status: "unavailable"; message: string }
	| { status: "not-installed" };

/** Outcome of preparing this platform's helper (writing sources, compiling on macOS). */
export type HelperSetupResult =
	| { status: "ready" }
	| { status: "unsupported"; message: string }
	| { status: "failed"; message: string };

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

/** Whether the platform helper actually exists on disk (e.g. build.sh has been run on macOS). */
export function isNativeHelperInstalled(helperPath: string | null): boolean {
	return helperPath !== null && fs.existsSync(helperPath);
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

const BUILD_TIMEOUT_MS = 120_000;

/** Absolute path to the plugin's `native/` folder, or null off the local filesystem. */
export function getNativeDir(vault: Vault, pluginDir: string): string | null {
	const adapter = vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return null;
	return path.join(adapter.getFullPath(pluginDir), "native");
}

/**
 * Writes the helper sources into the plugin's `native/` folder if they aren't
 * already there. Installing from the community directory only delivers
 * main.js, manifest.json and styles.css, so the sources are bundled into
 * main.js as text and materialized here instead of being assumed on disk.
 */
function writeHelperSources(nativeDir: string): void {
	fs.mkdirSync(nativeDir, { recursive: true });
	const files: Array<[string, string]> = [
		["TouchIDAuth.swift", touchIdSource],
		["WindowsHelloAuth.ps1", windowsHelloSource],
	];
	for (const [name, contents] of files) {
		const target = path.join(nativeDir, name);
		// Rewrite only when missing or changed, so a user's local edits to a
		// current-version source aren't clobbered on every launch.
		if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== contents) {
			fs.writeFileSync(target, contents, "utf8");
		}
	}
}

function execFileAsync(
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number }
): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ error, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

/**
 * Prepares this platform's biometric helper so the user doesn't have to run
 * anything in a terminal:
 *  - Windows: writes WindowsHelloAuth.ps1; nothing to compile.
 *  - macOS: writes TouchIDAuth.swift, then compiles and ad-hoc signs it into
 *    a binary named "Obsidian" (macOS shows the calling process's name in the
 *    Touch ID dialog). Requires the Xcode Command Line Tools for swiftc.
 * Safe to call on every launch: it returns "ready" immediately once the
 * helper is in place.
 */
export async function ensureNativeHelper(
	nativeDir: string | null,
	helperPath: string | null,
	options: { force?: boolean } = {}
): Promise<HelperSetupResult> {
	const platform = getBiometricPlatform();
	if (!platform) {
		return {
			status: "unsupported",
			message: "Biometric unlock is only supported on macOS and Windows.",
		};
	}
	if (!nativeDir || !helperPath) {
		return {
			status: "unsupported",
			message: "This vault isn't stored on the local filesystem, so the helper can't be installed.",
		};
	}

	try {
		writeHelperSources(nativeDir);
	} catch (err) {
		return {
			status: "failed",
			message: `Couldn't write the helper into the plugin folder: ${errorMessage(err)}`,
		};
	}

	// Windows Hello runs the script directly — writing it is all that's needed.
	if (platform === "windows-hello") {
		return fs.existsSync(helperPath)
			? { status: "ready" }
			: { status: "failed", message: "The Windows Hello helper script could not be created." };
	}

	if (!options.force && fs.existsSync(helperPath)) {
		return { status: "ready" };
	}
	return compileTouchIdHelper(nativeDir, helperPath);
}

/** Compiles and ad-hoc signs the macOS Touch ID helper. */
async function compileTouchIdHelper(nativeDir: string, helperPath: string): Promise<HelperSetupResult> {
	const which = await execFileAsync("/usr/bin/which", ["swiftc"], { timeout: 15_000 });
	if (which.error || !which.stdout.trim()) {
		return {
			status: "failed",
			message:
				"The Swift compiler isn't installed, so the Touch ID helper can't be built. Run " +
				"xcode-select --install in Terminal, then build it from this plugin's settings.",
		};
	}

	const compile = await execFileAsync(
		"swiftc",
		["-O", "TouchIDAuth.swift", "-o", path.basename(helperPath)],
		{ cwd: nativeDir, timeout: BUILD_TIMEOUT_MS }
	);
	if (compile.error) {
		return {
			status: "failed",
			message: `Compiling the Touch ID helper failed: ${compile.stderr.trim() || errorMessage(compile.error)}`,
		};
	}

	// LocalAuthentication refuses to show the prompt for an unsigned binary.
	const sign = await execFileAsync(
		"codesign",
		["--force", "--identifier", "Obsidian", "--sign", "-", path.basename(helperPath)],
		{ cwd: nativeDir, timeout: BUILD_TIMEOUT_MS }
	);
	if (sign.error) {
		return {
			status: "failed",
			message: `Signing the Touch ID helper failed: ${sign.stderr.trim() || errorMessage(sign.error)}`,
		};
	}

	try {
		fs.chmodSync(helperPath, 0o755);
	} catch (err) {
		return { status: "failed", message: `Couldn't make the helper executable: ${errorMessage(err)}` };
	}

	return fs.existsSync(helperPath)
		? { status: "ready" }
		: { status: "failed", message: "The Touch ID helper binary wasn't produced." };
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
