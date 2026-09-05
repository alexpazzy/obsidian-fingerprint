import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	type ButtonComponent,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from "obsidian";
import type TouchIDLockPlugin from "./main";
import { createEncryptedVerifier, generateSalt, hashPassword } from "./crypto";
import { getBiometricMethodName, getBiometricPlatform, isBiometricPlatformSupported } from "./nativeAuth";
import { isWebAuthnAvailable, registerSecurityKey, type SecurityKeyInfo } from "./webauthn";

export interface TouchIDLockSettings {
	lockOnStartup: boolean;
	lockOnBlur: boolean;
	lockOnBlurDelaySeconds: number;
	lockOnIdle: boolean;
	lockOnIdleDelaySeconds: number;
	/** Prompt text shown in the biometric dialog (Touch ID and Windows Hello alike). */
	touchIdReason: string;
	passwordFallbackEnabled: boolean;
	passwordSalt: string;
	passwordHash: string;
	/** When true, new passwords are stored as an AES-GCM encrypted verifier instead of a hash. */
	passwordEncrypted: boolean;
	/** iv+ciphertext (hex) of the encrypted verifier; set instead of passwordHash in encrypted mode. */
	passwordVerifier: string;
	securityKeyEnabled: boolean;
	securityKeys: SecurityKeyInfo[];
	/** Cover individual notes flagged with the frontmatter property below. */
	perNoteLockEnabled: boolean;
	/** Frontmatter property that marks a note as locked. */
	lockedNoteProperty: string;
}

export const DEFAULT_SETTINGS: TouchIDLockSettings = {
	lockOnStartup: true,
	lockOnBlur: true,
	lockOnBlurDelaySeconds: 30,
	lockOnIdle: false,
	lockOnIdleDelaySeconds: 300,
	touchIdReason: "unlock your Obsidian vault",
	passwordFallbackEnabled: false,
	passwordSalt: "",
	passwordHash: "",
	passwordEncrypted: false,
	passwordVerifier: "",
	securityKeyEnabled: false,
	securityKeys: [],
	perNoteLockEnabled: false,
	lockedNoteProperty: "fingerprint-lock",
};

/** True when a fallback password is configured in either storage format. */
export function hasFallbackPassword(settings: TouchIDLockSettings): boolean {
	return Boolean(settings.passwordHash || settings.passwordVerifier);
}

/**
 * Stores `password` into `settings` (fresh salt each time), honoring the
 * passwordEncrypted option: either a PBKDF2 hash or an AES-GCM encrypted
 * verifier — never both. Caller is responsible for persisting the settings.
 */
export async function storeFallbackPassword(
	settings: TouchIDLockSettings,
	password: string
): Promise<void> {
	const salt = generateSalt();
	settings.passwordSalt = salt;
	if (settings.passwordEncrypted) {
		settings.passwordVerifier = await createEncryptedVerifier(password, salt);
		settings.passwordHash = "";
	} else {
		settings.passwordHash = await hashPassword(password, salt);
		settings.passwordVerifier = "";
	}
}

function clampSeconds(value: unknown): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(n, 24 * 60 * 60);
}


const SECURITY_KEY_INTRO =
	"Unlock with a hardware security key (YubiKey or similar) over WebAuthn. Register a key " +
	'here, then a "Use security key" button appears on the lock screen. Only keys registered ' +
	"here can unlock the vault.";

const PASSWORD_FALLBACK_INTRO =
	"Strongly recommended. Without a fallback, a Touch ID failure (sensor covered, hand injury, " +
	"external display, helper not built) leaves you unable to unlock the vault from within Obsidian.";

const PASSWORD_ENCRYPTION_DESC =
	"Store an AES-256-GCM encrypted verifier instead of a password hash. The encryption key " +
	"is derived from your password on this device and is never written anywhere, so " +
	"data.json holds only ciphertext. Works the same on macOS and Windows.";

const PER_NOTE_INTRO =
	"Cover individual notes with an unlock prompt. Add the property below to a note's " +
	"frontmatter (or use the \"Toggle fingerprint lock for this note\" command) and it stays " +
	"covered until you authenticate. Unlocked notes re-lock when the vault locks.";

const PER_NOTE_CAVEAT =
	"This hides notes in Obsidian's interface — it does not encrypt them. The text remains " +
	"readable on disk, to other plugins, and to sync clients, and note titles still appear in " +
	"search and Quick Switcher. Use it to keep notes from being read over your shoulder, not to " +
	"protect them from someone with access to the files.";

const TOUCH_ID_HELPER_INFO =
	"This plugin shells out to a small, signed helper binary at native/Obsidian inside the " +
	"plugin folder, which calls macOS's LocalAuthentication framework. The plugin builds and " +
	"signs it for you on first load. Your fingerprint data never leaves the Secure Enclave and " +
	"is never seen by this plugin or Obsidian.";

const WINDOWS_HELLO_HELPER_INFO =
	"This plugin runs a small PowerShell script at native/WindowsHelloAuth.ps1 inside the " +
	"plugin folder, which asks Windows Hello (fingerprint, face, or PIN) to verify you. " +
	"The plugin installs it for you on first load — there is nothing to build. Your biometric " +
	"data never leaves Windows and is never seen by this plugin or Obsidian.";

/**
 * Marks a button as destructive. setDestructive() replaced the deprecated
 * setWarning() in newer Obsidian builds; support both so the plugin still
 * renders correctly on the older versions it declares support for.
 */
function markDestructive(button: ButtonComponent): void {
	const candidate = button as Partial<ButtonComponent>;
	if (typeof candidate.setDestructive === "function") {
		candidate.setDestructive();
		return;
	}
	button.setWarning();
}

export class TouchIDLockSettingTab extends PluginSettingTab {
	plugin: TouchIDLockPlugin;
	private pendingPassword = "";

	constructor(app: App, plugin: TouchIDLockPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Obsidian 1.13 introduced the declarative settings API (getSettingDefinitions
	 * plus the renderer that consumes it, and update() to re-render). Older builds
	 * have neither, so the tab must draw itself the old way there.
	 */
	private get supportsDeclarativeSettings(): boolean {
		return typeof (this as { update?: unknown }).update === "function";
	}

	override display(): void {
		if (this.supportsDeclarativeSettings) {
			// 1.13+: the base class renders from getSettingDefinitions().
			super.display();
			return;
		}
		this.displayLegacy();
	}

	/** Re-render, whichever rendering path this Obsidian version is using. */
	private refresh(): void {
		if (this.supportsDeclarativeSettings) {
			this.update();
			return;
		}
		this.displayLegacy();
	}

	override getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof TouchIDLockSettings];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key) {
			case "lockOnStartup":
			case "lockOnBlur":
			case "lockOnIdle":
				settings[key] = value === true;
				break;
			case "lockOnBlurDelaySeconds":
			case "lockOnIdleDelaySeconds":
				settings[key] = clampSeconds(value);
				break;
			case "touchIdReason":
				settings.touchIdReason = String(value ?? "").trim() || DEFAULT_SETTINGS.touchIdReason;
				break;
			case "passwordFallbackEnabled":
				if (value === true && !hasFallbackPassword(settings)) {
					new Notice("Set a password below before turning this on.");
					this.refresh();
					return;
				}
				settings.passwordFallbackEnabled = value === true;
				break;
			case "passwordEncrypted":
				settings.passwordEncrypted = value === true;
				if (hasFallbackPassword(settings)) {
					// An existing password can't be converted without knowing it.
					new Notice("Re-enter and save your password below to apply the new storage mode.");
				}
				break;
			case "perNoteLockEnabled":
				settings.perNoteLockEnabled = value === true;
				break;
			case "lockedNoteProperty":
				settings.lockedNoteProperty =
					String(value ?? "").trim() || DEFAULT_SETTINGS.lockedNoteProperty;
				break;
			case "securityKeyEnabled":
				if (value === true && settings.securityKeys.length === 0) {
					new Notice("Register a security key below before turning this on.");
					this.refresh();
					return;
				}
				settings.securityKeyEnabled = value === true;
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (key === "perNoteLockEnabled" || key === "lockedNoteProperty") {
			this.plugin.refreshNoteGuard();
		}
		if (key === "lockOnBlur") this.plugin.resetBlurWatcher();
		if (key === "lockOnIdle" || key === "lockOnIdleDelaySeconds") this.plugin.resetIdleWatcher();
		if (key === "lockOnBlur" || key === "lockOnIdle") this.refresh();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const method = getBiometricMethodName();
		const items: SettingDefinitionItem[] = [
			{
				name: "",
				desc:
					"This is a screen lock, not encryption — your notes are never modified or encrypted on " +
					`disk. It hides the Obsidian interface and requires ${method} (or a security key or fallback ` +
					"password) to see it again.",
				searchable: false,
			},
			{
				name: "Lock on startup",
				desc: "Show the lock screen immediately whenever Obsidian opens this vault.",
				control: { type: "toggle", key: "lockOnStartup", defaultValue: DEFAULT_SETTINGS.lockOnStartup },
			},
			{
				name: "Lock when Obsidian loses focus",
				desc: "Lock after the app has been in the background for the delay below.",
				control: { type: "toggle", key: "lockOnBlur", defaultValue: DEFAULT_SETTINGS.lockOnBlur },
			},
			{
				name: "Lock-on-blur delay (seconds)",
				desc: "How long Obsidian can sit unfocused before it locks. 0 locks instantly.",
				visible: () => this.plugin.settings.lockOnBlur,
				control: {
					type: "number",
					key: "lockOnBlurDelaySeconds",
					min: 0,
					max: 24 * 60 * 60,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.lockOnBlurDelaySeconds,
				},
			},
			{
				name: "Lock after inactivity",
				desc: "Lock automatically if there's no mouse or keyboard activity for a while.",
				control: { type: "toggle", key: "lockOnIdle", defaultValue: DEFAULT_SETTINGS.lockOnIdle },
			},
			{
				name: "Idle delay (seconds)",
				desc: "How long the vault can sit idle before it locks.",
				visible: () => this.plugin.settings.lockOnIdle,
				control: {
					type: "number",
					key: "lockOnIdleDelaySeconds",
					min: 0,
					max: 24 * 60 * 60,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.lockOnIdleDelaySeconds,
				},
			},
		];

		if (isBiometricPlatformSupported()) {
			items.push(
				{
					name: `${method} prompt reason`,
					desc: `Shown inside the ${method} dialog, e.g. "unlock your Obsidian vault".`,
					control: { type: "text", key: "touchIdReason", placeholder: DEFAULT_SETTINGS.touchIdReason },
				},
				{
					name: `Install ${method} helper`,
					desc: this.helperSetupDescription(),
					render: (setting: Setting) => this.renderHelperSetup(setting, method),
				},
				{
					name: `Test ${method}`,
					desc: `Trigger the ${method} prompt right now, without locking the vault, to confirm setup works.`,
					render: (setting: Setting) => this.renderBiometricTest(setting, method),
				}
			);
		}

		items.push(
			...this.securityKeyItems(),
			this.perNoteGroup(),
			this.passwordGroup(),
			...this.helperInfoItems()
		);
		return items;
	}

	private helperSetupDescription(): string {
		return getBiometricPlatform() === "touchid"
			? "The helper is built automatically when the plugin first loads. Rebuild it here if Touch ID stops working, or after installing the Xcode Command Line Tools."
			: "The helper script is installed automatically when the plugin first loads. Reinstall it here if Windows Hello stops working.";
	}

	private renderHelperSetup(setting: Setting, method: string): void {
		const isMac = getBiometricPlatform() === "touchid";
		const label = isMac ? "Rebuild helper" : "Reinstall helper";
		setting.addButton((b) =>
			b.setButtonText(label).onClick(async () => {
				b.setDisabled(true);
				b.setButtonText(isMac ? "Building…" : "Installing…");
				const result = await this.plugin.setUpNativeHelper({ force: true });
				b.setDisabled(false);
				b.setButtonText(label);
				if (result.status === "ready") {
					new Notice(`${method} helper is ready.`);
				} else {
					new Notice(result.message, 10000);
				}
				this.refresh();
			})
		);
	}

	private renderBiometricTest(setting: Setting, method: string): void {
		setting.addButton((b) =>
			b.setButtonText("Run test").onClick(async () => {
				b.setDisabled(true);
				b.setButtonText(`Waiting for ${method}…`);
				const result = await this.plugin.runBiometricAuth();
				b.setDisabled(false);
				b.setButtonText("Run test");
				if (result.status === "success") {
					new Notice(`${method} succeeded.`);
				} else if (result.status === "not-installed") {
					new Notice(
						getBiometricPlatform() === "windows-hello"
							? "Helper script native/WindowsHelloAuth.ps1 not found — reinstall the plugin."
							: "Native helper not found. Build it with native/build.sh — see the plugin README.",
						8000
					);
				} else if (result.status === "unavailable") {
					new Notice(`${method} unavailable: ${result.message}`, 8000);
				} else {
					new Notice(`${method} failed: ${result.message}`, 8000);
				}
			})
		);
	}

	private perNoteGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Per-note lock",
			items: [
				{ name: "", desc: PER_NOTE_INTRO, searchable: false },
				{ name: "", desc: PER_NOTE_CAVEAT, searchable: false },
				{
					name: "Lock individual notes",
					desc: "Cover flagged notes until you authenticate.",
					control: { type: "toggle", key: "perNoteLockEnabled", defaultValue: false },
				},
				{
					name: "Frontmatter property",
					desc: 'The property that marks a note as locked, e.g. "fingerprint-lock: true".',
					visible: () => this.plugin.settings.perNoteLockEnabled,
					control: {
						type: "text",
						key: "lockedNoteProperty",
						placeholder: DEFAULT_SETTINGS.lockedNoteProperty,
					},
				},
			],
		};
	}

	private passwordGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Password fallback",
			items: [
				{
					name: "",
					desc: PASSWORD_FALLBACK_INTRO,
					searchable: false,
				},
				{
					name: "Enable password fallback",
					desc: "Show a password field on the lock screen alongside the Touch ID button.",
					control: { type: "toggle", key: "passwordFallbackEnabled", defaultValue: false },
				},
				{
					name: "Encrypt password data (end-to-end)",
					desc: PASSWORD_ENCRYPTION_DESC,
					control: { type: "toggle", key: "passwordEncrypted", defaultValue: false },
				},
				{
					name: "Set password",
					desc: "Stored as a salted PBKDF2 hash — or only as ciphertext with encryption enabled above. Never in plain text.",
					aliases: ["Change password"],
					render: (setting: Setting) => this.renderSetPassword(setting),
				},
				{
					name: "Clear password",
					desc: "Removes the saved password and disables the fallback.",
					visible: () => hasFallbackPassword(this.plugin.settings),
					render: (setting: Setting) => this.renderClearPassword(setting),
				},
			],
		};
	}

	private renderSetPassword(setting: Setting): void {
		if (hasFallbackPassword(this.plugin.settings)) {
			setting.setName("Change password");
		}
		setting
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("New password (min. 4 characters)");
				t.onChange((v) => (this.pendingPassword = v));
			})
			.addButton((b) =>
				b.setButtonText("Save").onClick(async () => {
					if (this.pendingPassword.length < 4) {
						new Notice("Password must be at least 4 characters.");
						return;
					}
					await storeFallbackPassword(this.plugin.settings, this.pendingPassword);
					this.pendingPassword = "";
					await this.plugin.saveSettings();
					new Notice("Password saved.");
					this.refresh();
				})
			);
	}

	private renderClearPassword(setting: Setting): void {
		setting.addButton((b) => {
			markDestructive(b);
			b
				.setButtonText("Clear")
				.onClick(async () => {
					const settings = this.plugin.settings;
					settings.passwordSalt = "";
					settings.passwordHash = "";
					settings.passwordVerifier = "";
					settings.passwordFallbackEnabled = false;
					await this.plugin.saveSettings();
					new Notice("Password cleared.");
					this.refresh();
				});
		});
	}

	private securityKeyItems(): SettingDefinitionItem[] {
		const intro: SettingDefinitionItem = {
			name: "",
			desc:
				"Unlock with a hardware security key (YubiKey or similar) over WebAuthn. Register a key " +
				'here, then a "Use security key" button appears on the lock screen. Only keys registered ' +
				"here can unlock the vault.",
			searchable: false,
		};

		if (!isWebAuthnAvailable()) {
			return [
				{
					type: "group",
					heading: "Security keys",
					items: [
						intro,
						{
							name: "",
							desc: "WebAuthn is not available in this Obsidian build, so security keys can't be used here.",
							searchable: false,
						},
					],
				},
			];
		}

		return [
			{
				type: "group",
				heading: "Security keys",
				items: [
					intro,
					{
						name: "Unlock with a security key",
						desc: "Show a security key button on the lock screen.",
						control: { type: "toggle", key: "securityKeyEnabled", defaultValue: false },
					},
					{
						name: "Register a security key",
						desc: "Insert your key, click Register, then touch the key when prompted.",
						render: (setting: Setting) => this.renderRegisterKey(setting),
					},
				],
			},
			{
				type: "list",
				emptyState: "No security keys registered yet.",
				items: this.plugin.settings.securityKeys.map(
					(key): SettingGroupItem => ({
						name: key.label,
						desc: `Registered ${new Date(key.createdAt).toLocaleDateString()}`,
					})
				),
				onDelete: (index: number) => void this.removeSecurityKey(index),
			},
		];
	}

	private renderRegisterKey(setting: Setting): void {
		setting.addButton((b) =>
			b.setButtonText("Register").onClick(async () => {
				b.setDisabled(true);
				b.setButtonText("Touch your key…");
				const result = await registerSecurityKey(this.plugin.settings.securityKeys);
				b.setDisabled(false);
				b.setButtonText("Register");
				if (result.status === "registered") {
					this.plugin.settings.securityKeys.push({
						id: result.id,
						label: `Security key ${this.plugin.settings.securityKeys.length + 1}`,
						createdAt: Date.now(),
					});
					await this.plugin.saveSettings();
					new Notice("Security key registered.");
					this.refresh();
				} else if (result.status === "unavailable") {
					new Notice(`Can't register: ${result.message}`, 8000);
				} else {
					new Notice(`Registration failed: ${result.message}`, 8000);
				}
			})
		);
	}

	private async removeSecurityKey(index: number): Promise<void> {
		const settings = this.plugin.settings;
		settings.securityKeys.splice(index, 1);
		if (settings.securityKeys.length === 0) {
			settings.securityKeyEnabled = false;
		}
		await this.plugin.saveSettings();
		new Notice("Security key removed.");
		this.refresh();
	}

	private helperInfoItems(): SettingDefinitionItem[] {
		if (getBiometricPlatform() === "touchid") {
			return [
				{
					type: "group",
					heading: "Native Touch ID helper",
					items: [
						{
							name: "",
						desc: TOUCH_ID_HELPER_INFO,
							searchable: false,
						},
					],
				},
			];
		}
		if (getBiometricPlatform() === "windows-hello") {
			return [
				{
					type: "group",
					heading: "Windows Hello helper",
					items: [
						{
							name: "",
						desc: WINDOWS_HELLO_HELPER_INFO,
							searchable: false,
						},
					],
				},
			];
		}
		return [];
	}

	/**
	 * Imperative rendering for Obsidian builds older than 1.13, which have no
	 * declarative settings renderer. Mirrors getSettingDefinitions() and shares
	 * the same action handlers, so the two paths can't drift apart.
	 */
	private displayLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();

		const method = getBiometricMethodName();
		const settings = this.plugin.settings;

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"This is a screen lock, not encryption — your notes are never modified or encrypted on " +
				`disk. It hides the Obsidian interface and requires ${method} (or a security key or fallback ` +
				"password) to see it again.",
		});

		new Setting(containerEl)
			.setName("Lock on startup")
			.setDesc("Show the lock screen immediately whenever Obsidian opens this vault.")
			.addToggle((t) =>
				t.setValue(settings.lockOnStartup).onChange((v) => void this.setControlValue("lockOnStartup", v))
			);

		new Setting(containerEl)
			.setName("Lock when Obsidian loses focus")
			.setDesc("Lock after the app has been in the background for the delay below.")
			.addToggle((t) =>
				t.setValue(settings.lockOnBlur).onChange((v) => void this.setControlValue("lockOnBlur", v))
			);

		if (settings.lockOnBlur) {
			new Setting(containerEl)
				.setName("Lock-on-blur delay (seconds)")
				.setDesc("How long Obsidian can sit unfocused before it locks. 0 locks instantly.")
				.addText((t) =>
					t
						.setValue(String(settings.lockOnBlurDelaySeconds))
						.onChange((v) => void this.setControlValue("lockOnBlurDelaySeconds", v))
				);
		}

		new Setting(containerEl)
			.setName("Lock after inactivity")
			.setDesc("Lock automatically if there's no mouse or keyboard activity for a while.")
			.addToggle((t) =>
				t.setValue(settings.lockOnIdle).onChange((v) => void this.setControlValue("lockOnIdle", v))
			);

		if (settings.lockOnIdle) {
			new Setting(containerEl)
				.setName("Idle delay (seconds)")
				.setDesc("How long the vault can sit idle before it locks.")
				.addText((t) =>
					t
						.setValue(String(settings.lockOnIdleDelaySeconds))
						.onChange((v) => void this.setControlValue("lockOnIdleDelaySeconds", v))
				);
		}

		if (isBiometricPlatformSupported()) {
			new Setting(containerEl)
				.setName(`${method} prompt reason`)
				.setDesc(`Shown inside the ${method} dialog, e.g. "unlock your Obsidian vault".`)
				.addText((t) =>
					t
						.setValue(settings.touchIdReason)
						.onChange((v) => void this.setControlValue("touchIdReason", v))
				);

			this.renderHelperSetup(
				new Setting(containerEl)
					.setName(`Install ${method} helper`)
					.setDesc(this.helperSetupDescription()),
				method
			);

			this.renderBiometricTest(
				new Setting(containerEl)
					.setName(`Test ${method}`)
					.setDesc(
						`Trigger the ${method} prompt right now, without locking the vault, to confirm setup works.`
					),
				method
			);
		}

		this.displayLegacySecurityKeys(containerEl);
		this.displayLegacyPerNote(containerEl);
		this.displayLegacyPassword(containerEl);
		this.displayLegacyHelperInfo(containerEl);
	}

	private displayLegacySecurityKeys(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Security keys").setHeading();
		containerEl.createEl("p", { cls: "setting-item-description", text: SECURITY_KEY_INTRO });

		if (!isWebAuthnAvailable()) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "WebAuthn is not available in this Obsidian build, so security keys can't be used here.",
			});
			return;
		}

		new Setting(containerEl)
			.setName("Unlock with a security key")
			.setDesc("Show a security key button on the lock screen.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.securityKeyEnabled)
					.onChange((v) => void this.setControlValue("securityKeyEnabled", v))
			);

		this.renderRegisterKey(
			new Setting(containerEl)
				.setName("Register a security key")
				.setDesc("Insert your key, click Register, then touch the key when prompted.")
		);

		this.plugin.settings.securityKeys.forEach((key, index) => {
			new Setting(containerEl)
				.setName(key.label)
				.setDesc(`Registered ${new Date(key.createdAt).toLocaleDateString()}`)
				.addButton((b) => {
					markDestructive(b);
					b.setButtonText("Remove").onClick(() => void this.removeSecurityKey(index));
				});
		});
	}

	private displayLegacyPerNote(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Per-note lock").setHeading();
		containerEl.createEl("p", { cls: "setting-item-description", text: PER_NOTE_INTRO });
		containerEl.createEl("p", { cls: "setting-item-description", text: PER_NOTE_CAVEAT });

		new Setting(containerEl)
			.setName("Lock individual notes")
			.setDesc("Cover flagged notes until you authenticate.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.perNoteLockEnabled)
					.onChange((v) => void this.setControlValue("perNoteLockEnabled", v))
			);

		if (this.plugin.settings.perNoteLockEnabled) {
			new Setting(containerEl)
				.setName("Frontmatter property")
				.setDesc('The property that marks a note as locked, e.g. "fingerprint-lock: true".')
				.addText((t) =>
					t
						.setValue(this.plugin.settings.lockedNoteProperty)
						.onChange((v) => void this.setControlValue("lockedNoteProperty", v))
				);
		}
	}

	private displayLegacyPassword(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Password fallback").setHeading();
		containerEl.createEl("p", { cls: "setting-item-description", text: PASSWORD_FALLBACK_INTRO });

		new Setting(containerEl)
			.setName("Enable password fallback")
			.setDesc("Show a password field on the lock screen alongside the Touch ID button.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.passwordFallbackEnabled)
					.onChange((v) => void this.setControlValue("passwordFallbackEnabled", v))
			);

		new Setting(containerEl)
			.setName("Encrypt password data (end-to-end)")
			.setDesc(PASSWORD_ENCRYPTION_DESC)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.passwordEncrypted)
					.onChange((v) => void this.setControlValue("passwordEncrypted", v))
			);

		this.renderSetPassword(
			new Setting(containerEl)
				.setName("Set password")
				.setDesc(
					"Stored as a salted PBKDF2 hash — or only as ciphertext with encryption enabled above. Never in plain text."
				)
		);

		if (hasFallbackPassword(this.plugin.settings)) {
			this.renderClearPassword(
				new Setting(containerEl)
					.setName("Clear password")
					.setDesc("Removes the saved password and disables the fallback.")
			);
		}
	}

	private displayLegacyHelperInfo(containerEl: HTMLElement): void {
		const platform = getBiometricPlatform();
		if (platform === "touchid") {
			new Setting(containerEl).setName("Native Touch ID helper").setHeading();
			containerEl.createEl("p", { cls: "setting-item-description", text: TOUCH_ID_HELPER_INFO });
		} else if (platform === "windows-hello") {
			new Setting(containerEl).setName("Windows Hello helper").setHeading();
			containerEl.createEl("p", { cls: "setting-item-description", text: WINDOWS_HELLO_HELPER_INFO });
		}
	}
}
