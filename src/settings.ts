import {
	App,
	Notice,
	PluginSettingTab,
	type Setting,
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

export class TouchIDLockSettingTab extends PluginSettingTab {
	plugin: TouchIDLockPlugin;
	private pendingPassword = "";

	constructor(app: App, plugin: TouchIDLockPlugin) {
		super(app, plugin);
		this.plugin = plugin;
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
					this.update();
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
			case "securityKeyEnabled":
				if (value === true && settings.securityKeys.length === 0) {
					new Notice("Register a security key below before turning this on.");
					this.update();
					return;
				}
				settings.securityKeyEnabled = value === true;
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (key === "lockOnBlur") this.plugin.resetBlurWatcher();
		if (key === "lockOnIdle" || key === "lockOnIdleDelaySeconds") this.plugin.resetIdleWatcher();
		if (key === "lockOnBlur" || key === "lockOnIdle") this.update();
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
					desc:
						getBiometricPlatform() === "touchid"
							? "The helper is built automatically when the plugin first loads. Rebuild it here if Touch ID stops working, or after installing the Xcode Command Line Tools."
							: "The helper script is installed automatically when the plugin first loads. Reinstall it here if Windows Hello stops working.",
					render: (setting: Setting) => this.renderHelperSetup(setting, method),
				},
				{
					name: `Test ${method}`,
					desc: `Trigger the ${method} prompt right now, without locking the vault, to confirm setup works.`,
					render: (setting: Setting) => this.renderBiometricTest(setting, method),
				}
			);
		}

		items.push(...this.securityKeyItems(), this.passwordGroup(), ...this.helperInfoItems());
		return items;
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
				this.update();
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

	private passwordGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Password fallback",
			items: [
				{
					name: "",
					desc:
						"Strongly recommended. Without a fallback, a Touch ID failure (sensor covered, hand injury, " +
						"external display, helper not built) leaves you unable to unlock the vault from within Obsidian.",
					searchable: false,
				},
				{
					name: "Enable password fallback",
					desc: "Show a password field on the lock screen alongside the Touch ID button.",
					control: { type: "toggle", key: "passwordFallbackEnabled", defaultValue: false },
				},
				{
					name: "Encrypt password data (end-to-end)",
					desc:
						"Store an AES-256-GCM encrypted verifier instead of a password hash. The encryption key " +
						"is derived from your password on this device and is never written anywhere, so " +
						"data.json holds only ciphertext. Works the same on macOS and Windows.",
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
					this.update();
				})
			);
	}

	private renderClearPassword(setting: Setting): void {
		setting.addButton((b) =>
			b
				.setDestructive()
				.setButtonText("Clear")
				.onClick(async () => {
					const settings = this.plugin.settings;
					settings.passwordSalt = "";
					settings.passwordHash = "";
					settings.passwordVerifier = "";
					settings.passwordFallbackEnabled = false;
					await this.plugin.saveSettings();
					new Notice("Password cleared.");
					this.update();
				})
		);
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
					this.update();
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
		this.update();
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
							desc:
								"This plugin shells out to a small, signed helper binary at native/Obsidian inside the " +
								"plugin folder, which calls macOS's LocalAuthentication framework. Build it once by running " +
								"native/build.sh in Terminal — see the README included with this plugin. Your fingerprint " +
								"data never leaves the Secure Enclave and is never seen by this plugin or Obsidian.",
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
							desc:
								"This plugin runs a small PowerShell script at native/WindowsHelloAuth.ps1 inside the " +
								"plugin folder, which asks Windows Hello (fingerprint, face, or PIN) to verify you. " +
								"There is nothing to build or install — it works out of the box. Your biometric data " +
								"never leaves Windows and is never seen by this plugin or Obsidian.",
							searchable: false,
						},
					],
				},
			];
		}
		return [];
	}
}
