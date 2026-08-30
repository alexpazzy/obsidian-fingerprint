import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, TouchIDLockSettingTab, type TouchIDLockSettings } from "./settings";
import { LockScreen } from "./lockScreen";
import { getNativeBinaryPath, isBiometricPlatformSupported, runTouchIDAuth, type TouchIDResult } from "./nativeAuth";

const IDLE_CHECK_INTERVAL_MS = 5_000;
const ACTIVITY_EVENTS: Array<keyof DocumentEventMap> = ["mousemove", "mousedown", "keydown", "scroll", "wheel"];

export default class TouchIDLockPlugin extends Plugin {
	settings: TouchIDLockSettings = DEFAULT_SETTINGS;

	private lockScreen!: LockScreen;
	private nativeBinaryPath: string | null = null;
	private locked = false;

	private blurTimeoutId: number | null = null;
	private idleIntervalId: number | null = null;
	private lastActivityAt = Date.now();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.nativeBinaryPath = getNativeBinaryPath(this.app.vault, this.manifest.dir ?? "");
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
			if (this.settings.lockOnStartup) {
				this.lock();
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

	unlock(): void {
		this.locked = false;
		this.lockScreen.hide();
		this.lastActivityAt = Date.now();
	}

	get isLocked(): boolean {
		return this.locked;
	}

	async runTouchIDAuth(): Promise<TouchIDResult> {
		if (!isBiometricPlatformSupported()) {
			return {
				status: "unavailable",
				message: "Biometric unlock currently supports macOS Touch ID only. Windows Hello support is planned — use the password fallback for now.",
			};
		}
		if (!this.nativeBinaryPath) {
			return { status: "not-installed" };
		}
		return runTouchIDAuth(this.nativeBinaryPath, this.settings.touchIdReason);
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
