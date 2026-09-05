import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	hasFallbackPassword,
	TouchIDLockSettingTab,
	type TouchIDLockSettings,
} from "./settings";
import { LockScreen } from "./lockScreen";
import { FirstRunSetupModal } from "./setupModal";
import { NoteGuard } from "./noteGuard";
import { verifyEncryptedVerifier, verifyPassword } from "./crypto";
import {
	ensureNativeHelper,
	getBiometricMethodName,
	getNativeDir,
	getNativeHelperPath,
	isBiometricPlatformSupported,
	isNativeHelperInstalled,
	runBiometricAuth,
	type BiometricResult,
	type HelperSetupResult,
} from "./nativeAuth";
import { authenticateSecurityKey, type SecurityKeyResult } from "./webauthn";

const IDLE_CHECK_INTERVAL_MS = 5_000;
const ACTIVITY_EVENTS: Array<keyof DocumentEventMap> = ["mousemove", "mousedown", "keydown", "scroll", "wheel"];

export default class TouchIDLockPlugin extends Plugin {
	settings: TouchIDLockSettings = DEFAULT_SETTINGS;

	private lockScreen!: LockScreen;
	private noteGuard!: NoteGuard;
	private nativeHelperPath: string | null = null;
	private nativeDir: string | null = null;
	/** Why the last helper setup attempt failed, so the lock screen can explain. */
	helperSetupError: string | null = null;
	private locked = false;

	private blurTimeoutId: number | null = null;
	private idleIntervalId: number | null = null;
	private lastActivityAt = Date.now();
	private firstRun = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		const pluginDir = this.manifest.dir ?? "";
		this.nativeHelperPath = getNativeHelperPath(this.app.vault, pluginDir);
		this.nativeDir = getNativeDir(this.app.vault, pluginDir);
		this.lockScreen = new LockScreen(this);
		this.noteGuard = new NoteGuard(this);

		this.addSettingTab(new TouchIDLockSettingTab(this.app, this));

		this.addRibbonIcon("lock", "Lock vault now", () => this.lock());

		this.addCommand({
			id: "lock-vault-now",
			name: "Lock vault now",
			callback: () => this.lock(),
		});

		this.addCommand({
			id: "toggle-note-lock",
			name: "Toggle fingerprint lock for this note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) void this.toggleNoteLock(file);
				return true;
			},
		});

		// Re-evaluate note overlays whenever the layout, the open file, or the
		// note's own frontmatter changes.
		const refreshGuard = () => this.noteGuard.refresh();
		this.registerEvent(this.app.workspace.on("file-open", refreshGuard));
		this.registerEvent(this.app.workspace.on("layout-change", refreshGuard));
		this.registerEvent(this.app.workspace.on("active-leaf-change", refreshGuard));
		this.registerEvent(this.app.metadataCache.on("changed", refreshGuard));

		this.registerDomEvent(window, "blur", () => this.onWindowBlur());
		this.registerDomEvent(window, "focus", () => this.onWindowFocus());

		for (const eventName of ACTIVITY_EVENTS) {
			this.registerDomEvent(document, eventName, () => {
				this.lastActivityAt = Date.now();
			});
		}

		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady();
		});

		this.register(() => {
			if (this.blurTimeoutId !== null) window.clearTimeout(this.blurTimeoutId);
			if (this.idleIntervalId !== null) window.clearInterval(this.idleIntervalId);
			this.lockScreen.hide();
			this.noteGuard.clear();
		});
	}

	private async onLayoutReady(): Promise<void> {
		this.resetIdleWatcher();
		this.noteGuard.refresh();

		if (this.firstRun) {
			// No data.json yet: install the native helper and prompt for a
			// fallback password before the first lock, so the user never has to
			// run a build script and a biometric failure can't dead-end them.
			new FirstRunSetupModal(this.app, this, () => this.startupLock()).open();
			return;
		}

		// Keep the helper in place on later launches too: a plugin update
		// replaces main.js only, and the helper can go missing or go stale.
		await this.setUpNativeHelper();
		this.startupLock();
	}

	/** Installs (and on macOS compiles) this platform's biometric helper. */
	async setUpNativeHelper(options: { force?: boolean } = {}): Promise<HelperSetupResult> {
		const result = await ensureNativeHelper(this.nativeDir, this.nativeHelperPath, options);
		if (result.status === "ready") {
			this.helperSetupError = null;
		} else if (result.status === "failed") {
			this.helperSetupError = result.message;
		}
		return result;
	}

	/** Re-applies note overlays, e.g. after the per-note settings change. */
	refreshNoteGuard(): void {
		if (this.settings.perNoteLockEnabled) {
			this.noteGuard.refresh();
		} else {
			this.noteGuard.clear();
		}
	}

	/** Adds or removes the lock property on a note's frontmatter. */
	private async toggleNoteLock(file: TFile): Promise<void> {
		const property = this.settings.lockedNoteProperty.trim() || "fingerprint-lock";
		const wasProtected = this.noteGuard.isProtected(file);

		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			if (wasProtected) {
				delete frontmatter[property];
			} else {
				frontmatter[property] = true;
			}
		});

		if (wasProtected) {
			new Notice(`"${file.basename}" is no longer locked.`);
		} else {
			// Lock it right away rather than leaving the open copy visible.
			this.noteGuard.relock(file);
			new Notice(
				this.settings.perNoteLockEnabled
					? `"${file.basename}" is now locked.`
					: `"${file.basename}" is flagged, but per-note lock is off in settings.`
			);
		}
		this.noteGuard.refresh();
	}

	get isNativeHelperReady(): boolean {
		return isNativeHelperInstalled(this.nativeHelperPath);
	}

	onunload(): void {
		if (this.blurTimeoutId !== null) window.clearTimeout(this.blurTimeoutId);
		if (this.idleIntervalId !== null) window.clearInterval(this.idleIntervalId);
		this.lockScreen.hide();
		this.noteGuard.clear();
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
		// Re-lock individual notes alongside the vault, so unlocking the vault
		// doesn't silently hand back notes that were opened earlier.
		this.noteGuard.lockAll();
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
					"helper or set a fallback password in Settings → Fingerprint Lock.",
				10000
			);
			return;
		}
		this.lock();
	}

	private hasUsableUnlockMethod(): boolean {
		if (this.settings.passwordFallbackEnabled && this.hasFallbackPassword) return true;
		if (this.settings.securityKeyEnabled && this.settings.securityKeys.length > 0) return true;
		return isBiometricPlatformSupported() && this.isNativeHelperReady;
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
