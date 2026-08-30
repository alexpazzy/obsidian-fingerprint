import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	hasFallbackPassword,
	TouchIDLockSettingTab,
	type TouchIDLockSettings,
} from "./settings";
import { LockScreen } from "./lockScreen";
import { FirstRunSetupModal } from "./setupModal";
import { verifyEncryptedVerifier, verifyPassword } from "./crypto";
import {
	getBiometricMethodName,
	getNativeHelperPath,
	isBiometricPlatformSupported,
	isNativeHelperInstalled,
	runBiometricAuth,
	type BiometricResult,
} from "./nativeAuth";
import { authenticateSecurityKey, type SecurityKeyResult } from "./webauthn";

const IDLE_CHECK_INTERVAL_MS = 5_000;
const ACTIVITY_EVENTS: Array<keyof DocumentEventMap> = ["mousemove", "mousedown", "keydown", "scroll", "wheel"];

export default class TouchIDLockPlugin extends Plugin {
	settings: TouchIDLockSettings = DEFAULT_SETTINGS;

	private lockScreen!: LockScreen;
	private nativeHelperPath: string | null = null;
	private locked = false;

	private blurTimeoutId: number | null = null;
	private idleIntervalId: number | null = null;
	private lastActivityAt = Date.now();
	private firstRun = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.nativeHelperPath = getNativeHelperPath(this.app.vault, this.manifest.dir ?? "");
		this.lockScreen = new LockScreen(this);

		this.addSettingTab(new TouchIDLockSettingTab(this.app, this));

		this.addRibbonIcon("lock", "Lock vault now", () => this.lock());

		this.addCommand({
			id: "lock-vault-now",
			name: "Lock vault now",
			callback: () => this.lock(),
		});

		this.registerDomEvent(window, "blur", () => this.onWindowBlur());
		this.registerDomEvent(window, "focus", () => this.onWindowFocus());

		for (const eventName of ACTIVITY_EVENTS) {
			this.registerDomEvent(document, eventName, () => {
				this.lastActivityAt = Date.now();
			});
		}

		this.app.workspace.onLayoutReady(() => {
			this.resetIdleWatcher();
			if (this.firstRun) {
				// No data.json yet: prompt for a fallback password before the
				// first lock, so a biometric failure can't dead-end the user.
				new FirstRunSetupModal(this.app, this, () => this.startupLock()).open();
			} else {
				this.startupLock();
			}
		});

		this.register(() => {
			if (this.blurTimeoutId !== null) window.clearTimeout(this.blurTimeoutId);
			if (this.idleIntervalId !== null) window.clearInterval(this.idleIntervalId);
			this.lockScreen.hide();
		});
	}

	onunload(): void {
		if (this.blurTimeoutId !== null) window.clearTimeout(this.blurTimeoutId);
		if (this.idleIntervalId !== null) window.clearInterval(this.idleIntervalId);
		this.lockScreen.hide();
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<TouchIDLockSettings> | null;
		this.firstRun = stored == null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	lock(): void {
		if (this.locked) return;
		this.locked = true;
		this.lockScreen.show();
	}

	/**
	 * Locks on startup only when at least one unlock method can actually
	 * succeed; otherwise the lock screen would be a dead end (e.g. macOS with
	 * the Touch ID helper not yet built and no fallback password).
	 */
	private startupLock(): void {
		if (!this.settings.lockOnStartup) return;
		if (!this.hasUsableUnlockMethod()) {
			new Notice(
				`Vault was NOT locked: no unlock method is available. Build the ${this.biometricMethodName} ` +
					"helper or set a fallback password in Settings → Obsidian Fingerprint.",
				10000
			);
			return;
		}
		this.lock();
	}

	private hasUsableUnlockMethod(): boolean {
		if (this.settings.passwordFallbackEnabled && this.hasFallbackPassword) return true;
		if (this.settings.securityKeyEnabled && this.settings.securityKeys.length > 0) return true;
		return isBiometricPlatformSupported() && isNativeHelperInstalled(this.nativeHelperPath);
	}

	get hasFallbackPassword(): boolean {
		return hasFallbackPassword(this.settings);
	}

	/** Checks a typed password against whichever storage format is configured. */
	async verifyFallbackPassword(password: string): Promise<boolean> {
		const { passwordSalt, passwordHash, passwordVerifier } = this.settings;
		if (passwordVerifier) {
			return verifyEncryptedVerifier(password, passwordSalt, passwordVerifier);
		}
		return verifyPassword(password, passwordSalt, passwordHash);
	}

	unlock(): void {
		this.locked = false;
		this.lockScreen.hide();
		this.lastActivityAt = Date.now();
	}

	get isLocked(): boolean {
		return this.locked;
	}

	async runBiometricAuth(): Promise<BiometricResult> {
		if (!isBiometricPlatformSupported()) {
			return {
				status: "unavailable",
				message:
					"Biometric unlock supports macOS (Touch ID) and Windows (Windows Hello). " +
					"On this platform, use a security key or the password fallback.",
			};
		}
		if (!this.nativeHelperPath) {
			return { status: "not-installed" };
		}
		return runBiometricAuth(this.nativeHelperPath, this.settings.touchIdReason);
	}

	async runSecurityKeyAuth(): Promise<SecurityKeyResult> {
		return authenticateSecurityKey(this.settings.securityKeys);
	}

	get biometricMethodName(): string {
		return getBiometricMethodName();
	}

	resetBlurWatcher(): void {
		if (this.blurTimeoutId !== null) {
			window.clearTimeout(this.blurTimeoutId);
			this.blurTimeoutId = null;
		}
	}

	resetIdleWatcher(): void {
		if (this.idleIntervalId !== null) {
			window.clearInterval(this.idleIntervalId);
			this.idleIntervalId = null;
		}
		if (!this.settings.lockOnIdle) return;

		this.lastActivityAt = Date.now();
		this.idleIntervalId = window.setInterval(() => {
			if (this.locked || !this.settings.lockOnIdle) return;
			const idleSeconds = (Date.now() - this.lastActivityAt) / 1000;
			if (idleSeconds >= this.settings.lockOnIdleDelaySeconds) {
				this.lock();
			}
		}, IDLE_CHECK_INTERVAL_MS);
	}

	private onWindowBlur(): void {
		if (!this.settings.lockOnBlur || this.locked) return;
		this.resetBlurWatcher();
		const delayMs = Math.max(0, this.settings.lockOnBlurDelaySeconds * 1000);
		this.blurTimeoutId = window.setTimeout(() => {
			this.blurTimeoutId = null;
			this.lock();
		}, delayMs);
	}

	private onWindowFocus(): void {
		this.resetBlurWatcher();
	}
}
